import { create } from "zustand";
import type { ProjectTree, Session } from "@/lib/backend";
import {
  applyMove,
  computeLayout,
  detachTab,
  extractPayload,
  findPane,
  insertBeside,
  neighbor,
  newPane,
  paneOfTab,
  panesOf,
  placeNewPane,
  dropIfEmpty,
  removePane,
  sanitize,
  setSplitSizes,
  tabsOf,
  uid,
  updatePane,
  type Direction,
  type DropTarget,
  type LayoutNode,
  type Payload,
  type Side,
  type Tab,
  type ContentKind,
  type TabKind,
} from "@/lib/layout-tree";
import { projectLastUsed } from "@/lib/session-state";
import { storage } from "@/lib/storage";
import { ProjectService } from "@/lib/backend";
import { findSession, useApp } from "./app-store";
import { useLayout } from "./layout-store";
import { useSettings } from "./settings-store";

const KEY = "harness.groups";
/** Older versions saved groups under this key as `windows`. */
const LEGACY_KEY = "harness.windows";
/** Written by versions before groups; used once to pick the initial group after migrating. */
const LEGACY_ACTIVE_KEY = "harness.activeSession";
const SAVE_DELAY_MS = 250;
/** Space between windows. */
export const GAP = 0;
/** Smallest a window may get: new windows and splits that would go below this are refused. */
export const MIN_WINDOW = { width: 160, height: 110 };
/** Assumed group size before it has been laid out on screen. */
const DEFAULT_VIEWPORT = { width: 1200, height: 800 };

/** A group: a tiled layout of windows, listed in the sidebar under its workspace. */
export type Group = {
  id: string;
  projectId: string;
  /** Set when renamed; otherwise the title comes from its first chat. */
  title?: string;
  createdAt: number;
  root: LayoutNode;
  /** The window that last had focus; new tabs open there. */
  focused: string | null;
  /** A window shown alone, filling the group. */
  maximized: string | null;
  /** Windows focused before the current one, oldest first; focus returns to them on close. */
  history?: string[];
  /**
   * The Claude Code worktree (.claude/worktrees/<name>) the group works in; unset = the
   * workspace folder. New chats, terminals, files and changes all use it.
   */
  worktree?: string;
};

type Saved = { groups: Group[]; activeId: string | null };

function load(): Saved | null {
  try {
    const raw = storage.get(KEY) ?? storage.get(LEGACY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { groups?: Group[]; windows?: Group[]; activeId?: string | null };
    const list = data.groups ?? data.windows ?? [];
    const groups = (Array.isArray(list) ? list : [])
      .filter((g) => g && g.id && g.projectId && g.root)
      .map((g) => fixFocus({ ...g, root: sanitize(g.root), createdAt: g.createdAt || Date.now() }));
    return { groups, activeId: data.activeId ?? null };
  } catch {
    return null;
  }
}

const HISTORY_LIMIT = 20;

/**
 * Keeps `focused` and `maximized` pointing at windows that still exist. When the focused
 * window is gone, focus goes back to the window focused before it.
 */
function fixFocus(g: Group): Group {
  const exists = (id: string | null | undefined) => !!id && !!findPane(g.root, id);
  const history = (g.history ?? []).filter(exists);
  let focused = g.focused;
  if (!exists(focused)) focused = history.pop() ?? panesOf(g.root)[0]?.id ?? null;
  const maximized = exists(g.maximized) ? g.maximized : null;
  const same =
    focused === g.focused && maximized === g.maximized && history.length === (g.history ?? []).length;
  return same ? g : { ...g, focused, maximized, history };
}

/** Records the previously focused window when focus moves. */
function trackFocus(before: Group, after: Group): Group {
  if (after.focused === before.focused || !before.focused) return after;
  const prev = before.focused;
  const history = [...(after.history ?? []).filter((id) => id !== prev && id !== after.focused), prev];
  return { ...after, history: history.slice(-HISTORY_LIMIT) };
}

function makeGroup(projectId: string, tabs: Tab[], createdAt = Date.now(), worktree?: string): Group {
  const pane = newPane(tabs);
  return { id: uid("group"), projectId, createdAt, root: pane, focused: pane.id, maximized: null, worktree: worktree || undefined };
}

/** Creates a tab; with no kind (or "new"), a placeholder showing the numbered choices. */
async function createTab(kind: TabKind | undefined, projectId: string, worktree?: string): Promise<Tab> {
  if (!kind || kind === "new") return { id: uid("tab"), kind: "new" };
  if (kind === "terminal") {
    const { tree, system } = useApp.getState();
    const project = tree.find((n) => n.project.id === projectId)?.project;
    return { id: uid("tab"), kind, admin: !!project && canElevate(project, system.os) && project.adminTerminals };
  }
  if (kind === "chat") {
    const session = await useApp.getState().newSession(projectId, worktree);
    return { id: uid("tab"), kind, sessionId: session.id };
  }
  return { id: uid("tab"), kind };
}

/** Whether terminals of a workspace can run as administrator (Windows folders only). */
export function canElevate(project: { env: string }, os: string): boolean {
  return os === "windows" && project.env !== "wsl";
}

/** Chats closed before anything was sent leave no history behind. */
function discardIfEmpty(tab: Tab | undefined) {
  if (tab?.kind !== "chat" || !tab.sessionId) return;
  const { messages, deleteSession } = useApp.getState();
  if (messages[tab.sessionId]?.length === 0) void deleteSession(tab.sessionId);
}

/** Most recent of the group's creation and its chats' activity. */
export function groupActivity(g: Group, tree: ProjectTree[]): number {
  let t = g.createdAt;
  for (const tab of tabsOf(g.root)) {
    const s = tab.sessionId ? findSession(tree, tab.sessionId) : undefined;
    if (s && s.updatedAt > t) t = s.updatedAt;
  }
  return t;
}

/** Workspaces most recently used first, each with its groups most recently used first (sidebar order). */
export function sidebarOrder(tree: ProjectTree[], groups: Group[]) {
  return [...tree]
    .sort((a, b) => projectLastUsed(b) - projectLastUsed(a))
    .map((node) => ({
      node,
      groups: groups
        .filter((g) => g.projectId === node.project.id)
        .sort((a, b) => groupActivity(b, tree) - groupActivity(a, tree)),
    }));
}

type GroupState = {
  groups: Group[];
  activeId: string | null;
  /** False until the first sync with the project tree (nothing is saved before that). */
  synced: boolean;
  /** Each group's on-screen size, for best-fit splitting and moving focus by direction. */
  viewports: Record<string, { width: number; height: number }>;
  /** Bumped when the keyboard moves focus, so the focused window takes keyboard input. */
  focusNonce: number;

  /** Reconciles with the backend: migrates sessions on first run, drops what was deleted. */
  sync: (tree: ProjectTree[]) => void;
  setViewport: (groupId: string, width: number, height: number) => void;

  activate: (groupId: string) => void;
  /** Shows a group and, if given, brings one of its tabs to the front. */
  reveal: (groupId: string, tabId?: string) => void;
  /** A new group with one window: showing a tab of `kind`, or empty (to pick 1–5). */
  newGroup: (projectId: string, kind?: TabKind, worktree?: string) => Promise<void>;
  /**
   * Moves a group into a worktree (or back to the workspace folder). Its chats that haven't
   * started move along; started ones and open terminals stay where they began.
   */
  setWorktree: (groupId: string, worktree: string | undefined) => Promise<void>;
  closeGroup: (groupId: string) => void;
  renameGroup: (groupId: string, title: string) => void;
  /** Opens a chat: its existing tab if any, else a new group for it. */
  openChat: (session: Session) => void;
  goToGroup: (index: number) => void;
  cycleGroup: (delta: number) => void;

  focusPane: (groupId: string, paneId: string) => void;
  selectTab: (groupId: string, tabId: string) => void;
  cycleTab: (delta: number) => void;
  /** Adds a tab to a window: of `kind`, or a "New tab" placeholder. */
  addTab: (groupId: string, paneId: string, kind?: TabKind) => Promise<void>;
  /** Turns a "New tab" placeholder (or an empty window) into a tab of the chosen kind. */
  fillTab: (groupId: string, paneId: string, kind: ContentKind) => Promise<void>;
  closeTab: (groupId: string, tabId: string) => void;
  closePane: (groupId: string, paneId: string) => void;
  /** Opens a new window in the active group, placed by the split strategy; empty unless `kind` is given. */
  openWindow: (kind?: TabKind) => Promise<void>;
  /** Opens a new window beside `paneId` (with a tab of `kind`, or empty). */
  split: (groupId: string, paneId: string, side: Side, kind?: TabKind) => Promise<void>;
  toggleMaximize: (groupId: string, paneId: string) => void;
  setSizes: (groupId: string, splitId: string, sizes: number[]) => void;
  setTabUrl: (groupId: string, tabId: string, url: string) => void;
  /** Starts a terminal tab's shell again, as administrator or not. */
  restartTerminal: (groupId: string, tabId: string, admin: boolean) => void;

  /** Moves focus to the window in a direction (active group). */
  focusDirection: (dir: Direction) => void;
  /** Moves the focused tab to the window in a direction, or splits off on that side. */
  moveDirection: (dir: Direction) => void;
  /** Drops a dragged tab or window somewhere in the same group. */
  drop: (groupId: string, payload: Payload, target: DropTarget, newPaneId: string) => void;
  /** Moves a tab or window into another group of the same workspace (placed by best fit). */
  moveToGroup: (fromId: string, payload: Payload, toId: string) => void;
  /** Moves a tab or window out into a new group. */
  moveToNewGroup: (fromId: string, payload: Payload) => void;
};

export const useGroups = create<GroupState>((set, get) => {
  const edit = (groupId: string, fn: (g: Group) => Group) =>
    set({ groups: get().groups.map((g) => (g.id === groupId ? fixFocus(trackFocus(g, fn(g))) : g)) });

  const viewport = (groupId: string) => get().viewports[groupId] ?? DEFAULT_VIEWPORT;

  /** Whether every window of a layout would still be at least MIN_WINDOW in this group. */
  const fits = (groupId: string, root: LayoutNode) => layoutFits(root, viewport(groupId));
  const noRoom = () => useLayout.getState().notify("No room for another window");
  const active = () => get().groups.find((g) => g.id === get().activeId);
  const bumpFocus = () => set({ focusNonce: get().focusNonce + 1 });

  /**
   * Places `tabs` as a new window in a group using the chosen split strategy, splitting from
   * `from` (by default the focused window).
   */
  const placeNew = (g: Group, tabs: Tab[], paneId = uid("pane"), from: string | null = g.focused) => {
    const { width, height } = viewport(g.id);
    return placeNewPane(g.root, newPane(tabs, paneId), {
      strategy: useSettings.getState().splitStrategy,
      width,
      height,
      focused: from,
      gap: GAP,
    });
  };
  /** The last window of a layout: where new windows split from, whichever window has focus. */
  const lastPane = (root: LayoutNode) => panesOf(root).at(-1)?.id ?? null;

  /** Nothing left after moving everything out. */
  const isEmpty = (root: LayoutNode) => tabsOf(root).length === 0;

  const saved = load();

  return {
    groups: saved?.groups ?? [],
    activeId: saved?.activeId ?? null,
    synced: false,
    viewports: {},
    focusNonce: 0,

    sync: (tree) => {
      let { groups, activeId } = get();

      // First run with groups: every existing session becomes a group with its chat.
      if (!get().synced && !saved) {
        groups = tree.flatMap((node) =>
          (node.sessions ?? []).map((s) =>
            makeGroup(node.project.id, [{ id: uid("tab"), kind: "chat", sessionId: s.id }], s.updatedAt, s.worktree),
          ),
        );
        const legacy = storage.get(LEGACY_ACTIVE_KEY);
        activeId = groups.find((g) => tabsOf(g.root).some((t) => t.sessionId === legacy))?.id ?? null;
      }

      // Drop groups of removed workspaces and chat tabs of deleted sessions.
      const projects = new Set(tree.map((n) => n.project.id));
      const sessions = new Set(tree.flatMap((n) => (n.sessions ?? []).map((s) => s.id)));
      groups = groups
        .filter((g) => projects.has(g.projectId))
        .map((g) => {
          const stale = tabsOf(g.root).filter((t) => t.kind === "chat" && !sessions.has(t.sessionId ?? ""));
          if (stale.length === 0) return g;
          let root = g.root;
          for (const t of stale) {
            const d = detachTab(root, t.id);
            root = dropIfEmpty(d.root, d.paneId);
          }
          return fixFocus({ ...g, root });
        });

      if (!groups.some((g) => g.id === activeId)) {
        activeId = [...groups].sort((a, b) => groupActivity(b, tree) - groupActivity(a, tree))[0]?.id ?? null;
      }
      set({ groups, activeId, synced: true });
    },

    setViewport: (groupId, width, height) => {
      const v = get().viewports[groupId];
      if (v?.width !== width || v?.height !== height) set({ viewports: { ...get().viewports, [groupId]: { width, height } } });
    },

    activate: (groupId) => set({ activeId: groupId }),

    reveal: (groupId, tabId) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      set({ activeId: groupId });
      if (tabId) get().selectTab(groupId, tabId);
      bumpFocus();
      // Make sure the group is visible in the sidebar.
      const node = useApp.getState().tree.find((n) => n.project.id === g.projectId);
      if (node && !node.project.expanded) void useApp.getState().toggleProject(g.projectId);
    },

    newGroup: async (projectId, kind, worktree) => {
      const g = makeGroup(projectId, [await createTab(kind, projectId, worktree)], Date.now(), worktree);
      set({ groups: [...get().groups, g] });
      get().reveal(g.id);
    },

    setWorktree: async (groupId, worktree) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g || (g.worktree ?? "") === (worktree ?? "")) return;
      edit(groupId, (x) => ({ ...x, worktree: worktree || undefined }));
      const { tree, refreshTree } = useApp.getState();
      const moving = tabsOf(g.root)
        .map((t) => (t.sessionId ? findSession(tree, t.sessionId) : undefined))
        .filter((s): s is Session => !!s && !s.started);
      if (moving.length === 0) return;
      await Promise.allSettled(moving.map((s) => ProjectService.SetSessionWorktree(s.id, worktree ?? "")));
      await refreshTree();
    },

    closeGroup: (groupId) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      tabsOf(g.root).forEach(discardIfEmpty);
      const groups = get().groups.filter((x) => x.id !== groupId);
      let activeId = get().activeId;
      if (activeId === groupId) {
        // Prefer another group of the same workspace.
        const tree = useApp.getState().tree;
        const next = [...groups].sort(
          (a, b) =>
            Number(b.projectId === g.projectId) - Number(a.projectId === g.projectId) ||
            groupActivity(b, tree) - groupActivity(a, tree),
        )[0];
        activeId = next?.id ?? null;
      }
      set({ groups, activeId });
    },

    renameGroup: (groupId, title) => edit(groupId, (g) => ({ ...g, title })),

    openChat: (session) => {
      for (const g of get().groups) {
        const tab = tabsOf(g.root).find((t) => t.sessionId === session.id);
        if (tab) return get().reveal(g.id, tab.id);
      }
      const g = makeGroup(session.projectId, [{ id: uid("tab"), kind: "chat", sessionId: session.id }], Date.now(), session.worktree);
      set({ groups: [...get().groups, g] });
      get().reveal(g.id);
    },

    goToGroup: (index) => {
      const list = sidebarOrder(useApp.getState().tree, get().groups).flatMap((x) => x.groups);
      const g = list[index];
      if (g) get().reveal(g.id);
    },

    cycleGroup: (delta) => {
      const list = sidebarOrder(useApp.getState().tree, get().groups).flatMap((x) => x.groups);
      if (list.length === 0) return;
      const i = list.findIndex((g) => g.id === get().activeId);
      get().reveal(list[(i + delta + list.length) % list.length].id);
    },

    focusPane: (groupId, paneId) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (g && g.focused !== paneId) edit(groupId, (x) => ({ ...x, focused: paneId }));
    },

    selectTab: (groupId, tabId) =>
      edit(groupId, (g) => {
        const pane = paneOfTab(g.root, tabId);
        if (!pane) return g;
        return {
          ...g,
          root: updatePane(g.root, pane.id, (p) => ({ ...p, active: tabId })),
          focused: pane.id,
          // A tab hidden behind a maximized window is brought back into view.
          maximized: g.maximized && g.maximized !== pane.id ? null : g.maximized,
        };
      }),

    cycleTab: (delta) => {
      const g = active();
      const pane = g && findPane(g.root, g.focused);
      if (!g || !pane || pane.tabs.length < 2) return;
      const i = pane.tabs.findIndex((t) => t.id === pane.active);
      get().selectTab(g.id, pane.tabs[(i + delta + pane.tabs.length) % pane.tabs.length].id);
      bumpFocus();
    },

    addTab: async (groupId, paneId, kind) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      const tab = await createTab(kind, g.projectId, g.worktree);
      edit(groupId, (x) => {
        // The window may have closed while a chat session was being created.
        const target = findPane(x.root, paneId) ? paneId : x.focused;
        if (!target) return x;
        return {
          ...x,
          root: updatePane(x.root, target, (p) => ({ ...p, tabs: [...p.tabs, tab], active: tab.id })),
          focused: target,
        };
      });
      bumpFocus();
    },

    fillTab: async (groupId, paneId, kind) => {
      const g = get().groups.find((x) => x.id === groupId);
      const pane = g && findPane(g.root, paneId);
      if (!g || !pane) return;
      // The placeholder being replaced: the window's front tab if it is one, else none (empty window).
      const placeholder = pane.tabs.find((t) => t.id === pane.active && t.kind === "new");
      if (!placeholder && pane.tabs.length > 0) return;
      const tab = await createTab(kind, g.projectId, g.worktree);
      edit(groupId, (x) => ({
        ...x,
        root: updatePane(x.root, paneId, (p) => ({
          ...p,
          tabs: placeholder ? p.tabs.map((t) => (t.id === placeholder.id ? tab : t)) : [...p.tabs, tab],
          active: tab.id,
        })),
        focused: paneId,
      }));
      bumpFocus();
    },

    closeTab: (groupId, tabId) =>
      edit(groupId, (g) => {
        // Closing a window's last tab closes that window (never other empty ones).
        const { root, tab, paneId } = detachTab(g.root, tabId);
        discardIfEmpty(tab);
        return { ...g, root: dropIfEmpty(root, paneId) };
      }),

    closePane: (groupId, paneId) =>
      edit(groupId, (g) => {
        const pane = findPane(g.root, paneId);
        if (!pane) return g;
        pane.tabs.forEach(discardIfEmpty);
        // The last window stays, emptied, so the group keeps a place to add tabs.
        const root =
          panesOf(g.root).length === 1
            ? updatePane(g.root, paneId, (p) => ({ ...p, tabs: [], active: null }))
            : (removePane(g.root, paneId) ?? g.root);
        return { ...g, root };
      }),

    openWindow: async (kind) => {
      const g = active();
      if (!g) {
        // No group yet: start one in the most recently used workspace.
        const first = sidebarOrder(useApp.getState().tree, get().groups)[0];
        if (first) await get().newGroup(first.node.project.id, kind);
        return;
      }
      // Check for room before creating anything (a chat tab makes a backend session).
      const trial = placeNew(g, [{ id: "trial", kind: kind ?? "new" }], undefined, lastPane(g.root));
      if (!fits(g.id, trial.root)) return noRoom();
      const tabs = [await createTab(kind, g.projectId, g.worktree)];
      edit(g.id, (x) => {
        const { root, focus } = placeNew(x, tabs, undefined, lastPane(x.root));
        return { ...x, root, focused: focus, maximized: null };
      });
      bumpFocus();
    },

    split: async (groupId, paneId, side, kind) => {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      if (!fits(groupId, insertBeside(g.root, paneId, newPane(), side))) return noRoom();
      const tabs = [await createTab(kind, g.projectId, g.worktree)];
      edit(groupId, (x) => {
        if (!findPane(x.root, paneId)) return x;
        const pane = newPane(tabs);
        return { ...x, root: insertBeside(x.root, paneId, pane, side), focused: pane.id, maximized: null };
      });
      bumpFocus();
    },

    toggleMaximize: (groupId, paneId) =>
      edit(groupId, (g) => ({ ...g, maximized: g.maximized === paneId ? null : paneId, focused: paneId })),

    setSizes: (groupId, splitId, sizes) => edit(groupId, (g) => ({ ...g, root: setSplitSizes(g.root, splitId, sizes) })),

    setTabUrl: (groupId, tabId, url) =>
      edit(groupId, (g) => {
        const pane = paneOfTab(g.root, tabId);
        if (!pane) return g;
        return {
          ...g,
          root: updatePane(g.root, pane.id, (p) => ({
            ...p,
            tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, url } : t)),
          })),
        };
      }),

    restartTerminal: (groupId, tabId, admin) =>
      edit(groupId, (g) => {
        const pane = paneOfTab(g.root, tabId);
        if (!pane) return g;
        return {
          ...g,
          root: updatePane(g.root, pane.id, (p) => ({
            ...p,
            tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, admin, restarts: (t.restarts ?? 0) + 1 } : t)),
          })),
        };
      }),

    focusDirection: (dir) => {
      const g = active();
      if (!g?.focused || g.maximized) return;
      const { width, height } = viewport(g.id);
      const { panes } = computeLayout(g.root, { left: 0, top: 0, width, height }, GAP);
      const next = neighbor(panes, g.focused, dir);
      if (next) {
        get().focusPane(g.id, next);
        bumpFocus();
      }
    },

    moveDirection: (dir) => {
      const g = active();
      const pane = g && findPane(g.root, g.focused);
      if (!g || !pane?.active) return;
      const { width, height } = viewport(g.id);
      const { panes } = computeLayout(g.root, { left: 0, top: 0, width, height }, GAP);
      const next = neighbor(panes, pane.id, dir);
      const side: Side = dir === "up" ? "top" : dir === "down" ? "bottom" : dir;
      const target: DropTarget = next ? { kind: "center", paneId: next } : { kind: "edge", paneId: pane.id, side };
      get().drop(g.id, { kind: "tab", tabId: pane.active }, target, uid("pane"));
      bumpFocus();
    },

    drop: (groupId, payload, target, newPaneId) =>
      edit(groupId, (g) => {
        const result = applyMove(g.root, payload, target, newPaneId);
        if (!result) return g;
        if (!fits(groupId, result.root)) {
          noRoom();
          return g;
        }
        return { ...g, root: result.root, focused: result.focus, maximized: null };
      }),

    moveToGroup: (fromId, payload, toId) => {
      const from = get().groups.find((g) => g.id === fromId);
      const to = get().groups.find((g) => g.id === toId);
      if (!from || !to || fromId === toId || from.projectId !== to.projectId) return;
      const { root, tabs } = extractPayload(from.root, payload);
      if (tabs.length === 0) return;
      let placed = placeNew(to, tabs, payload.kind === "pane" ? payload.paneId : uid("pane"));
      // A full group takes the move as tabs in its focused window instead of a new window.
      if (!fits(toId, placed.root)) {
        const target = findPane(to.root, to.focused) ?? panesOf(to.root)[0];
        placed = {
          root: updatePane(to.root, target.id, (p) => ({ ...p, tabs: [...p.tabs, ...tabs], active: tabs[tabs.length - 1].id })),
          focus: target.id,
        };
      }
      set({
        groups: get()
          .groups.filter((g) => !(g.id === fromId && isEmpty(root)))
          .map((g) =>
            g.id === fromId
              ? fixFocus({ ...g, root, maximized: null })
              : g.id === toId
                ? fixFocus({ ...g, root: placed.root, focused: placed.focus, maximized: null })
                : g,
          ),
        activeId: toId,
      });
      bumpFocus();
    },

    moveToNewGroup: (fromId, payload) => {
      const from = get().groups.find((g) => g.id === fromId);
      if (!from) return;
      const { root, tabs } = extractPayload(from.root, payload);
      if (tabs.length === 0) return;
      // Moving out a group's only content just turns it into a new group.
      if (isEmpty(root)) return;
      const group = makeGroup(from.projectId, tabs, Date.now(), from.worktree);
      set({
        groups: [...get().groups.map((g) => (g.id === fromId ? fixFocus({ ...g, root, maximized: null }) : g)), group],
        activeId: group.id,
      });
      bumpFocus();
    },
  };
});

// Save layouts (debounced) once they have been reconciled with the backend.
const persist = () => {
  const { groups, activeId, synced } = useGroups.getState();
  if (synced) storage.set(KEY, JSON.stringify({ groups, activeId } satisfies Saved));
};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useGroups.subscribe((s, prev) => {
  if (!s.synced || (s.groups === prev.groups && s.activeId === prev.activeId)) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, SAVE_DELAY_MS);
});
window.addEventListener("beforeunload", persist);

export function useActiveGroup(): Group | undefined {
  return useGroups((s) => s.groups.find((g) => g.id === s.activeId));
}

export function useActiveProject() {
  const projectId = useActiveGroup()?.projectId;
  return useApp((s) => s.tree.find((n) => n.project.id === projectId)?.project);
}

/** Whether every window of a layout is at least MIN_WINDOW when laid out at `size`. */
export function layoutFits(root: LayoutNode, size: { width: number; height: number }): boolean {
  const { panes } = computeLayout(root, { left: 0, top: 0, ...size }, GAP);
  return Object.values(panes).every((r) => r.width >= MIN_WINDOW.width - 0.5 && r.height >= MIN_WINDOW.height - 0.5);
}

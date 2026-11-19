import { create } from "zustand";
import {
  ChatService,
  Dialogs,
  ProjectService,
  SystemService,
  type Message,
  type ProjectTree,
  type ProviderInfo,
  type Session,
  type SystemInfo,
} from "@/lib/backend";
import { storage } from "@/lib/storage";
import type { AttachmentInput } from "@bindings/harness/internal/services/models";

const ACTIVE_KEY = "harness.activeSession";
const SEEN_KEY = "harness.seen";

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(storage.get(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export type SessionSettings = Pick<Session, "provider" | "model" | "effort" | "mode">;

type AppState = {
  ready: boolean;
  system: SystemInfo;
  providers: ProviderInfo[];
  tree: ProjectTree[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  running: Record<string, boolean>;
  /** When each session was last viewed; newer activity shows as unseen in the sidebar. */
  seen: Record<string, number>;

  init: () => Promise<void>;
  refreshTree: () => Promise<void>;

  addProject: () => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  toggleProject: (id: string) => Promise<void>;

  newSession: (projectId: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  updateSettings: (id: string, patch: Partial<SessionSettings>) => Promise<void>;

  send: (sessionId: string, prompt: string, attachments?: AttachmentInput[]) => Promise<void>;
  stop: (sessionId: string) => void;
  markSeen: (sessionId: string) => void;

  // Backend event handlers
  onMessage: (m: Message) => void;
  onStatus: (sessionId: string, running: boolean) => void;
  onSession: (s: Session) => void;
};

function mapSession(tree: ProjectTree[], id: string, fn: (s: Session) => Session): ProjectTree[] {
  return tree.map((node) => ({
    ...node,
    sessions: (node.sessions ?? []).map((s) => (s.id === id ? fn(s) : s)),
  }));
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  system: { os: "", hasWsl: false },
  providers: [],
  tree: [],
  activeSessionId: null,
  messages: {},
  running: {},
  seen: loadSeen(),

  init: async () => {
    const [system, providers, tree, running] = await Promise.all([
      SystemService.Info(),
      ChatService.Providers(),
      ProjectService.Tree(),
      ChatService.Running(),
    ]);
    set({
      system,
      providers: providers ?? [],
      tree: tree ?? [],
      running: Object.fromEntries((running ?? []).map((id) => [id, true])),
      ready: true,
    });
    // Sessions never tracked before count as seen, so existing history starts quiet.
    const seen = { ...get().seen };
    for (const s of (tree ?? []).flatMap((n) => n.sessions ?? [])) seen[s.id] ??= s.updatedAt;
    set({ seen });
    storage.set(SEEN_KEY, JSON.stringify(seen));
    // Restore the last active session, else open the most recently used one.
    const all = (tree ?? []).flatMap((n) => n.sessions ?? []);
    const saved = all.find((s) => s.id === storage.get(ACTIVE_KEY));
    const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const initial = saved ?? latest;
    if (initial) await get().selectSession(initial.id);
  },

  refreshTree: async () => set({ tree: (await ProjectService.Tree()) ?? [] }),

  addProject: async () => {
    // A runtime call, so the native picker opens in the desktop window (not on the server).
    const path = await Dialogs.OpenFile({
      Title: "Open folder",
      CanChooseDirectories: true,
      CanChooseFiles: false,
      CanCreateDirectories: true,
    });
    if (!path) return;
    const project = await ProjectService.AddProject(path);
    await get().refreshTree();
    await get().newSession(project.id);
  },

  removeProject: async (id) => {
    const node = get().tree.find((n) => n.project.id === id);
    if (node?.sessions?.some((s) => s.id === get().activeSessionId)) await get().selectSession(null);
    await ProjectService.RemoveProject(id);
    await get().refreshTree();
  },

  renameProject: async (id, name) => {
    await ProjectService.RenameProject(id, name);
    await get().refreshTree();
  },

  toggleProject: async (id) => {
    const node = get().tree.find((n) => n.project.id === id);
    if (!node) return;
    const expanded = !node.project.expanded;
    set({
      tree: get().tree.map((n) => (n.project.id === id ? { ...n, project: { ...n.project, expanded } } : n)),
    });
    await ProjectService.SetExpanded(id, expanded);
  },


  newSession: async (projectId) => {
    const session = await ProjectService.CreateSession(projectId);
    await get().refreshTree();
    await get().selectSession(session.id);
  },

  deleteSession: async (id) => {
    if (get().activeSessionId === id) await get().selectSession(null);
    await ProjectService.DeleteSession(id);
    await get().refreshTree();
  },

  renameSession: async (id, title) => {
    await ProjectService.RenameSession(id, title);
    set({ tree: mapSession(get().tree, id, (s) => ({ ...s, title })) });
    get().markSeen(id);
  },

  selectSession: async (id) => {
    set({ activeSessionId: id });
    if (id) get().markSeen(id);
    if (id) storage.set(ACTIVE_KEY, id);
    else storage.remove(ACTIVE_KEY);
    if (id && !get().messages[id]) {
      const list = (await ChatService.Messages(id)) ?? [];
      set({ messages: { ...get().messages, [id]: list } });
    }
  },

  updateSettings: async (id, patch) => {
    const current = findSession(get().tree, id);
    if (!current) return;
    const next = { ...current, ...patch };
    set({ tree: mapSession(get().tree, id, () => next) }); // optimistic
    const saved = await ProjectService.UpdateSessionSettings(id, next.provider, next.model, next.effort, next.mode);
    set({ tree: mapSession(get().tree, id, () => saved) });
  },

  send: async (sessionId, prompt, attachments = []) => {
    set({ running: { ...get().running, [sessionId]: true } });
    try {
      await ChatService.Send(sessionId, prompt, attachments);
    } catch (err) {
      set({ running: { ...get().running, [sessionId]: false } });
      throw err;
    }
  },

  stop: (sessionId) => void ChatService.Stop(sessionId),

  markSeen: (sessionId) => {
    const seen = { ...get().seen, [sessionId]: Date.now() };
    set({ seen });
    storage.set(SEEN_KEY, JSON.stringify(seen));
  },

  onMessage: (m) => {
    const list = get().messages[m.sessionId];
    if (!list) return; // not loaded; will be fetched on select
    const i = list.findIndex((x) => x.id === m.id);
    const next = i === -1 ? [...list, m] : list.map((x, j) => (j === i ? m : x));
    set({ messages: { ...get().messages, [m.sessionId]: next } });
  },

  onStatus: (sessionId, running) => set({ running: { ...get().running, [sessionId]: running } }),

  onSession: (s) => {
    set({ tree: mapSession(get().tree, s.id, () => s) });
    // Activity in the session you are looking at is seen immediately.
    if (s.id === get().activeSessionId) get().markSeen(s.id);
  },
}));

export function findSession(tree: ProjectTree[], id: string | null): Session | undefined {
  if (!id) return undefined;
  for (const node of tree) {
    const s = node.sessions?.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}

export function useActiveSession() {
  return useApp((s) => findSession(s.tree, s.activeSessionId));
}

export function useActiveProject() {
  return useApp((s) => {
    const session = findSession(s.tree, s.activeSessionId);
    return session ? s.tree.find((n) => n.project.id === session.projectId)?.project : undefined;
  });
}

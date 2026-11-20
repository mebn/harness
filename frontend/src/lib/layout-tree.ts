// Names used throughout the app (UI and code):
//   Workspace  a project folder, top level of the sidebar.
//   Group      a saved layout listed under its workspace in the sidebar.
//   Window     a floating card inside a group (code: "pane", to avoid clashing with DOM `window`).
//   Tab        one view inside a window: chat, terminal, browser, changes or files.
//
// A group's layout is a tree of splits whose leaves are panes, each holding tabs.

/** What a tab can show. */
export type ContentKind = "chat" | "terminal" | "browser" | "changes" | "files";

/** A tab is either content, or "new": a placeholder showing the numbered choices until one is picked. */
export type TabKind = ContentKind | "new";

/** The choices, in the order of their numbers (1–5). */
export const TAB_KINDS: ContentKind[] = ["chat", "terminal", "browser", "changes", "files"];

export type Tab = {
  id: string;
  kind: TabKind;
  /** chat: the backend session shown in this tab. */
  sessionId?: string;
  /** browser: last visited address. */
  url?: string;
  /** terminal: runs as administrator (Windows). */
  admin?: boolean;
  /** terminal: bumped to restart the shell. */
  restarts?: number;
};

export type PaneNode = { type: "pane"; id: string; tabs: Tab[]; active: string | null };

export type SplitNode = {
  type: "split";
  id: string;
  /** row: children side by side; col: stacked. */
  dir: "row" | "col";
  children: LayoutNode[];
  /** Fractions of the split's length, one per child, summing to 1. */
  sizes: number[];
};

export type LayoutNode = PaneNode | SplitNode;

export type Side = "left" | "right" | "top" | "bottom";

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function newPane(tabs: Tab[] = [], id = uid("pane")): PaneNode {
  return { type: "pane", id, tabs, active: tabs[tabs.length - 1]?.id ?? null };
}

export function panesOf(node: LayoutNode): PaneNode[] {
  return node.type === "pane" ? [node] : node.children.flatMap(panesOf);
}

export function findPane(node: LayoutNode, id: string | null | undefined): PaneNode | undefined {
  return id ? panesOf(node).find((p) => p.id === id) : undefined;
}

export function paneOfTab(node: LayoutNode, tabId: string): PaneNode | undefined {
  return panesOf(node).find((p) => p.tabs.some((t) => t.id === tabId));
}

export function tabsOf(node: LayoutNode): Tab[] {
  return panesOf(node).flatMap((p) => p.tabs);
}

export function mapPanes(node: LayoutNode, fn: (p: PaneNode) => PaneNode): LayoutNode {
  if (node.type === "pane") return fn(node);
  return { ...node, children: node.children.map((c) => mapPanes(c, fn)) };
}

export function updatePane(node: LayoutNode, id: string, fn: (p: PaneNode) => PaneNode): LayoutNode {
  return mapPanes(node, (p) => (p.id === id ? fn(p) : p));
}

/** Removes a pane; splits left with one child collapse into it. Null when nothing is left. */
export function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === "pane") return node.id === id ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const next = removePane(c, id);
    if (next) {
      kept.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) };
}

/** Places `pane` on one side of the pane `targetId`, sharing its space. */
export function insertBeside(node: LayoutNode, targetId: string, pane: PaneNode, side: Side): LayoutNode {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";

  if (node.type === "pane") {
    if (node.id !== targetId) return node;
    return {
      type: "split",
      id: uid("split"),
      dir,
      children: before ? [pane, node] : [node, pane],
      sizes: [0.5, 0.5],
    };
  }

  // Same direction as this split: become a sibling instead of nesting another split.
  const i = node.children.findIndex((c) => c.type === "pane" && c.id === targetId);
  if (i !== -1 && node.dir === dir) {
    const children = [...node.children];
    const sizes = [...node.sizes];
    const half = sizes[i] / 2;
    sizes[i] = half;
    const at = before ? i : i + 1;
    children.splice(at, 0, pane);
    sizes.splice(at, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, pane, side)) };
}

export function setSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSplitSizes(c, splitId, sizes)) };
}

/** Takes a tab out of whichever pane holds it; the pane's active tab moves to a neighbor. */
export function detachTab(node: LayoutNode, tabId: string): { root: LayoutNode; tab?: Tab; paneId?: string } {
  const pane = paneOfTab(node, tabId);
  if (!pane) return { root: node };
  const i = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  const active = pane.active === tabId ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : pane.active;
  return {
    root: updatePane(node, pane.id, (p) => ({ ...p, tabs, active })),
    tab: pane.tabs[i],
    paneId: pane.id,
  };
}

/**
 * Removes one pane if it has no tabs left, unless it is the last pane. Only the pane that was
 * just emptied is touched: other empty windows (waiting for a choice) stay.
 */
export function dropIfEmpty(node: LayoutNode, paneId: string | undefined): LayoutNode {
  const pane = findPane(node, paneId);
  if (!pane || pane.tabs.length > 0 || panesOf(node).length === 1) return node;
  return removePane(node, pane.id) ?? node;
}

/** Repairs a layout loaded from storage (bad sizes, dangling active ids). */
export function sanitize(node: LayoutNode): LayoutNode {
  if (node.type === "pane") {
    const tabs = Array.isArray(node.tabs) ? node.tabs.filter((t) => t && t.id && (t.kind === "new" || TAB_KINDS.includes(t.kind))) : [];
    const active = tabs.some((t) => t.id === node.active) ? node.active : (tabs[0]?.id ?? null);
    return { type: "pane", id: node.id || uid("pane"), tabs, active };
  }
  const children = (node.children ?? []).map(sanitize);
  if (children.length === 0) return newPane();
  if (children.length === 1) return children[0];
  let sizes = node.sizes?.length === children.length ? node.sizes : children.map(() => 1 / children.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  sizes = total > 0 ? sizes.map((s) => s / total) : children.map(() => 1 / children.length);
  return { type: "split", id: node.id || uid("split"), dir: node.dir === "col" ? "col" : "row", children, sizes };
}

// ---- geometry ----

export type Rect = { left: number; top: number; width: number; height: number };

export type GutterInfo = {
  splitId: string;
  /** Between children `index` and `index + 1`. */
  index: number;
  dir: "row" | "col";
  rect: Rect;
  /** The whole split's rect; resizing is relative to it. */
  span: Rect;
  count: number;
};

/** Lays a tree out in `rect`, with `gap` between siblings. */
export function computeLayout(node: LayoutNode, rect: Rect, gap: number) {
  const panes: Record<string, Rect> = {};
  const gutters: GutterInfo[] = [];
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.type === "pane") {
      panes[n.id] = r;
      return;
    }
    const row = n.dir === "row";
    const count = n.children.length;
    const total = Math.max(0, (row ? r.width : r.height) - gap * (count - 1));
    let pos = row ? r.left : r.top;
    n.children.forEach((c, i) => {
      const len = total * (n.sizes[i] ?? 1 / count);
      walk(c, row ? { left: pos, top: r.top, width: len, height: r.height } : { left: r.left, top: pos, width: r.width, height: len });
      pos += len;
      if (i < count - 1) {
        const g = row
          ? { left: pos, top: r.top, width: gap, height: r.height }
          : { left: r.left, top: pos, width: r.width, height: gap };
        gutters.push({ splitId: n.id, index: i, dir: n.dir, rect: g, span: r, count });
        pos += gap;
      }
    });
  };
  walk(node, rect);
  return { panes, gutters };
}

/**
 * Split Pane Best Fit: the window with the most room is split along its longer side, so the
 * new window gets the largest area available. Ties go to the focused window. An empty window
 * is filled instead of split (side null).
 */
export function bestFit(
  root: LayoutNode,
  width: number,
  height: number,
  focused: string | null,
): { paneId: string; side: Side | null } {
  const empty = panesOf(root).find((p) => p.tabs.length === 0);
  if (empty) return { paneId: empty.id, side: null };
  const { panes } = computeLayout(root, { left: 0, top: 0, width, height }, 0);
  let best: { id: string; area: number } | null = null;
  for (const [id, r] of Object.entries(panes)) {
    const area = r.width * r.height;
    if (!best || area > best.area + 1 || (Math.abs(area - best.area) <= 1 && id === focused)) best = { id, area };
  }
  const r = panes[best!.id];
  return { paneId: best!.id, side: r.width >= r.height ? "right" : "bottom" };
}

export type Direction = "left" | "right" | "up" | "down";

/** The window next to `fromId` in a direction: nearest edge first, then most overlap. */
export function neighbor(rects: Record<string, Rect>, fromId: string, dir: Direction): string | undefined {
  const a = rects[fromId];
  if (!a) return undefined;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; dist: number; overlap: number } | undefined;
  for (const [id, b] of Object.entries(rects)) {
    if (id === fromId) continue;
    const dist =
      dir === "left"
        ? a.left - (b.left + b.width)
        : dir === "right"
          ? b.left - (a.left + a.width)
          : dir === "up"
            ? a.top - (b.top + b.height)
            : b.top - (a.top + a.height);
    if (dist < -1) continue;
    const overlap = horizontal
      ? Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
      : Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    if (overlap <= 0) continue;
    if (!best || dist < best.dist - 1 || (Math.abs(dist - best.dist) <= 1 && overlap > best.overlap)) {
      best = { id, dist, overlap };
    }
  }
  return best?.id;
}

// ---- moving tabs and windows ----

/** What is being dragged or moved: one tab, or a whole window with all its tabs. */
export type Payload = { kind: "tab"; tabId: string } | { kind: "pane"; paneId: string };

/** Where it goes inside a group. */
export type DropTarget =
  | { kind: "tabs"; paneId: string; index: number }
  | { kind: "center"; paneId: string }
  | { kind: "edge"; paneId: string; side: Side };

/** Removes the payload from a layout; the last window is kept (emptied) rather than removed. */
export function extractPayload(root: LayoutNode, payload: Payload): { root: LayoutNode; tabs: Tab[] } {
  if (payload.kind === "tab") {
    const { root: next, tab, paneId } = detachTab(root, payload.tabId);
    return { root: dropIfEmpty(next, paneId), tabs: tab ? [tab] : [] };
  }
  const pane = findPane(root, payload.paneId);
  if (!pane) return { root, tabs: [] };
  return { root: removePane(root, pane.id) ?? newPane(), tabs: pane.tabs };
}

/**
 * Applies a move within one group. `newPaneId` names the window an edge drop creates, so a
 * live preview and the final drop agree. Returns null when the move would change nothing.
 */
export function applyMove(
  root: LayoutNode,
  payload: Payload,
  target: DropTarget,
  newPaneId: string,
): { root: LayoutNode; focus: string } | null {
  const targetPane = findPane(root, target.paneId);
  const source = payload.kind === "tab" ? paneOfTab(root, payload.tabId) : findPane(root, payload.paneId);
  if (!targetPane || !source) return null;
  const self = source.id === targetPane.id;

  if (payload.kind === "pane" && self) return null;
  if (payload.kind === "tab" && self && target.kind === "center") return null;
  if (payload.kind === "tab" && self && target.kind === "edge" && source.tabs.length === 1) return null;

  if (target.kind === "edge") {
    const { root: rest, tabs } = extractPayload(root, payload);
    const id = payload.kind === "pane" ? payload.paneId : newPaneId;
    // extractPayload already removed the source window if the move emptied it.
    return { root: insertBeside(rest, target.paneId, newPane(tabs, id), target.side), focus: id };
  }

  // Into the target's tab strip, at an index counted before the payload was taken out.
  let index = target.kind === "tabs" ? target.index : targetPane.tabs.length;
  let moved: Tab[];
  let rest: LayoutNode;
  if (payload.kind === "tab") {
    const from = source.tabs.findIndex((t) => t.id === payload.tabId);
    if (self) {
      if (from < index) index -= 1;
      if (from === index) return null;
    }
    moved = [source.tabs[from]];
    rest = detachTab(root, payload.tabId).root;
  } else {
    moved = source.tabs;
    rest = removePane(root, source.id) ?? root;
  }
  const next = updatePane(rest, target.paneId, (p) => {
    const list = [...p.tabs];
    list.splice(Math.min(index, list.length), 0, ...moved);
    return { ...p, tabs: list, active: moved[moved.length - 1]?.id ?? p.active };
  });
  // The source window goes if the move emptied it (the target never is).
  return { root: self ? next : dropIfEmpty(next, source.id), focus: target.paneId };
}

// ---- placing new windows ----

export type SplitStrategy = "dwindle" | "bestFit" | "spiral" | "columns" | "rows";

export const SPLIT_STRATEGIES: { id: SplitStrategy; label: string; description: string }[] = [
  {
    id: "dwindle",
    label: "Dwindle",
    description: "Splits the focused window in two along its longer side, so each new window halves the last.",
  },
  {
    id: "bestFit",
    label: "Best fit",
    description: "Splits whichever window has the most room, along its longer side, so the new window gets the largest area.",
  },
  {
    id: "spiral",
    label: "Spiral",
    description: "Splits the focused window, turning each time (right, down, left, up), so windows spiral inward.",
  },
  {
    id: "columns",
    label: "Columns",
    description: "Adds the new window as another column; all columns share the width equally.",
  },
  {
    id: "rows",
    label: "Rows",
    description: "Adds the new window as another row; all rows share the height equally.",
  },
];

const SPIRAL: Side[] = ["right", "bottom", "left", "top"];

/** Adds `pane` as another child of the root in `dir`, with all children equal. */
function appendToRoot(root: LayoutNode, pane: PaneNode, dir: "row" | "col"): LayoutNode {
  if (root.type === "split" && root.dir === dir) {
    const children = [...root.children, pane];
    return { ...root, children, sizes: children.map(() => 1 / children.length) };
  }
  return { type: "split", id: uid("split"), dir, children: [root, pane], sizes: [0.5, 0.5] };
}

/**
 * Puts a new window into a layout using a split strategy. Content goes into an empty window
 * instead if there is one (the focused one first). Returns the new root and the window that now holds the tabs.
 */
export function placeNewPane(
  root: LayoutNode,
  pane: PaneNode,
  opts: { strategy: SplitStrategy; width: number; height: number; focused: string | null; gap: number },
): { root: LayoutNode; focus: string } {
  const panes = panesOf(root);
  const empty = panes.find((p) => p.id === opts.focused && p.tabs.length === 0) ?? panes.find((p) => p.tabs.length === 0);
  // Real content fills an empty window; a "New tab" placeholder always gets a window of its own.
  if (empty && pane.tabs.some((t) => t.kind !== "new")) {
    const filled = updatePane(root, empty.id, (p) => ({ ...p, tabs: pane.tabs, active: pane.active }));
    return { root: filled, focus: empty.id };
  }

  const target = findPane(root, opts.focused) ?? panes[panes.length - 1];
  const { panes: rects } = computeLayout(root, { left: 0, top: 0, width: opts.width, height: opts.height }, opts.gap);
  const longer = (id: string): Side => (rects[id] && rects[id].width < rects[id].height ? "bottom" : "right");

  switch (opts.strategy) {
    case "columns":
      return { root: appendToRoot(root, pane, "row"), focus: pane.id };
    case "rows":
      return { root: appendToRoot(root, pane, "col"), focus: pane.id };
    case "bestFit": {
      const fit = bestFit(root, opts.width, opts.height, opts.focused);
      return { root: insertBeside(root, fit.paneId, pane, fit.side ?? "right"), focus: pane.id };
    }
    case "spiral":
      return { root: insertBeside(root, target.id, pane, SPIRAL[(panes.length - 1) % 4]), focus: pane.id };
    case "dwindle":
    default:
      return { root: insertBeside(root, target.id, pane, longer(target.id)), focus: pane.id };
  }
}

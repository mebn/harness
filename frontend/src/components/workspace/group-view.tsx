import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns2, Maximize2, Minimize2, Plus, RotateCw, Rows2, ShieldCheck, ShieldOff, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  applyMove,
  computeLayout,
  extractPayload,
  findPane,
  panesOf,
  tabsOf,
  type LayoutNode,
  type PaneNode,
  type Payload,
  type Rect,
  type Side,
  type SplitNode,
  type Tab,
  type TabKind,
} from "@/lib/layout-tree";
import { requestClosePane, requestCloseTab } from "@/lib/close-guard";
import { shortcutLabel } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useDrag, type Drag, type DragTarget, type FrozenGeometry } from "@/stores/drag-store";
import { useApp } from "@/stores/app-store";
import { GAP, MIN_WINDOW, canElevate, layoutFits, useGroups, type Group } from "@/stores/group-store";
import { useTabLayer, type Placement } from "@/stores/tab-layer-store";
import { KindPicker } from "./kind-picker";
import { TabIcon, useTabLabel } from "./tab-meta";

/** Height of a window's header (tab strip), plus its 1px border. */
const HEADER = 40;
const BORDER = 1;
/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Share of a window's width/height near each edge that splits instead of adding a tab. */
const EDGE_ZONE = 0.25;

type Ctx = {
  group: Group;
  /** False until the group has been shown once; windows there from the start don't fade in. */
  settled: boolean;
  /** Starts tracking a press that becomes a drag once the pointer moves. */
  press: Press;
  /** The payload being dragged out of this group, if any. */
  dragging: Payload | null;
};

const GroupCtx = createContext<Ctx | null>(null);
const useGroupCtx = () => useContext(GroupCtx)!;

type Press = (e: React.PointerEvent, payload: Payload, label: string, icon: TabKind | null, onDrop?: () => void) => void;

const pressers = new Map<string, Press>();

/**
 * Starts dragging something into a group's layout from inside one of its tabs, such as a file
 * from the explorer becoming a tab of its own. Below the drag threshold it stays a click.
 */
export const pressIntoGroup = (groupId: string, ...args: Parameters<Press>) => pressers.get(groupId)?.(...args);

/**
 * One group: its windows laid out from the split tree with absolute positions, and every tab's
 * content in the same coordinate space. Because nothing is nested by tree structure, splitting,
 * maximizing or moving a tab never remounts it (terminals keep running), and every change can
 * animate. While a drag is over the group, the layout shows the drop result live.
 */
export function GroupView({ group, active }: { group: Group; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [resizing, setResizing] = useState(false);
  const drag = useDrag((s) => (s.drag?.groupId === group.id ? s.drag : null));
  const setViewport = useGroups((s) => s.setViewport);

  // Measured before the first paint, so a group opens already laid out.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
      if (width > 0 && height > 0) setViewport(group.id, width, height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [group.id, setViewport]);

  // Nothing animates until the group has been shown laid out once: opening it doesn't slide
  // windows in from the corner.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled || size.width === 0) return;
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => setSettled(true));
    });
    return () => cancelAnimationFrame(id);
  }, [settled, size.width]);

  // What is shown: the real layout, or the result of the drop being hovered.
  const shown = useMemo(() => {
    const preview = previewRoot(group.root, drag);
    return preview === group.root || layoutFits(preview, size) ? preview : group.root;
  }, [group.root, drag, size]);
  const maximized = !drag ? findPane(shown, group.maximized) : undefined;
  const layout = useMemo(() => computeLayout(shown, { left: 0, top: 0, ...size }, GAP), [shown, size]);
  const rects = maximized ? { ...layout.panes, [maximized.id]: { left: 0, top: 0, ...size } } : layout.panes;
  const panes = panesOf(shown);
  const paneOfTabId = useMemo(() => {
    const m = new Map<string, PaneNode>();
    for (const p of panes) for (const t of p.tabs) m.set(t.id, p);
    return m;
  }, [panes]);

  // Keyboard focus follows the focused window when it moves by keyboard.
  const focusNonce = useGroups((s) => s.focusNonce);
  useEffect(() => {
    if (!active) return;
    const pane = findPane(group.root, group.focused);
    if (!pane) return;
    const id = requestAnimationFrame(() => {
      // An empty window takes no typing itself; release whatever had focus so 1–5 reach it.
      const host = pane.active ? document.querySelector(`[data-tab-content="${pane.active}"]`) : null;
      const target = host?.querySelector<HTMLElement>("textarea[data-composer], .xterm-helper-textarea, input, [tabindex]");
      if (target) target.focus();
      else (document.activeElement as HTMLElement | null)?.blur?.();
    });
    return () => cancelAnimationFrame(id);
    // Only on explicit keyboard moves, not every focus change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, active]);

  const press = useCallback(
    (e: React.PointerEvent, payload: Payload, label: string, icon: TabKind | null, onDrop?: () => void) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let started = false;
      const store = useDrag.getState();

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
          started = true;
          const geometry = freeze(container.current, rectsRef.current);
          store.start({ groupId: group.id, projectId: group.projectId, payload, label, icon, geometry, onDrop }, ev.clientX, ev.clientY);
        }
        const d = useDrag.getState().drag;
        if (d) useDrag.getState().move(ev.clientX, ev.clientY, hitTest(ev.clientX, ev.clientY, d));
      };
      const finish = (apply: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        if (started) useDrag.getState().end(apply);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !started) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [group.id, group.projectId],
  );

  // Tab content (the file explorer) starts drags into this group through the registry.
  useEffect(() => {
    pressers.set(group.id, press);
    return () => {
      if (pressers.get(group.id) === press) pressers.delete(group.id);
    };
  }, [group.id, press]);

  // The drag start reads the rects that are on screen at that moment.
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const ctx: Ctx = { group, settled, press, dragging: drag?.payload ?? null };
  const hiddenPane = (id: string) => !!maximized && maximized.id !== id;

  // Tell the shared tab layer where this group's tabs go. Tabs of the real layout are all
  // reported, so ones hidden by a drag preview stay mounted.
  const report = useTabLayer((s) => s.report);
  useLayoutEffect(() => {
    if (size.width === 0) return;
    const placements: Record<string, Placement> = {};
    for (const tab of tabsOf(group.root)) {
      const pane = paneOfTabId.get(tab.id);
      const rect = pane && rects[pane.id];
      if (!pane || !rect) continue;
      placements[tab.id] = { paneId: pane.id, style: bodyRect(rect, size), shown: pane.active === tab.id && !hiddenPane(pane.id) };
    }
    report(group.id, placements, settled && !resizing);
  });

  return (
    <GroupCtx.Provider value={ctx}>
      <div ref={container} className={cn("relative h-full overflow-hidden", (resizing || !settled) && "no-anim")}>
        {panes.map((pane) => (
          <PaneFrame key={pane.id} pane={pane} rect={rects[pane.id]} size={size} hidden={hiddenPane(pane.id)} />
        ))}

        {!drag &&
          !maximized &&
          layout.gutters.map((g) => (
            <Gutter key={`${g.splitId}:${g.index}`} info={g} size={size} root={group.root} onResizing={setResizing} />
          ))}

      </div>
    </GroupCtx.Provider>
  );
}

/** The layout to show while a drag is over this group: the drop result, or the layout without the payload. */
function previewRoot(root: LayoutNode, drag: Drag | null): LayoutNode {
  if (!drag?.target) return root;
  if (drag.target.kind === "layout") return applyMove(root, drag.payload, drag.target.target, drag.newPaneId)?.root ?? root;
  // Leaving for the sidebar: the rest of the group closes the gap.
  return extractPayload(root, drag.payload).root;
}

/**
 * A rect as CSS relative to the group area (percentages, with fixed pixel insets), so when the
 * area resizes (the sidebar sliding, the app window resizing) the browser moves everything in
 * the same frame, instead of the layout catching up a frame or two later from JS.
 */
type Size = { width: number; height: number };

function relRect(r: Rect, size: Size, inset = { left: 0, right: 0, top: 0, bottom: 0 }): React.CSSProperties {
  // Before the area is measured, plain pixels.
  const pos = (v: number, total: number, add: number) => (total ? `calc(${(v / total) * 100}% + ${add}px)` : `${v + add}px`);
  const len = (v: number, total: number, sub: number) =>
    total ? `max(0px, calc(${(v / total) * 100}% - ${sub}px))` : `${Math.max(0, v - sub)}px`;
  return {
    left: pos(r.left, size.width, inset.left),
    top: pos(r.top, size.height, inset.top),
    width: len(r.width, size.width, inset.left + inset.right),
    height: len(r.height, size.height, inset.top + inset.bottom),
  };
}

function bodyRect(r: Rect, size: Size): React.CSSProperties {
  // Cards have only right and bottom borders (see .pane-card).
  return relRect(r, size, { left: 0, right: BORDER, top: HEADER, bottom: BORDER });
}

/** Snapshot of where windows and tab buttons are on screen when a drag starts. */
function freeze(container: HTMLElement | null, rects: Record<string, Rect>): FrozenGeometry {
  const box = container?.getBoundingClientRect();
  if (!container || !box) return { panes: [], headerHeight: HEADER };
  const panes = Object.entries(rects).map(([id, r]) => ({
    id,
    rect: { left: box.left + r.left, top: box.top + r.top, width: r.width, height: r.height },
    tabs: [...container.querySelectorAll<HTMLElement>(`[data-pane-tabs="${id}"] [data-tab-index]`)].map((el) => {
      const t = el.getBoundingClientRect();
      return { index: Number(el.dataset.tabIndex), rect: { left: t.left, top: t.top, width: t.width, height: t.height } };
    }),
  }));
  return { panes, headerHeight: HEADER };
}

/** Where the pointer would drop: a sidebar row, the sidebar, or a spot in the source group. */
function hitTest(x: number, y: number, drag: Drag): DragTarget | null {
  const el = document.elementsFromPoint(x, y).find((e) => !e.closest("[data-drag-overlay]"));
  if (el?.closest("[data-drop-sidebar]")) {
    // Another workspace's groups can't take it.
    const row = el.closest<HTMLElement>("[data-drop-group]");
    if (row && row.dataset.project !== drag.projectId) return null;
    return sidebarTarget(y, drag);
  }

  for (const pane of drag.geometry.panes) {
    const r = pane.rect;
    if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) continue;
    if (y < r.top + drag.geometry.headerHeight) {
      // Insert before the first tab whose middle is right of the pointer.
      const after = pane.tabs.filter((t) => t.rect.left + t.rect.width / 2 < x).length;
      return { kind: "layout", target: { kind: "tabs", paneId: pane.id, index: after } };
    }
    const fx = (x - r.left) / r.width;
    const fy = (y - r.top) / r.height;
    const edges: [Side, number][] = [
      ["left", fx],
      ["right", 1 - fx],
      ["top", fy],
      ["bottom", 1 - fy],
    ];
    const [side, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
    return {
      kind: "layout",
      target: d < EDGE_ZONE ? { kind: "edge", paneId: pane.id, side } : { kind: "center", paneId: pane.id },
    };
  }
  return null;
}

/** Share of a sidebar row's height, at its top and bottom, that places a new group beside it. */
const ROW_EDGE = 0.25;

/**
 * Over the sidebar: into the group row under the pointer, or a new group at the pointer's place
 * among the workspace's groups. The new group's placeholder pushes the rows below it down, so
 * rows are measured as if it weren't there: the target doesn't flip back and forth as it moves.
 */
function sidebarTarget(y: number, drag: Drag): DragTarget {
  const list = document.querySelector<HTMLElement>(`[data-group-list="${CSS.escape(drag.projectId)}"]`);
  // The workspace is folded: the new group goes where the sort puts it.
  if (!list) return { kind: "newGroup" };
  const box = list.getBoundingClientRect();
  const placeholder = list.querySelector<HTMLElement>(":scope > [data-group-placeholder]");
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-drop-group]")].map((r) => {
    let top = box.top + r.offsetTop;
    if (placeholder && r.offsetTop > placeholder.offsetTop) top -= placeholder.offsetHeight + gap;
    return { id: r.dataset.dropGroup!, top, height: r.offsetHeight };
  });
  const over = rows.find((r) => y >= r.top && y < r.top + r.height);
  if (over && over.id !== drag.groupId) {
    const f = (y - over.top) / over.height;
    if (f > ROW_EDGE && f < 1 - ROW_EDGE) return { kind: "group", groupId: over.id };
  }
  return { kind: "newGroup", index: rows.filter((r) => r.top + r.height / 2 < y).length };
}

function findSplit(node: LayoutNode, id: string): SplitNode | undefined {
  if (node.type === "pane") return undefined;
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findSplit(c, id);
    if (found) return found;
  }
  return undefined;
}

/** Minimum grab size of a gutter, in pixels. */
const GRIP = 6;

/** The gap between two windows; dragging it resizes them. */
function Gutter({
  info,
  size,
  root,
  onResizing,
}: {
  info: ReturnType<typeof computeLayout>["gutters"][number];
  size: Size;
  root: LayoutNode;
  onResizing: (resizing: boolean) => void;
}) {
  const { group } = useGroupCtx();
  const row = info.dir === "row";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const split = findSplit(root, info.splitId);
    if (!split || e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    onResizing(true);
    const total = (row ? info.span.width : info.span.height) - GAP * (info.count - 1);
    const start = row ? e.clientX : e.clientY;
    const initial = [...split.sizes];
    const i = info.index;
    const pair = initial[i] + initial[i + 1];
    const min = Math.min((row ? MIN_WINDOW.width : MIN_WINDOW.height) / total, pair / 2);

    const move = (ev: PointerEvent) => {
      const delta = ((row ? ev.clientX : ev.clientY) - start) / total;
      const a = Math.max(min, Math.min(pair - min, initial[i] + delta));
      const sizes = [...initial];
      sizes[i] = a;
      sizes[i + 1] = pair - a;
      useGroups.getState().setSizes(group.id, split.id, sizes);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onResizing(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className={cn("group/gutter absolute z-10", row ? "cursor-col-resize" : "cursor-row-resize")}
      // The seam may be thinner than a comfortable grab area, so pad it out around its centre.
      style={(() => {
        const r = info.rect;
        const rel = relRect(r, size);
        return row
          ? { ...rel, left: `calc(${rel.left} + ${r.width / 2 - GRIP / 2}px)`, width: Math.max(r.width, GRIP) }
          : { ...rel, top: `calc(${rel.top} + ${r.height / 2 - GRIP / 2}px)`, height: Math.max(r.height, GRIP) };
      })()}
    >
      <span
        className={cn(
          "absolute rounded-full transition-colors group-hover/gutter:bg-foreground/15 group-active/gutter:bg-foreground/25",
          row ? "inset-y-6 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-6 top-1/2 h-0.5 -translate-y-1/2",
        )}
      />
    </div>
  );
}

/** A window's card: header with its tabs and actions; the body is covered by the active tab. */
function PaneFrame({ pane, rect, size, hidden }: { pane: PaneNode; rect: Rect | undefined; size: Size; hidden: boolean }) {
  const { group, settled, dragging } = useGroupCtx();
  const setHovered = useTabLayer((st) => st.setHovered);
  const focused = group.focused === pane.id;
  // Only windows opened after the group is on screen fade in.
  const [fadeIn] = useState(settled);
  const isDragged = dragging?.kind === "pane" && dragging.paneId === pane.id;

  if (!rect) return null;
  return (
    <div
      data-pane={pane.id}
      onPointerDown={() => useGroups.getState().focusPane(group.id, pane.id)}
      onPointerEnter={() => setHovered({ groupId: group.id, paneId: pane.id })}
      onPointerLeave={() => setHovered(null)}
      className={cn(
        "pane-card layout-anim absolute flex flex-col",
        fadeIn && "animate-in fade-in-0 zoom-in-[0.98] duration-200",
        focused && "pane-card-focused",
        hidden && "pointer-events-none opacity-0",
        isDragged && "opacity-60",
      )}
      style={relRect(rect, size)}
    >
      <PaneHeader pane={pane} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {pane.tabs.length === 0 && (
          <KindPicker focused={focused} onPick={(kind) => void useGroups.getState().fillTab(group.id, pane.id, kind)} />
        )}
      </div>
    </div>
  );
}

function PaneHeader({ pane }: { pane: PaneNode }) {
  const { group, press } = useGroupCtx();
  const store = useGroups.getState();
  const single = pane.tabs.length === 1;
  const activeTab = pane.tabs.find((t) => t.id === pane.active);
  const windowLabel = useTabLabel(activeTab ?? { id: "", kind: "chat" });
  // Right-clicking the header's empty space opens the window menu at the pointer.
  const [menuAt, setMenuAt] = useState<number | null>(null);

  return (
    <div
      className="relative flex shrink-0 items-center gap-1 pr-1.5 pl-2"
      style={{ height: HEADER }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("[role=tab]")) return;
        e.preventDefault();
        setMenuAt(e.clientX - e.currentTarget.getBoundingClientRect().left);
      }}
      // Grabbing the header's empty space drags the whole window.
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[role=tab], button")) return;
        press(e, { kind: "pane", paneId: pane.id }, activeTab ? windowLabel : "Empty window", activeTab?.kind ?? null);
      }}
    >
      <div
        role="tablist"
        data-pane-tabs={pane.id}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {pane.tabs.map((tab, i) => (
          <TabButton key={tab.id} tab={tab} index={i} selected={pane.active === tab.id} single={single} />
        ))}
        <AddTabButton onClick={() => void store.addTab(group.id, pane.id)} />
      </div>
      <DropdownMenu open={menuAt !== null} onOpenChange={(o) => !o && setMenuAt(null)}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute bottom-1 h-0 w-0" style={{ left: menuAt ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <WindowMenuItems paneId={pane.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Split, maximize and close for a window; in the header's and every tab's right-click menu. */
function WindowMenuItems({ paneId }: { paneId: string }) {
  const { group } = useGroupCtx();
  const store = useGroups.getState();
  const isMaximized = group.maximized === paneId;
  return (
    <>
      <DropdownMenuItem onSelect={() => void store.split(group.id, paneId, "right")}>
        <Columns2 /> Split right
        <DropdownMenuShortcut>{shortcutLabel("splitRight")}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void store.split(group.id, paneId, "bottom")}>
        <Rows2 /> Split down
        <DropdownMenuShortcut>{shortcutLabel("splitDown")}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => store.toggleMaximize(group.id, paneId)}>
        {isMaximized ? <Minimize2 /> : <Maximize2 />} {isMaximized ? "Restore" : "Maximize"}
        <DropdownMenuShortcut>{shortcutLabel("maximize")}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void requestClosePane(group.id, paneId)}>
        <X /> Close window
        <DropdownMenuShortcut>{shortcutLabel("closeWindow")}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}

function TabButton({ tab, index, selected, single }: { tab: Tab; index: number; selected: boolean; single: boolean }) {
  const { group, press, dragging } = useGroupCtx();
  const label = useTabLabel(tab);
  const store = useGroups.getState();
  const isDragged = dragging?.kind === "tab" && dragging.tabId === tab.id;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      role="tab"
      aria-selected={selected}
      title={label}
      data-tab-index={index}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        press(e, { kind: "tab", tabId: tab.id }, label, tab.kind);
      }}
      onClick={() => store.selectTab(group.id, tab.id)}
      onAuxClick={(e) => e.button === 1 && void requestCloseTab(group.id, tab.id)}
      className={cn(
        "group/tab relative flex h-7 max-w-56 shrink-0 cursor-default items-center gap-1.5 rounded-lg pr-2.5 pl-1.5 text-[13px]",
        single
          ? "font-medium text-foreground"
          : selected
            ? "bg-foreground/[0.07] font-medium text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        isDragged && "opacity-50",
      )}
    >
      {/* The icon swaps for the close button on hover. */}
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <TabIcon kind={tab.kind} className="size-3.5 opacity-80 group-hover/tab:invisible" />
        <button
          aria-label={`Close ${label}`}
          title={`Close tab (${shortcutLabel("closeTab")})`}
          onClick={(e) => {
            e.stopPropagation();
            void requestCloseTab(group.id, tab.id);
          }}
          className="absolute inset-0 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </span>
      <span className="truncate">{label}</span>
      <TabMenu tab={tab} open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}

/** A tab's right-click menu: terminal restarts (as administrator on Windows), then the window's actions. */
function TabMenu({ tab, open, onOpenChange }: { tab: Tab; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { group } = useGroupCtx();
  const elevatable = useApp((s) => {
    const project = s.tree.find((n) => n.project.id === group.projectId)?.project;
    return !!project && canElevate(project, s.system.os);
  });
  const store = useGroups.getState();
  const paneId = panesOf(group.root).find((p) => p.tabs.some((t) => t.id === tab.id))?.id;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Anchors the menu under the tab; the tab itself handles clicks and drags. */}
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0" />
      </DropdownMenuTrigger>
      {/* React events bubble through the portal to the tab; keep them from starting a drag. */}
      <DropdownMenuContent
        align="start"
        className="w-56"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {tab.kind === "terminal" && (
          <>
            <DropdownMenuItem onSelect={() => store.restartTerminal(group.id, tab.id, !!tab.admin)}>
              <RotateCw /> Restart
            </DropdownMenuItem>
            {elevatable &&
              (tab.admin ? (
                <DropdownMenuItem onSelect={() => store.restartTerminal(group.id, tab.id, false)}>
                  <ShieldOff /> Restart without admin rights
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => store.restartTerminal(group.id, tab.id, true)}>
                  <ShieldCheck /> Restart as administrator
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => void requestCloseTab(group.id, tab.id)}>
          <X /> Close tab
          <DropdownMenuShortcut>{shortcutLabel("closeTab")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {paneId && (
          <>
            <DropdownMenuSeparator />
            <WindowMenuItems paneId={paneId} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddTabButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label="New tab"
          onClick={onClick}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">New tab ({shortcutLabel("newTab")})</TooltipContent>
    </Tooltip>
  );
}

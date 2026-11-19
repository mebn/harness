import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Columns2, Maximize2, Minimize2, Plus, Rows2, X } from "lucide-react";
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
import { shortcutLabel, type ShortcutId } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useDrag, type Drag, type DragTarget, type FrozenGeometry } from "@/stores/drag-store";
import { GAP, MIN_WINDOW, layoutFits, useGroups, type Group } from "@/stores/group-store";
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
  /** Starts tracking a press that becomes a drag once the pointer moves. */
  press: (e: React.PointerEvent, payload: Payload, label: string, icon: TabKind | null) => void;
  /** The payload being dragged out of this group, if any. */
  dragging: Payload | null;
};

const GroupCtx = createContext<Ctx | null>(null);
const useGroupCtx = () => useContext(GroupCtx)!;

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

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
      if (width > 0 && height > 0) setViewport(group.id, width, height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [group.id, setViewport]);

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
    (e: React.PointerEvent, payload: Payload, label: string, icon: TabKind | null) => {
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
          store.start({ groupId: group.id, projectId: group.projectId, payload, label, icon, geometry }, ev.clientX, ev.clientY);
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

  // The drag start reads the rects that are on screen at that moment.
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const ctx: Ctx = { group, press, dragging: drag?.payload ?? null };
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
      placements[tab.id] = { paneId: pane.id, style: bodyRect(rect), shown: pane.active === tab.id && !hiddenPane(pane.id) };
    }
    report(group.id, placements, !resizing);
  });

  return (
    <GroupCtx.Provider value={ctx}>
      <div ref={container} className={cn("relative h-full overflow-hidden", (resizing || size.width === 0) && "no-anim")}>
        {panes.map((pane) => (
          <PaneFrame key={pane.id} pane={pane} rect={rects[pane.id]} hidden={hiddenPane(pane.id)} />
        ))}

        {!drag &&
          !maximized &&
          layout.gutters.map((g) => (
            <Gutter key={`${g.splitId}:${g.index}`} info={g} root={group.root} onResizing={setResizing} />
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

function bodyRect(r: Rect): React.CSSProperties {
  return {
    left: r.left + BORDER,
    top: r.top + BORDER + HEADER,
    width: Math.max(0, r.width - 2 * BORDER),
    height: Math.max(0, r.height - HEADER - 2 * BORDER),
  };
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
  return { panes, headerHeight: HEADER + BORDER };
}

/** Where the pointer would drop: a sidebar row, the sidebar, or a spot in the source group. */
function hitTest(x: number, y: number, drag: Drag): DragTarget | null {
  const el = document.elementsFromPoint(x, y).find((e) => !e.closest("[data-drag-overlay]"));
  const row = el?.closest<HTMLElement>("[data-drop-group]");
  if (row) {
    const { dropGroup, project } = row.dataset;
    return dropGroup !== drag.groupId && project === drag.projectId ? { kind: "group", groupId: dropGroup! } : null;
  }
  if (el?.closest("[data-drop-sidebar]")) return { kind: "newGroup" };

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

function findSplit(node: LayoutNode, id: string): SplitNode | undefined {
  if (node.type === "pane") return undefined;
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findSplit(c, id);
    if (found) return found;
  }
  return undefined;
}

/** The gap between two windows; dragging it resizes them. */
function Gutter({
  info,
  root,
  onResizing,
}: {
  info: ReturnType<typeof computeLayout>["gutters"][number];
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
      style={info.rect}
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
function PaneFrame({ pane, rect, hidden }: { pane: PaneNode; rect: Rect | undefined; hidden: boolean }) {
  const { group, dragging } = useGroupCtx();
  const setHovered = useTabLayer((st) => st.setHovered);
  const focused = group.focused === pane.id;
  const isDragged = dragging?.kind === "pane" && dragging.paneId === pane.id;

  if (!rect) return null;
  return (
    <div
      data-pane={pane.id}
      onPointerDown={() => useGroups.getState().focusPane(group.id, pane.id)}
      onPointerEnter={() => setHovered({ groupId: group.id, paneId: pane.id })}
      onPointerLeave={() => setHovered(null)}
      className={cn(
        "pane-card layout-anim absolute flex flex-col animate-in fade-in-0 zoom-in-[0.98] duration-200",
        focused && "pane-card-focused",
        hidden && "pointer-events-none opacity-0",
        isDragged && "opacity-60",
      )}
      style={rect}
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
  const hovered = useTabLayer((st) => (st.hovered?.groupId === group.id ? st.hovered.paneId : null));
  const store = useGroups.getState();
  const isMaximized = group.maximized === pane.id;
  const single = pane.tabs.length === 1;
  const activeTab = pane.tabs.find((t) => t.id === pane.active);
  const windowLabel = useTabLabel(activeTab ?? { id: "", kind: "chat" });
  // Header actions only show on the focused or hovered window.
  const showActions = group.focused === pane.id || hovered === pane.id;

  return (
    <div
      className="flex shrink-0 items-center gap-1 pr-1.5 pl-2"
      style={{ height: HEADER }}
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
      <div className={cn("flex items-center transition-opacity duration-150", !showActions && "pointer-events-none opacity-0")}>
        <HeaderButton label="Split right" shortcut="splitRight" onClick={() => void store.split(group.id, pane.id, "right")}>
          <Columns2 />
        </HeaderButton>
        <HeaderButton label="Split down" shortcut="splitDown" onClick={() => void store.split(group.id, pane.id, "bottom")}>
          <Rows2 />
        </HeaderButton>
        <HeaderButton
          label={isMaximized ? "Restore" : "Maximize"}
          shortcut="maximize"
          onClick={() => store.toggleMaximize(group.id, pane.id)}
        >
          {isMaximized ? <Minimize2 /> : <Maximize2 />}
        </HeaderButton>
        <HeaderButton label="Close window" shortcut="closeWindow" onClick={() => store.closePane(group.id, pane.id)}>
          <X />
        </HeaderButton>
      </div>
    </div>
  );
}

function TabButton({ tab, index, selected, single }: { tab: Tab; index: number; selected: boolean; single: boolean }) {
  const { group, press, dragging } = useGroupCtx();
  const label = useTabLabel(tab);
  const store = useGroups.getState();
  const isDragged = dragging?.kind === "tab" && dragging.tabId === tab.id;

  return (
    <div
      role="tab"
      aria-selected={selected}
      title={label}
      data-tab-index={index}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        press(e, { kind: "tab", tabId: tab.id }, label, tab.kind);
      }}
      onClick={() => store.selectTab(group.id, tab.id)}
      onAuxClick={(e) => e.button === 1 && store.closeTab(group.id, tab.id)}
      className={cn(
        "group/tab relative flex h-7 max-w-56 shrink-0 cursor-default items-center gap-1.5 rounded-lg pr-1 pl-2 text-[13px]",
        single
          ? "font-medium text-foreground"
          : selected
            ? "bg-foreground/[0.07] font-medium text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        isDragged && "opacity-50",
      )}
    >
      <TabIcon kind={tab.kind} className="size-3.5 shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
      <button
        aria-label={`Close ${label}`}
        title={`Close tab (${shortcutLabel("closeTab")})`}
        onClick={(e) => {
          e.stopPropagation();
          store.closeTab(group.id, tab.id);
        }}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/10 hover:text-foreground",
          single && "hidden",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
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

function HeaderButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: ShortcutId;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          onClick={onClick}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground [&_svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <span className="ml-1 opacity-60">{shortcutLabel(shortcut)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

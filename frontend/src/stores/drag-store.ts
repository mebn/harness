import { create } from "zustand";
import type { DropTarget, Payload, Rect, TabKind } from "@/lib/layout-tree";
import { uid } from "@/lib/layout-tree";
import { useGroups } from "./group-store";

/** Where a dragged tab or window would land. */
export type DragTarget =
  | { kind: "layout"; target: DropTarget }
  /** An existing group (sidebar row) of the same workspace. */
  | { kind: "group"; groupId: string }
  /** Anywhere else in the sidebar: a new group. */
  | { kind: "newGroup" };

/**
 * The source group's geometry when the drag started, in viewport coordinates. Hit-testing
 * uses this frozen copy, so the live preview reflowing under the pointer can't flip the target.
 */
export type FrozenGeometry = {
  panes: { id: string; rect: Rect; tabs: { index: number; rect: Rect }[] }[];
  headerHeight: number;
};

export type Drag = {
  groupId: string;
  projectId: string;
  payload: Payload;
  label: string;
  icon: TabKind | null;
  /** Names the window an edge drop creates, so preview and drop agree. */
  newPaneId: string;
  geometry: FrozenGeometry;
  target: DragTarget | null;
};

type DragState = {
  drag: Drag | null;
  /** Pointer position, kept apart so only the floating chip re-renders on every move. */
  pointer: { x: number; y: number };
  start: (d: Omit<Drag, "newPaneId" | "target">, x: number, y: number) => void;
  move: (x: number, y: number, target: DragTarget | null) => void;
  /** Ends the drag; applies it unless cancelled. */
  end: (apply: boolean) => void;
};

export const useDrag = create<DragState>((set, get) => ({
  drag: null,
  pointer: { x: 0, y: 0 },

  start: (d, x, y) => set({ drag: { ...d, newPaneId: uid("pane"), target: null }, pointer: { x, y } }),

  move: (x, y, target) => {
    const { drag } = get();
    if (!drag) return;
    const changed = JSON.stringify(target) !== JSON.stringify(drag.target);
    set(changed ? { pointer: { x, y }, drag: { ...drag, target } } : { pointer: { x, y } });
  },

  end: (apply) => {
    const { drag } = get();
    set({ drag: null });
    if (!apply || !drag?.target) return;
    const groups = useGroups.getState();
    const t = drag.target;
    if (t.kind === "layout") groups.drop(drag.groupId, drag.payload, t.target, drag.newPaneId);
    else if (t.kind === "group") groups.moveToGroup(drag.groupId, drag.payload, t.groupId);
    else groups.moveToNewGroup(drag.groupId, drag.payload);
  },
}));

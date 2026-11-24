import type { CSSProperties } from "react";
import { create } from "zustand";

/** Where a group wants one of its tabs drawn, relative to the group area. */
export type Placement = { paneId: string; style: CSSProperties; shown: boolean };

type TabLayerState = {
  /** Per group: where each of its tabs goes. Reported by the group's layout. */
  placements: Record<string, Record<string, Placement>>;
  /** Per group: whether moves animate (off while resizing by hand). */
  animate: Record<string, boolean>;
  /** The window under the pointer (its header buttons show). */
  hovered: { groupId: string; paneId: string } | null;
  report: (groupId: string, placements: Record<string, Placement>, animate: boolean) => void;
  setHovered: (hovered: { groupId: string; paneId: string } | null) => void;
};

/**
 * Tab contents live in one layer shared by all groups (so a tab moved to another group keeps
 * running); each group reports here where its tabs should appear.
 */
export const useTabLayer = create<TabLayerState>((set, get) => ({
  placements: {},
  animate: {},
  hovered: null,
  report: (groupId, placements, animate) => {
    const prev = get().placements[groupId];
    const same = prev && JSON.stringify(prev) === JSON.stringify(placements) && get().animate[groupId] === animate;
    if (!same) set({ placements: { ...get().placements, [groupId]: placements }, animate: { ...get().animate, [groupId]: animate } });
  },
  setHovered: (hovered) => {
    const h = get().hovered;
    if (h?.groupId !== hovered?.groupId || h?.paneId !== hovered?.paneId) set({ hovered });
  },
}));

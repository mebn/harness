import { create } from "zustand";
import { storage } from "@/lib/storage";

export type PanelKind = "files" | "changes" | "terminal" | "browser";

export const PANEL_KINDS: PanelKind[] = ["files", "changes", "terminal", "browser"];

const OPEN_KEY = "harness.panelOpen";
const ORDER_KEY = "harness.panelOrder";
const ACTIVE_KEY = "harness.panelActive";

/** Saved order, repaired so every tab appears exactly once (e.g. after new tabs ship). */
function loadOrder(): PanelKind[] {
  let saved: unknown;
  try {
    saved = JSON.parse(storage.get(ORDER_KEY) ?? "[]");
  } catch {
    saved = [];
  }
  const valid = (Array.isArray(saved) ? saved : []).filter((k): k is PanelKind => PANEL_KINDS.includes(k));
  const unique = [...new Set(valid)];
  return [...unique, ...PANEL_KINDS.filter((k) => !unique.includes(k))];
}

function loadActive(): PanelKind {
  const saved = storage.get(ACTIVE_KEY) as PanelKind | null;
  return saved && PANEL_KINDS.includes(saved) ? saved : "files";
}

type PanelState = {
  open: boolean;
  order: PanelKind[];
  active: PanelKind;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  activate: (kind: PanelKind) => void;
  /** Moves `kind` to sit at `index` in the tab order. */
  move: (kind: PanelKind, index: number) => void;
};

export const usePanel = create<PanelState>((set, get) => ({
  open: storage.get(OPEN_KEY) !== "false",
  order: loadOrder(),
  active: loadActive(),

  toggle: () => get().setOpen(!get().open),
  setOpen: (open) => {
    storage.set(OPEN_KEY, String(open));
    set({ open });
  },

  activate: (active) => {
    storage.set(ACTIVE_KEY, active);
    set({ active });
  },

  move: (kind, index) => {
    const order = get().order.filter((k) => k !== kind);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, kind);
    storage.set(ORDER_KEY, JSON.stringify(order));
    set({ order });
  },
}));

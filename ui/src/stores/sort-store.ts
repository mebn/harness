import { create } from "zustand";
import { storage } from "@/lib/storage";

/**
 * How the sidebar orders workspaces and their groups.
 * recent: latest activity first · status: finished turns first (then waiting, failed, working, idle)
 * name: alphabetical · manual: the order the user dragged groups into
 */
export type SortMode = "recent" | "status" | "name" | "manual";

export const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recent",
  status: "Status",
  name: "Name",
  manual: "Manual",
};

type Saved = {
  mode: SortMode;
  /** Manual order: workspace ids, and each workspace's group ids. Items not listed go first. */
  projects: string[];
  groups: Record<string, string[]>;
};

export type SortState = Saved & {
  setMode: (mode: SortMode) => void;
  /**
   * Saves a dragged order and switches to manual. `shown` is the order on screen before the
   * drag, so the rest of the sidebar stays exactly where it was.
   */
  setManual: (shown: { projects: string[]; groups: Record<string, string[]> }) => void;
};

const KEY = "harness.sidebar-sort";

function load(): Saved {
  try {
    const s = JSON.parse(storage.get(KEY) ?? "null");
    if (s && s.mode in SORT_LABELS) return { mode: s.mode, projects: s.projects ?? [], groups: s.groups ?? {} };
  } catch {
    // Fall through to the default.
  }
  return { mode: "recent", projects: [], groups: {} };
}

export const useSort = create<SortState>((set, get) => ({
  ...load(),
  setMode: (mode) => {
    set({ mode });
    save(get());
  },
  setManual: (shown) => {
    set({ mode: "manual", projects: shown.projects, groups: shown.groups });
    save(get());
  },
}));

function save({ mode, projects, groups }: Saved) {
  storage.set(KEY, JSON.stringify({ mode, projects, groups } satisfies Saved));
}

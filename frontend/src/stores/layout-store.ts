import { create } from "zustand";
import { storage } from "@/lib/storage";

const SIDEBAR_KEY = "harness.sidebarOpen";
const NOTICE_MS = 1800;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** A question shown in a dialog, answered yes (true) or no. */
export type Confirm = {
  title: string;
  message: string[];
  /** The confirm button's label. */
  action: string;
  resolve: (yes: boolean) => void;
};

type LayoutState = {
  /** The confirmation dialog on screen, if any. */
  confirm: Confirm | null;
  /** Asks a question in a dialog; resolves with the answer. */
  ask: (q: Omit<Confirm, "resolve">) => Promise<boolean>;
  /** Answers the open question. */
  answer: (yes: boolean) => void;
  sidebarOpen: boolean;
  searchOpen: boolean;
  /** The file finder ("files") or text search ("text"), or null when closed. */
  fileSearch: "files" | "text" | null;
  settingsOpen: boolean;
  /** Settings category to show when opened. */
  settingsCategory: string | undefined;
  /** The group whose name is being edited in the sidebar. */
  renamingGroup: string | null;
  /** True while ⌘/Ctrl is held on its own: the sidebar shows group numbers. */
  modHeld: boolean;
  /** A short message shown at the bottom of the window, cleared after a moment. */
  notice: string | null;
  notify: (message: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSearchOpen: (open: boolean) => void;
  setFileSearch: (mode: "files" | "text" | null) => void;
  setSettingsOpen: (open: boolean, category?: string) => void;
  setRenamingGroup: (id: string | null) => void;
  setModHeld: (held: boolean) => void;
};

export const useLayout = create<LayoutState>((set, get) => ({
  confirm: null,
  ask: (q) =>
    new Promise((resolve) => {
      // Only one question at a time: one already open is answered no.
      get().confirm?.resolve(false);
      set({ confirm: { ...q, resolve } });
    }),
  answer: (yes) => {
    const q = get().confirm;
    set({ confirm: null });
    q?.resolve(yes);
  },
  sidebarOpen: storage.get(SIDEBAR_KEY) !== "false",
  searchOpen: false,
  fileSearch: null,
  settingsOpen: false,
  settingsCategory: undefined,
  renamingGroup: null,
  modHeld: false,
  notice: null,
  notify: (notice) => {
    clearTimeout(noticeTimer);
    set({ notice });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  },
  setSidebarOpen: (sidebarOpen) => {
    storage.set(SIDEBAR_KEY, String(sidebarOpen));
    set({ sidebarOpen });
  },
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setFileSearch: (fileSearch) => set({ fileSearch }),
  setSettingsOpen: (settingsOpen, settingsCategory) => set({ settingsOpen, settingsCategory }),
  setRenamingGroup: (renamingGroup) => set({ renamingGroup }),
  setModHeld: (modHeld) => get().modHeld !== modHeld && set({ modHeld }),
}));

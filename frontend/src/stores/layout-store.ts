import { create } from "zustand";
import { storage } from "@/lib/storage";

const SIDEBAR_KEY = "harness.sidebarOpen";
const NOTICE_MS = 1800;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

type LayoutState = {
  sidebarOpen: boolean;
  searchOpen: boolean;
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
  setSettingsOpen: (open: boolean, category?: string) => void;
  setRenamingGroup: (id: string | null) => void;
  setModHeld: (held: boolean) => void;
};

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarOpen: storage.get(SIDEBAR_KEY) !== "false",
  searchOpen: false,
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
  setSettingsOpen: (settingsOpen, settingsCategory) => set({ settingsOpen, settingsCategory }),
  setRenamingGroup: (renamingGroup) => set({ renamingGroup }),
  setModHeld: (modHeld) => get().modHeld !== modHeld && set({ modHeld }),
}));

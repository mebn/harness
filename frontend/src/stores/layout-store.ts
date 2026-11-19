import { create } from "zustand";
import { storage } from "@/lib/storage";

const SIDEBAR_KEY = "harness.sidebarOpen";

type LayoutState = {
  sidebarOpen: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSearchOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
};

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarOpen: storage.get(SIDEBAR_KEY) !== "false",
  searchOpen: false,
  settingsOpen: false,
  setSidebarOpen: (sidebarOpen) => {
    storage.set(SIDEBAR_KEY, String(sidebarOpen));
    set({ sidebarOpen });
  },
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));

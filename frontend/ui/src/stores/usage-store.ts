import { create } from "zustand";
import { UsageService } from "@/lib/backend";
import type { Snapshot } from "@bindings/harness/server/internal/usage/models";

type UsageState = {
  snapshots: Record<string, Snapshot>;
  load: (provider: string) => Promise<void>;
  set: (snap: Snapshot) => void;
};

/** Last known plan usage per provider; updated by `usage:updated` events. */
export const useUsage = create<UsageState>((set, get) => ({
  snapshots: {},
  load: async (provider) => {
    const snap = await UsageService.Get(provider);
    if (snap) get().set(snap);
  },
  set: (snap) => set({ snapshots: { ...get().snapshots, [snap.provider]: snap } }),
}));

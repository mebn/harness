import { create } from "zustand";
import { SPLIT_STRATEGIES, type ContentKind, type SplitStrategy } from "@/lib/layout-tree";
import { storage } from "@/lib/storage";

const SPLIT_KEY = "harness.splitStrategy";
const FONT_KEY = "harness.fontSizes";

/** Text size per kind of tab: its default, range and step. Browser is a page zoom in percent. */
export const FONT_META: Record<ContentKind, { def: number; min: number; max: number; step: number; unit: "px" | "%" }> = {
  chat: { def: 14, min: 10, max: 24, step: 1, unit: "px" },
  terminal: { def: 12, min: 8, max: 28, step: 1, unit: "px" },
  changes: { def: 12, min: 9, max: 22, step: 1, unit: "px" },
  files: { def: 12, min: 9, max: 22, step: 1, unit: "px" },
  browser: { def: 100, min: 50, max: 200, step: 10, unit: "%" },
};

function loadStrategy(): SplitStrategy {
  const saved = storage.get(SPLIT_KEY);
  return SPLIT_STRATEGIES.some((s) => s.id === saved) ? (saved as SplitStrategy) : "dwindle";
}

function loadFontSizes(): Partial<Record<ContentKind, number>> {
  try {
    const data = JSON.parse(storage.get(FONT_KEY) ?? "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

type SettingsState = {
  /** How a new window is placed in a group. */
  splitStrategy: SplitStrategy;
  setSplitStrategy: (s: SplitStrategy) => void;
  /** Text sizes changed from their defaults. */
  fontSizes: Partial<Record<ContentKind, number>>;
  setFontSize: (kind: ContentKind, size: number) => void;
  /** Steps a kind's text size up (+1) or down (-1). */
  zoom: (kind: ContentKind, direction: 1 | -1) => void;
  resetFontSize: (kind?: ContentKind) => void;
};

export const useSettings = create<SettingsState>((set, get) => {
  const saveFonts = (fontSizes: SettingsState["fontSizes"]) => {
    storage.set(FONT_KEY, JSON.stringify(fontSizes));
    set({ fontSizes });
  };
  return {
    splitStrategy: loadStrategy(),
    setSplitStrategy: (splitStrategy) => {
      storage.set(SPLIT_KEY, splitStrategy);
      set({ splitStrategy });
    },

    fontSizes: loadFontSizes(),
    setFontSize: (kind, size) => {
      const { min, max, def } = FONT_META[kind];
      const clamped = Math.max(min, Math.min(max, Math.round(size)));
      const { [kind]: _, ...rest } = get().fontSizes;
      saveFonts(clamped === def ? rest : { ...rest, [kind]: clamped });
    },
    zoom: (kind, direction) => get().setFontSize(kind, fontSize(kind, get().fontSizes) + direction * FONT_META[kind].step),
    resetFontSize: (kind) => {
      if (!kind) return saveFonts({});
      const { [kind]: _, ...rest } = get().fontSizes;
      saveFonts(rest);
    },
  };
});

export function fontSize(kind: ContentKind, sizes = useSettings.getState().fontSizes): number {
  return sizes[kind] ?? FONT_META[kind].def;
}

export function useFontSize(kind: ContentKind): number {
  return useSettings((s) => fontSize(kind, s.fontSizes));
}

import { create } from "zustand";
import { SPLIT_STRATEGIES, type ContentKind, type SplitStrategy } from "@/lib/layout-tree";
import { storage } from "@/lib/storage";

const SPLIT_KEY = "harness.splitStrategy";
const FONT_KEY = "harness.fontSizes";
const SEND_KEY = "harness.sendWhileRunning";

/** What sending a message does while the agent is working: wait for the turn, or go in now. */
export type SendMode = "queue" | "steer";

type SizeMeta = {
  /** The size the content is designed at (scale 1). Scaled content is zoomed by size / base. */
  base: number;
  def: number;
  min: number;
  max: number;
  step: number;
  unit: "px" | "%";
};

/** Text size per kind of tab: its default, range and step. Browser is a page zoom in percent. */
export const FONT_META: Record<ContentKind, SizeMeta> = {
  chat: { base: 14, def: 15, min: 10, max: 24, step: 1, unit: "px" },
  terminal: { base: 12, def: 13, min: 8, max: 28, step: 1, unit: "px" },
  changes: { base: 12, def: 13, min: 9, max: 22, step: 1, unit: "px" },
  files: { base: 12, def: 13, min: 9, max: 22, step: 1, unit: "px" },
  browser: { base: 100, def: 110, min: 50, max: 200, step: 10, unit: "%" },
};

const UI_FONT_KEY = "harness.uiFontSize";

/** Text size of the app itself (sidebar, headers, menus, dialogs), in px of body text. */
export const UI_FONT_META: SizeMeta = { base: 14, def: 15, min: 11, max: 21, step: 1, unit: "px" };

/** How much the app UI is scaled from its designed size. Tab content divides it back out. */
export function uiScale(size = useSettings.getState().uiFontSize): number {
  return size / UI_FONT_META.base;
}

/** Everything in the UI is sized in rem, so scaling the root font size scales the whole app. */
function applyUiFontSize(size: number) {
  document.documentElement.style.fontSize = size === UI_FONT_META.base ? "" : `${(16 * size) / UI_FONT_META.base}px`;
}

function loadUiFontSize(): number {
  const n = Number(storage.get(UI_FONT_KEY));
  return Number.isFinite(n) && n >= UI_FONT_META.min && n <= UI_FONT_META.max ? Math.round(n) : UI_FONT_META.def;
}

/**
 * Text got one step bigger everywhere. Defaults moved up with it; sizes someone had already
 * changed move up one step here, once.
 */
const SIZES_BUMPED_KEY = "harness.fontSizesBumped";
function bumpSavedSizesOnce() {
  if (storage.get(SIZES_BUMPED_KEY)) return;
  storage.set(SIZES_BUMPED_KEY, "1");
  const ui = Number(storage.get(UI_FONT_KEY));
  if (ui) storage.set(UI_FONT_KEY, String(Math.min(UI_FONT_META.max, ui + UI_FONT_META.step)));
  try {
    const saved = JSON.parse(storage.get(FONT_KEY) ?? "{}") as Partial<Record<ContentKind, number>>;
    const bumped: Partial<Record<ContentKind, number>> = {};
    for (const [kind, size] of Object.entries(saved) as [ContentKind, number][]) {
      const meta = FONT_META[kind];
      if (!meta || typeof size !== "number") continue;
      const next = Math.min(meta.max, size + meta.step);
      if (next !== meta.def) bumped[kind] = next;
    }
    storage.set(FONT_KEY, JSON.stringify(bumped));
  } catch {
    /* unreadable: keep defaults */
  }
}
bumpSavedSizesOnce();

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
  /** What Enter does while a turn runs; Alt+Enter does the other. */
  sendWhileRunning: SendMode;
  setSendWhileRunning: (mode: SendMode) => void;
  /** How a new window is placed in a group. */
  splitStrategy: SplitStrategy;
  setSplitStrategy: (s: SplitStrategy) => void;
  /** Text sizes changed from their defaults. */
  fontSizes: Partial<Record<ContentKind, number>>;
  setFontSize: (kind: ContentKind, size: number) => void;
  /** Steps a kind's text size up (+1) or down (-1). */
  zoom: (kind: ContentKind, direction: 1 | -1) => void;
  resetFontSize: (kind?: ContentKind) => void;
  /** Text size of the app UI itself. */
  uiFontSize: number;
  setUiFontSize: (size: number) => void;
};

const initialUiFontSize = loadUiFontSize();
applyUiFontSize(initialUiFontSize);

export const useSettings = create<SettingsState>((set, get) => {
  const saveFonts = (fontSizes: SettingsState["fontSizes"]) => {
    storage.set(FONT_KEY, JSON.stringify(fontSizes));
    set({ fontSizes });
  };
  return {
    sendWhileRunning: storage.get(SEND_KEY) === "queue" ? "queue" : "steer",
    setSendWhileRunning: (sendWhileRunning) => {
      storage.set(SEND_KEY, sendWhileRunning);
      set({ sendWhileRunning });
    },

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

    uiFontSize: initialUiFontSize,
    setUiFontSize: (size) => {
      const { min, max, def } = UI_FONT_META;
      const uiFontSize = Math.max(min, Math.min(max, Math.round(size)));
      if (uiFontSize === def) storage.remove(UI_FONT_KEY);
      else storage.set(UI_FONT_KEY, String(uiFontSize));
      applyUiFontSize(uiFontSize);
      set({ uiFontSize });
    },
  };
});

export function fontSize(kind: ContentKind, sizes = useSettings.getState().fontSizes): number {
  return sizes[kind] ?? FONT_META[kind].def;
}

export function useFontSize(kind: ContentKind): number {
  return useSettings((s) => fontSize(kind, s.fontSizes));
}

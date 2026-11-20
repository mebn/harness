// Every keyboard shortcut, in one table: the hotkey handler, tooltips, the command palette and
// the shortcuts list all read from here.
//
// Conventions:
// - macOS uses ⌘. Windows/Linux use Ctrl, but most letter keys add Shift (Ctrl+Shift+T) because
//   terminals need plain Ctrl+letter (Ctrl+C interrupts...). Close tab/window are the exception:
//   Ctrl+W / Ctrl+Shift+W, as in browsers (so Ctrl+W no longer reaches the shell).
// - Keys are matched by physical position (`code`), so they work on any keyboard layout.
// - No bracket/backslash keys and no bare Ctrl+Alt+letter: on many layouts (e.g. Swedish)
//   those type characters via AltGr.

import { create } from "zustand";
import { storage } from "./storage";

export const isMac = navigator.platform.toLowerCase().includes("mac");

/**
 * A key binding. Usually matched by physical key (`code`); with `key` it is matched by the
 * character typed instead (for + and −, which sit on different keys per layout), ignoring Shift.
 */
export type Combo = { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; code: string; key?: string };

export type ShortcutId =
  | "newWindow"
  | "newTab"
  | "newGroup"
  | "splitRight"
  | "splitDown"
  | "maximize"
  | "closeTab"
  | "closeWindow"
  | "nextTab"
  | "prevTab"
  | "focusLeft"
  | "focusRight"
  | "focusUp"
  | "focusDown"
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"
  | "goToGroup"
  | "nextGroup"
  | "prevGroup"
  | "renameGroup"
  | "search"
  | "toggleSidebar"
  | "settings"
  | "shortcuts"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export type Shortcut = {
  id: ShortcutId;
  label: string;
  section: string;
  combos: Combo[];
  /** A numbered family (go to group 1–9): one combo per digit, edited as one. */
  numbered?: boolean;
};

type Mods = Omit<Combo, "code" | "meta" | "ctrl"> & { mod?: boolean; ctrl?: boolean };

/** `mod` is ⌘ on macOS and Ctrl elsewhere. */
function key(code: string, mods: Mods = {}): Combo {
  const { mod, ctrl, ...rest } = mods;
  return isMac ? { ...rest, meta: mod, ctrl, code } : { ...rest, ctrl: mod || ctrl, code };
}

/** A letter shortcut: ⌘X on macOS, Ctrl+Shift+X elsewhere. `second` adds ⇧ / Alt for a related action. */
function letter(code: string, second = false): Combo {
  return isMac ? { meta: true, shift: second, code } : { ctrl: true, shift: true, alt: second, code };
}

const ARROWS = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" } as const;

export const SHORTCUTS: Shortcut[] = [
  { id: "newWindow", section: "Windows", label: "New window (then 1–5 to fill it)", combos: [key("Enter", { mod: true })] },
  { id: "newTab", section: "Windows", label: "New tab in window", combos: [letter("KeyT")] },
  { id: "splitRight", section: "Windows", label: "Split right", combos: [letter("KeyD")] },
  { id: "splitDown", section: "Windows", label: "Split down", combos: [letter("KeyD", true)] },
  { id: "maximize", section: "Windows", label: "Maximize / restore window", combos: [key("Enter", { mod: true, shift: true })] },
  { id: "closeTab", section: "Windows", label: "Close tab (or the window, if empty)", combos: [key("KeyW", { mod: true })] },
  { id: "closeWindow", section: "Windows", label: "Close window", combos: [key("KeyW", { mod: true, shift: true })] },
  { id: "nextTab", section: "Windows", label: "Next tab", combos: [key("Tab", { ctrl: true })] },
  { id: "prevTab", section: "Windows", label: "Previous tab", combos: [key("Tab", { ctrl: true, shift: true })] },
  ...(["Left", "Right", "Up", "Down"] as const).map((d) => ({
    id: `focus${d}` as ShortcutId,
    section: "Windows",
    label: `Focus window ${d.toLowerCase()}`,
    combos: [key(ARROWS[d], { mod: true, alt: true })],
  })),
  ...(["Left", "Right", "Up", "Down"] as const).map((d) => ({
    id: `move${d}` as ShortcutId,
    section: "Windows",
    label: `Move tab ${d.toLowerCase()}`,
    combos: [key(ARROWS[d], { mod: true, alt: true, shift: true })],
  })),

  { id: "newGroup", section: "Groups", label: "New group", combos: [letter("KeyN")] },
  {
    id: "goToGroup",
    section: "Groups",
    label: "Go to group 1–9",
    numbered: true,
    combos: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(`Digit${n}`, { mod: true })),
  },
  { id: "nextGroup", section: "Groups", label: "Next group", combos: [key("PageDown", { mod: true })] },
  { id: "prevGroup", section: "Groups", label: "Previous group", combos: [key("PageUp", { mod: true })] },
  { id: "renameGroup", section: "Groups", label: "Rename group", combos: [{ code: "F2" }] },

  {
    id: "zoomIn",
    section: "Text size",
    label: "Larger text in the focused tab",
    combos: [
      { ...key("", { mod: true }), key: "+" },
      { ...key("", { mod: true }), key: "=" },
      key("NumpadAdd", { mod: true }),
    ],
  },
  {
    id: "zoomOut",
    section: "Text size",
    label: "Smaller text in the focused tab",
    combos: [{ ...key("", { mod: true }), key: "-" }, key("NumpadSubtract", { mod: true })],
  },
  {
    id: "zoomReset",
    section: "Text size",
    label: "Reset text size of the focused tab",
    combos: [key("Digit0", { mod: true }), key("Numpad0", { mod: true })],
  },

  { id: "search", section: "App", label: "Search", combos: [key("KeyK", { mod: true })] },
  { id: "toggleSidebar", section: "App", label: "Toggle sidebar", combos: [isMac ? { meta: true, code: "KeyB" } : { ctrl: true, code: "KeyB" }] },
  { id: "settings", section: "App", label: "Settings", combos: [key("Comma", { mod: true })] },
  { id: "shortcuts", section: "App", label: "Keyboard shortcuts", combos: [{ code: "F1" }] },
];

// ---- user overrides ----

const OVERRIDES_KEY = "harness.shortcuts";

function loadOverrides(): Partial<Record<ShortcutId, Combo[]>> {
  try {
    const data = JSON.parse(storage.get(OVERRIDES_KEY) ?? "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

type ShortcutState = {
  /** Bindings changed in Settings; an empty list means unbound. */
  overrides: Partial<Record<ShortcutId, Combo[]>>;
  /** True while Settings is recording a new binding (global shortcuts pause). */
  recording: boolean;
  setRecording: (recording: boolean) => void;
  /** Binds a shortcut; for a numbered family, `combo` gives the modifiers and digits 1–9 follow. */
  set: (id: ShortcutId, combo: Combo | null) => void;
  reset: (id?: ShortcutId) => void;
};

export const useShortcuts = create<ShortcutState>((set, get) => {
  const save = (overrides: ShortcutState["overrides"]) => {
    storage.set(OVERRIDES_KEY, JSON.stringify(overrides));
    set({ overrides });
  };
  return {
    overrides: loadOverrides(),
    recording: false,
    setRecording: (recording) => set({ recording }),
    set: (id, combo) => {
      const def = SHORTCUTS.find((s) => s.id === id);
      const combos = !combo
        ? []
        : def?.numbered
          ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ ...combo, code: `Digit${n}` }))
          : [combo];
      save({ ...get().overrides, [id]: combos });
    },
    reset: (id) => {
      if (!id) return save({});
      const { [id]: _, ...rest } = get().overrides;
      save(rest);
    },
  };
});

/** The bindings in effect for a shortcut (defaults unless changed in Settings). */
export function combosFor(id: ShortcutId, overrides = useShortcuts.getState().overrides): Combo[] {
  return overrides[id] ?? SHORTCUTS.find((s) => s.id === id)?.combos ?? [];
}

export function isCustomized(id: ShortcutId, overrides = useShortcuts.getState().overrides): boolean {
  return overrides[id] !== undefined;
}

export function sameCombo(a: Combo, b: Combo): boolean {
  return a.code === b.code && a.key === b.key && !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/** Other shortcuts already bound to any of these combos. */
export function conflictsWith(id: ShortcutId, combos: Combo[], overrides = useShortcuts.getState().overrides): Shortcut[] {
  return SHORTCUTS.filter(
    (s) => s.id !== id && combosFor(s.id, overrides).some((c) => combos.some((x) => sameCombo(c, x))),
  );
}

/** A key event as a binding, or null for a bare modifier press. */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  if (["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(e.key)) return null;
  const combo: Combo = { code: e.code };
  if (e.metaKey) combo.meta = true;
  if (e.ctrlKey) combo.ctrl = true;
  if (e.shiftKey) combo.shift = true;
  if (e.altKey) combo.alt = true;
  return combo;
}

export function matches(e: KeyboardEvent, c: Combo): boolean {
  const mods = e.metaKey === !!c.meta && e.ctrlKey === !!c.ctrl && e.altKey === !!c.alt;
  if (c.key) return mods && e.key === c.key; // the typed character decides; Shift may be needed to type it
  return mods && e.code === c.code && e.shiftKey === !!c.shift;
}

/** The shortcut a key event triggers, with which of its combos matched (e.g. the group number). */
export function findShortcut(e: KeyboardEvent): { id: ShortcutId; index: number } | undefined {
  const { overrides } = useShortcuts.getState();
  for (const s of SHORTCUTS) {
    const index = combosFor(s.id, overrides).findIndex((c) => matches(e, c));
    if (index !== -1) return { id: s.id, index };
  }
  return undefined;
}

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  Enter: ["↵", "Enter"],
  Tab: ["⇥", "Tab"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  PageDown: ["PgDn", "PgDn"],
  PageUp: ["PgUp", "PgUp"],
  Comma: [",", ","],
  NumpadAdd: ["Num+", "Num+"],
  NumpadSubtract: ["Num−", "Num−"],
  Numpad0: ["Num0", "Num0"],
};

function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code][isMac ? 0 : 1];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function formatCombo(c: Combo): string {
  const k = c.key ?? keyLabel(c.code);
  if (isMac) return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${k}`;
  // Joined with spaces when the key itself is "+", so "Ctrl +" stays readable.
  const parts = [c.ctrl && "Ctrl", c.shift && "Shift", c.alt && "Alt", k].filter(Boolean);
  return parts.join(k === "+" ? " " : "+");
}

/** How a shortcut is shown ("" when unbound); a numbered family shows as a range ("⌘1…9"). */
export function shortcutLabel(id: ShortcutId, overrides = useShortcuts.getState().overrides): string {
  const combos = combosFor(id, overrides);
  if (combos.length === 0) return "";
  const numbered = SHORTCUTS.find((s) => s.id === id)?.numbered;
  if (numbered && combos.length > 1) return `${formatCombo(combos[0])}…${keyLabel(combos[combos.length - 1].code)}`;
  return formatCombo(combos[0]); // alternates (e.g. numpad keys) are not listed
}

/** Re-renders with current bindings; use in components that show shortcut labels. */
export function useShortcutLabel(id: ShortcutId): string {
  const overrides = useShortcuts((s) => s.overrides);
  return shortcutLabel(id, overrides);
}

/** The modifier shown in hints ("⌘" or "Ctrl"). */
export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

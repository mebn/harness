import { create } from "zustand";
import { storage } from "@/lib/storage";

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "harness.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(pref: ThemePref): Theme {
  if (pref === "system") return media.matches ? "dark" : "light";
  return pref;
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

type ThemeState = {
  pref: ThemePref;
  theme: Theme;
  setPref: (pref: ThemePref) => void;
};

const initialPref = (storage.get(KEY) as ThemePref | null) ?? "light";

export const useTheme = create<ThemeState>((set) => ({
  pref: initialPref,
  theme: resolve(initialPref),
  setPref: (pref) => {
    storage.set(KEY, pref);
    const theme = resolve(pref);
    apply(theme);
    set({ pref, theme });
  },
}));

// Apply before first paint and follow OS changes when set to "system".
apply(useTheme.getState().theme);
media.addEventListener("change", () => {
  const { pref } = useTheme.getState();
  if (pref === "system") {
    const theme = resolve(pref);
    apply(theme);
    useTheme.setState({ theme });
  }
});

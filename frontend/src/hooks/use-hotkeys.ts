import { useEffect } from "react";
import { useLayout } from "@/stores/layout-store";

/** Global shortcuts. Capture phase so they work even when the terminal has focus. */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        const { searchOpen, setSearchOpen } = useLayout.getState();
        setSearchOpen(!searchOpen);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

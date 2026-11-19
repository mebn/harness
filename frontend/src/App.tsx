import { useEffect } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { WindowControls } from "@/components/layout/window-controls";
import { DragOverlay } from "@/components/workspace/drag-overlay";
import { SearchDialog } from "@/components/search/search-dialog";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBackendEvents } from "@/hooks/use-backend-events";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";

export default function App() {
  const init = useApp((s) => s.init);
  const ready = useApp((s) => s.ready);
  const settingsOpen = useLayout((s) => s.settingsOpen);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const settingsCategory = useLayout((s) => s.settingsCategory);
  useBackendEvents();
  useHotkeys();

  useEffect(() => {
    void init();
  }, [init]);

  // Dropping a file outside the chat box must not navigate the webview to it.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  if (!ready) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <AppShell />
      <WindowControls />
      <SearchDialog />
      <SettingsDialog open={settingsOpen} onOpenChange={(open) => setSettingsOpen(open)} initial={settingsCategory} />
      <Notice />
      <DragOverlay />
    </TooltipProvider>
  );
}

/** Brief messages such as "No room for another window". */
function Notice() {
  const notice = useLayout((s) => s.notice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-popover/95 px-4 py-1.5 text-xs text-popover-foreground shadow-lg backdrop-blur-xl animate-in fade-in-0 slide-in-from-bottom-2 duration-150"
    >
      {notice}
    </div>
  );
}

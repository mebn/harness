import { useEffect } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { WindowControls } from "@/components/layout/window-controls";
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
  useBackendEvents();
  useHotkeys();

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <AppShell />
      <WindowControls />
      <SearchDialog />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  );
}

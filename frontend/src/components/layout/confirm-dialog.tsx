import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { findShortcut } from "@/lib/shortcuts";
import { useLayout } from "@/stores/layout-store";

/** Asks before something is closed. Pressing the close shortcut again answers yes. */
export function ConfirmDialog() {
  const confirm = useLayout((s) => s.confirm);
  const answer = useLayout((s) => s.answer);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      const hit = findShortcut(e);
      // A held key repeating doesn't count: the press that opened this would answer it.
      if (e.repeat || (hit?.id !== "closeTab" && hit?.id !== "closeWindow")) return;
      e.preventDefault();
      e.stopPropagation();
      answer(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirm, answer]);

  return (
    <Dialog open={!!confirm} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent showCloseButton={false} className="gap-5 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1">
              {confirm?.message.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="destructive" autoFocus onClick={() => answer(true)}>
            {confirm?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

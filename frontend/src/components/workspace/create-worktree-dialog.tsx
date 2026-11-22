import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { GitService } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLayout } from "@/stores/layout-store";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Asks for a name and creates a Claude Code worktree (.claude/worktrees/<name>, branch worktree-<name>). */
export function CreateWorktreeDialog({
  open,
  projectId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  const valid = NAME.test(name.trim());
  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const w = await GitService.CreateWorktree(projectId, name.trim());
      onOpenChange(false);
      onCreated(w.name);
      useLayout.getState().notify(`Created worktree ${w.name} on ${w.branch}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            A separate checkout in <code>.claude/worktrees/{name.trim() || "<name>"}</code> on a new branch{" "}
            <code>worktree-{name.trim() || "<name>"}</code>, starting from the current commit. This group's chats,
            terminals and files then work there.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          placeholder="e.g. fix-login"
          aria-invalid={!!name && !valid}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        {name && !valid && <p className="text-xs text-destructive">Use letters, digits, '.', '_' or '-' (no spaces).</p>}
        {error && <p className="text-xs whitespace-pre-wrap text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void create()}>
            {busy && <Loader2 className="animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

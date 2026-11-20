import { useEffect, useState } from "react";
import { Check, FolderGit2, GitBranch, Loader2, Plus } from "lucide-react";
import { GitService, type Worktree } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useGit } from "@/stores/git-store";
import { useGroups, type Group } from "@/stores/group-store";
import { useLayout } from "@/stores/layout-store";
import { noDragStyle } from "@/components/layout/window-controls";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Where the group works: the workspace folder or one of its Claude Code worktrees
 * (.claude/worktrees/<name> on branch worktree-<name>, as `claude --worktree` makes them).
 */
export function WorktreePicker({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [list, setList] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const branch = useGit((s) => s.statuses[group.projectId]?.branch);

  // The workspace's own branch, for the label when no worktree is chosen.
  useEffect(() => {
    if (!group.worktree) void useGit.getState().refresh(group.projectId);
  }, [group.projectId, group.worktree]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    GitService.Worktrees(group.projectId)
      .then((l) => setList(l ?? []))
      .catch((e) => {
        setList([]);
        setError(String(e));
      });
  }, [open, group.projectId]);

  const choose = (name: string | undefined) => void useGroups.getState().setWorktree(group.id, name);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            style={noDragStyle}
            title="Worktree"
            className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          >
            {group.worktree ? <FolderGit2 className="size-3.5 shrink-0" /> : <GitBranch className="size-3.5 shrink-0" />}
            <span className="truncate">{group.worktree ?? branch ?? "Workspace folder"}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={() => choose(undefined)}>
            <GitBranch />
            <span className="min-w-0 flex-1 truncate">Workspace folder{branch ? ` (${branch})` : ""}</span>
            {!group.worktree && <Check className="ml-auto" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Worktrees</DropdownMenuLabel>
          {list === null ? (
            <div className="flex justify-center py-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            </div>
          ) : list.length === 0 ? (
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">{error ?? "None yet"}</p>
          ) : (
            list.map((w) => (
              <DropdownMenuItem key={w.name} onSelect={() => choose(w.name)}>
                <FolderGit2 />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{w.name}</span>
                  {w.branch && <span className="truncate text-[11px] text-muted-foreground">{w.branch}</span>}
                </span>
                {group.worktree === w.name && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus /> New worktree…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorktreeDialog
        open={creating}
        projectId={group.projectId}
        onOpenChange={setCreating}
        onCreated={(name) => choose(name)}
      />
    </>
  );
}

function CreateWorktreeDialog({
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

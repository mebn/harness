import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, FolderGit2, GitBranch, Loader2, Plus, Search } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { CreateWorktreeDialog } from "@/components/workspace/create-worktree-dialog";
import { GitService, type GitBranch as Branch, type Session, type Worktree } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useGitStatus } from "@/stores/git-store";
import { useGroups } from "@/stores/group-store";
import { tabsOf } from "@/lib/layout-tree";
import { useLayout } from "@/stores/layout-store";

/**
 * Where this chat works, in one button: the worktree (or the workspace folder) and the branch
 * checked out there. Hidden outside git repositories.
 */
export function LocationPicker({ session, visible }: { session: Session; visible: boolean }) {
  const worktree = session.worktree || undefined;
  const { status, error, refresh } = useGitStatus(session.projectId, visible, worktree);
  // Any agent working in this folder (this chat or another) would have files change under it.
  const running = useApp((s) =>
    s.tree.some(
      (n) =>
        n.project.id === session.projectId &&
        (n.sessions ?? []).some((x) => (x.worktree || "") === (session.worktree || "") && s.running[x.id]),
    ),
  );
  const group = useGroups((s) => s.groups.find((g) => tabsOf(g.root).some((t) => t.sessionId === session.id)));

  const [open, setOpen] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = () => {
    GitService.Worktrees(session.projectId)
      .then((l) => setWorktrees(l ?? []))
      .catch(() => setWorktrees([]));
    GitService.Branches(session.projectId, worktree ?? "")
      .then((l) => setBranches(l ?? []))
      .catch((e) => {
        setBranches([]);
        setProblem(String(e));
      });
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setProblem(null);
    setBranches(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.projectId, worktree]);

  const q = query.trim();
  const shown = useMemo(
    () => (branches ?? []).filter((b) => b.name.toLowerCase().includes(q.toLowerCase())),
    [branches, q],
  );
  const exact = branches?.some((b) => b.name === q);

  if (!status && error) return null; // not a git repository

  // The chat's folder is fixed once it has started: the CLI resumes sessions per folder.
  const worktreeLocked = session.started;
  const branchLocked = running;

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setProblem(null);
    try {
      await fn();
      await refresh();
      load();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(null);
    }
  };
  const switchTo = (name: string) =>
    act(name, async () => {
      await GitService.SwitchBranch(session.projectId, worktree ?? "", name);
      useLayout.getState().notify(`Switched to ${name}`);
    });
  const createBranch = (name: string) =>
    act(name, async () => {
      await GitService.CreateBranch(session.projectId, worktree ?? "", name);
      setQuery("");
      useLayout.getState().notify(`Created and switched to ${name}`);
    });
  const chooseWorktree = (name: string | undefined) => {
    if (group) void useGroups.getState().setWorktree(group.id, name);
  };

  return (
    <>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          title="Worktree and branch"
          className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {worktree ? <FolderGit2 className="size-3.5 shrink-0" /> : <GitBranch className="size-3.5 shrink-0" />}
          <span className="truncate">
            {worktree && <span>{worktree} · </span>}
            {status?.branch || "detached"}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-80 flex-col overflow-hidden rounded-xl border bg-popover text-xs text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
          >
            {/* Worktree */}
            <div className="border-b p-1">
              <SectionLabel>Worktree</SectionLabel>
              {worktreeLocked && (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">
                  This chat stays in the folder it started in. Start a new chat to work in another worktree.
                </p>
              )}
              <Row disabled={worktreeLocked} selected={!worktree} onClick={() => chooseWorktree(undefined)}>
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">Workspace folder</span>
              </Row>
              {worktrees === null ? (
                <Spinner />
              ) : (
                worktrees.map((w) => (
                  <Row key={w.name} disabled={worktreeLocked} selected={worktree === w.name} onClick={() => chooseWorktree(w.name)}>
                    <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{w.name}</span>
                    {w.branch && <span className="truncate text-muted-foreground">{w.branch}</span>}
                  </Row>
                ))
              )}
              <Row disabled={worktreeLocked} onClick={() => setCreatingWorktree(true)}>
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span>New worktree…</span>
              </Row>
            </div>

            {/* Branch */}
            <div className="flex min-h-0 flex-1 flex-col p-1">
              <SectionLabel>Branch{worktree ? ` in ${worktree}` : ""}</SectionLabel>
              {branchLocked && (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">An agent is working in this folder; switch once it finishes.</p>
              )}
              <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border px-2">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || branchLocked || busy) return;
                    e.preventDefault();
                    const target = shown.find((b) => !b.current && !b.worktree);
                    if (q && !exact) void createBranch(q);
                    else if (target) void switchTo(target.name);
                  }}
                  placeholder="Find or create a branch…"
                  className="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {branches === null ? (
                  <Spinner />
                ) : (
                  shown.map((b) => (
                    <Row
                      key={b.name}
                      selected={b.current}
                      disabled={branchLocked || !!busy || b.current || !!b.worktree}
                      title={b.worktree ? `Checked out in ${b.worktree}` : undefined}
                      onClick={() => void switchTo(b.name)}
                    >
                      <span className="truncate">{b.name}</span>
                      {b.worktree && <span className="shrink-0 text-muted-foreground">in another worktree</span>}
                      {busy === b.name && <Loader2 className="size-3 shrink-0 animate-spin" />}
                    </Row>
                  ))
                )}
                {q && !exact && (
                  <Row disabled={branchLocked || !!busy} onClick={() => void createBranch(q)}>
                    <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      Create <span className="font-medium">{q}</span> from current commit
                    </span>
                    {busy === q && <Loader2 className="size-3 shrink-0 animate-spin" />}
                  </Row>
                )}
              </div>
              {problem && <p className="mx-2 mt-1 mb-0.5 text-[11px] whitespace-pre-wrap text-destructive">{problem}</p>}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <CreateWorktreeDialog
        open={creatingWorktree}
        projectId={session.projectId}
        onOpenChange={setCreatingWorktree}
        onCreated={(name) => chooseWorktree(name)}
      />
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">{children}</div>;
}

function Spinner() {
  return (
    <div className="flex justify-center py-2">
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    </div>
  );
}

function Row({
  children,
  selected,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent disabled:hover:bg-transparent",
        disabled && !selected && "opacity-50",
      )}
    >
      {children}
      <span className="flex-1" />
      {selected && <Check className="size-3.5 shrink-0" />}
    </button>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronRight, GitBranch, Loader2, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GitService, type GitFile, type GitStatus } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useGitStatus } from "@/stores/git-store";

const STATUS_STYLE: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
  "!": "text-red-600 dark:text-red-400",
};

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  "?": "Untracked",
  D: "Deleted",
  R: "Renamed",
  "!": "Conflict",
};

/** Asks before throwing away work; `files` are the unstaged entries to discard. */
type DiscardRequest = { files: GitFile[] };

/** Runs a git action, then refreshes; failures show above the file list. */
type Run = (fn: () => Promise<unknown>) => Promise<void>;

/**
 * Working-tree changes for a project (or one of its worktrees), laid out like VS Code's
 * Source Control: a commit box, then staged and unstaged changes with per-file and
 * section-wide stage, unstage and discard.
 */
export function GitChanges({ projectId, worktree = "", active }: { projectId: string; worktree?: string; active: boolean }) {
  const project = useApp((s) => s.tree.find((n) => n.project.id === projectId)?.project);
  const { status, error, refresh } = useGitStatus(project?.id, active, worktree);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<DiscardRequest | null>(null);

  if (!project) return <Centered>No project</Centered>;
  if (!status) return <Centered>{error ?? <Loader2 className="size-4 animate-spin" />}</Centered>;
  if (!status.isRepo) return <Centered>Not a git repository</Centered>;

  const files = status.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);

  const run: Run = async (fn) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const ctx: RowContext = {
    projectId: project.id,
    worktree,
    busy,
    stage: (f) => void run(() => GitService.Stage(project.id, worktree, [f.path])),
    unstage: (f) => void run(() => GitService.Unstage(project.id, worktree, f.oldPath ? [f.path, f.oldPath] : [f.path])),
    discard: (f) => setDiscard({ files: [f] }),
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-3 text-xs">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">{status.branch}</span>
        {status.behind > 0 && <span className="text-muted-foreground">↓{status.behind}</span>}
        <span className="flex-1" />
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <IconButton label="Refresh" onClick={() => void refresh()}>
          <RefreshCw />
        </IconButton>
      </div>

      <CommitBox projectId={project.id} worktree={worktree} status={status} stagedCount={staged.length} run={run} busy={busy} />

      {actionError && (
        <p className="mx-2 mb-2 max-h-24 shrink-0 overflow-auto rounded-md bg-destructive/10 px-2 py-1.5 text-xs whitespace-pre-wrap text-destructive select-text">
          {actionError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {files.length === 0 ? (
          <Centered>No changes</Centered>
        ) : (
          <>
            {staged.length > 0 && (
              <Section
                title="Staged Changes"
                files={staged}
                ctx={ctx}
                actions={
                  <RowAction label="Unstage all" disabled={busy} onClick={() => void run(() => GitService.Unstage(project.id, worktree, null))}>
                    <Minus />
                  </RowAction>
                }
              />
            )}
            {unstaged.length > 0 && (
              <Section
                title="Changes"
                files={unstaged}
                ctx={ctx}
                actions={
                  <>
                    <RowAction label="Discard all changes" disabled={busy} onClick={() => setDiscard({ files: unstaged })}>
                      <Undo2 />
                    </RowAction>
                    <RowAction label="Stage all changes" disabled={busy} onClick={() => void run(() => GitService.Stage(project.id, worktree, null))}>
                      <Plus />
                    </RowAction>
                  </>
                }
              />
            )}
          </>
        )}
      </div>

      <ConfirmDiscard
        request={discard}
        onCancel={() => setDiscard(null)}
        onConfirm={(req) => {
          setDiscard(null);
          void run(() => GitService.Discard(project.id, worktree, req.files));
        }}
      />
    </div>
  );
}

type RowContext = {
  projectId: string;
  worktree: string;
  busy: boolean;
  stage: (f: GitFile) => void;
  unstage: (f: GitFile) => void;
  discard: (f: GitFile) => void;
};

function Section({ title, files, ctx, actions }: { title: string; files: GitFile[]; ctx: RowContext; actions: ReactNode }) {
  const [open, setOpen] = useState(true);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="mt-1">
      <div
        role="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex h-7 cursor-default items-center gap-1 pr-2 pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{title}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 group-hover:hidden">
          <LineCounts added={added} removed={removed} />
        </span>
        <span className="hidden items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
        <span className="ml-1 min-w-5 rounded-full bg-foreground/[0.08] px-1.5 text-center text-[10px] font-medium tabular-nums">
          {files.length}
        </span>
      </div>
      {open && files.map((f) => <FileRow key={`${f.staged}:${f.path}`} file={f} ctx={ctx} />)}
    </div>
  );
}

function FileRow({ file, ctx }: { file: GitFile; ctx: RowContext }) {
  const [open, setOpen] = useState(false);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash >= 0 ? file.path.slice(0, slash) : "";
  const letter = file.status === "?" ? "U" : file.status;

  return (
    <div>
      <div
        role="button"
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => (file.staged ? ctx.unstage(file) : ctx.stage(file))}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className={cn("group flex h-7 cursor-default items-center gap-1.5 pr-2 pl-5 text-xs hover:bg-accent/60", open && "bg-accent/40")}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className={cn("shrink-0 truncate", file.status === "D" && "line-through opacity-70")}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>

        <span className="flex shrink-0 items-center group-hover:hidden">
          {file.binary ? <span className="text-[11px] text-muted-foreground">bin</span> : <LineCounts added={file.added} removed={file.removed} />}
        </span>
        <span className="hidden shrink-0 items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
          {file.staged ? (
            <RowAction label="Unstage" disabled={ctx.busy} onClick={() => ctx.unstage(file)}>
              <Minus />
            </RowAction>
          ) : (
            <>
              <RowAction label={file.status === "?" ? "Delete file" : "Discard changes"} disabled={ctx.busy} onClick={() => ctx.discard(file)}>
                <Undo2 />
              </RowAction>
              <RowAction label={file.status === "!" ? "Mark resolved" : "Stage"} disabled={ctx.busy} onClick={() => ctx.stage(file)}>
                {file.status === "!" ? <Check /> : <Plus />}
              </RowAction>
            </>
          )}
        </span>
        <span title={STATUS_LABEL[file.status]} className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", STATUS_STYLE[file.status])}>
          {letter}
        </span>
      </div>
      {open && <DiffView projectId={ctx.projectId} worktree={ctx.worktree} file={file} />}
    </div>
  );
}

/** A small hover action on a row; its tooltip names it. */
function RowAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ConfirmDiscard({
  request,
  onCancel,
  onConfirm,
}: {
  request: DiscardRequest | null;
  onCancel: () => void;
  onConfirm: (req: DiscardRequest) => void;
}) {
  const files = request?.files ?? [];
  const untracked = files.filter((f) => f.status === "?").length;
  const single = files.length === 1 ? files[0] : null;
  const title = single
    ? single.status === "?"
      ? `Delete ${single.path}?`
      : `Discard changes in ${single.path}?`
    : `Discard all ${files.length} changes?`;
  const description =
    untracked > 0
      ? `${single ? "This untracked file" : untracked === 1 ? "1 untracked file" : `${untracked} untracked files`} will be deleted. This can't be undone.`
      : "Your unstaged edits will be lost. This can't be undone.";

  return (
    <Dialog open={request !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm break-all">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" autoFocus onClick={() => request && onConfirm(request)}>
            {single?.status === "?" ? "Delete" : "Discard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[11px]">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      <span className="text-red-600 dark:text-red-400">-{removed}</span>
    </span>
  );
}

function DiffView({ projectId, worktree, file }: { projectId: string; worktree: string; file: GitFile }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    GitService.Diff(projectId, worktree, file)
      .then(setDiff)
      .catch((e) => setDiff(String(e)));
  }, [projectId, worktree, file]);

  if (diff === null) return null;
  // Skip the header (diff --git, index, ---/+++) and show hunks only.
  const lines = diff.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l));

  return (
    <pre className="mx-2 my-1 max-h-96 overflow-auto rounded-md border bg-background py-1 font-mono text-[11px] leading-[1.6] select-text">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-2 whitespace-pre",
            l.startsWith("+") && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            l.startsWith("-") && "bg-red-500/10 text-red-700 dark:text-red-300",
            l.startsWith("@@") && "text-sky-600 dark:text-sky-400",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/** Message box with Commit and Push, at the top like VS Code. */
function CommitBox({
  projectId,
  worktree,
  status,
  stagedCount,
  run,
  busy,
}: {
  projectId: string;
  worktree: string;
  status: GitStatus;
  stagedCount: number;
  run: Run;
  busy: boolean;
}) {
  const [message, setMessage] = useState("");
  const hasChanges = (status.files ?? []).length > 0;
  const canCommit = hasChanges && message.trim() !== "" && !busy;
  const canPush = (status.ahead > 0 || (!status.upstream && !hasChanges)) && !busy;

  const commit = () =>
    void run(async () => {
      await GitService.Commit(projectId, worktree, message.trim());
      setMessage("");
    });

  return (
    <div className="shrink-0 p-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) commit();
        }}
        placeholder={`Message (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter to commit)`}
        rows={2}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none select-text focus:border-ring"
      />
      <div className="mt-1.5 flex gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          disabled={!canCommit}
          onClick={commit}
          title={stagedCount > 0 ? "Commit the staged changes" : "Nothing staged: commits all changes"}
        >
          <Check />
          {stagedCount > 0 ? "Commit" : "Commit all"}
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={!canPush} onClick={() => void run(() => GitService.Push(projectId, worktree))}>
          <ArrowUp />
          Push{status.ahead > 0 && ` ${status.ahead}`}
        </Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">{children}</div>;
}

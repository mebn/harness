import { useEffect, useState } from "react";
import { ArrowUp, ChevronRight, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { Button } from "@/components/ui/button";
import { GitService, type GitFile, type GitStatus } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useActiveProject } from "@/stores/app-store";
import { useGitStatus } from "@/stores/git-store";

const STATUS_STYLE: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
};

/** Working-tree changes for the active project, with commit and push. */
export function GitChanges({ active }: { active: boolean }) {
  const project = useActiveProject();
  const { status, error, refresh } = useGitStatus(project?.id, active);

  if (!project) return <Centered>No project</Centered>;
  if (!status) return <Centered>{error ?? <Loader2 className="size-4 animate-spin" />}</Centered>;
  if (!status.isRepo) return <Centered>Not a git repository</Centered>;

  const files = status.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-3 text-xs">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">{status.branch}</span>
        {status.behind > 0 && <span className="text-muted-foreground">↓{status.behind}</span>}
        <span className="flex-1" />
        {files.length > 0 && <LineCounts added={added} removed={removed} />}
        <IconButton label="Refresh" onClick={() => void refresh()}>
          <RefreshCw />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {files.length === 0 ? (
          <Centered>No changes</Centered>
        ) : (
          files.map((f) => <FileRow key={f.path} projectId={project.id} file={f} />)
        )}
      </div>

      <CommitBox projectId={project.id} status={status} onDone={refresh} />
    </div>
  );
}

function FileRow({ projectId, file }: { projectId: string; file: GitFile }) {
  const [open, setOpen] = useState(false);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash >= 0 ? file.path.slice(0, slash) : "";

  return (
    <div>
      <div
        role="button"
        onClick={() => setOpen((o) => !o)}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className="flex h-7 cursor-default items-center gap-1.5 px-2 text-xs hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", STATUS_STYLE[file.status])}>
          {file.status === "?" ? "U" : file.status}
        </span>
        <span className={cn("shrink-0", file.status === "D" && "line-through opacity-70")}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{dir}</span>
        {file.binary ? (
          <span className="text-muted-foreground">bin</span>
        ) : (
          <LineCounts added={file.added} removed={file.removed} />
        )}
      </div>
      {open && <DiffView projectId={projectId} file={file} />}
    </div>
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

function DiffView({ projectId, file }: { projectId: string; file: GitFile }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    GitService.Diff(projectId, file)
      .then(setDiff)
      .catch((e) => setDiff(String(e)));
  }, [projectId, file]);

  if (diff === null) return null;
  // Skip the header (diff --git, index, ---/+++) and show hunks only.
  const lines = diff.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l));

  return (
    <pre className="mx-2 mb-2 max-h-96 overflow-auto rounded-md border bg-background py-1 font-mono text-[11px] leading-[1.6] select-text">
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

function CommitBox({ projectId, status, onDone }: { projectId: string; status: GitStatus; onDone: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasChanges = (status.files ?? []).length > 0;
  const canPush = status.ahead > 0 || (!status.upstream && !hasChanges);

  const act = async (kind: "commit" | "push") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "commit") {
        await GitService.Commit(projectId, message.trim());
        setMessage("");
      } else {
        await GitService.Push(projectId);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      await onDone();
    }
  };

  return (
    <div className="shrink-0 border-t p-2">
      {error && <p className="mb-2 max-h-24 overflow-auto text-xs whitespace-pre-wrap text-destructive select-text">{error}</p>}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && message.trim() && hasChanges) void act("commit");
        }}
        placeholder="Commit message"
        rows={2}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none select-text focus:border-ring"
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          disabled={!hasChanges || !message.trim() || busy !== null}
          onClick={() => void act("commit")}
        >
          {busy === "commit" && <Loader2 className="animate-spin" />}
          Commit
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 flex-1 text-xs"
          disabled={!canPush || busy !== null}
          onClick={() => void act("push")}
        >
          {busy === "push" ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          Push{status.ahead > 0 && ` ${status.ahead}`}
        </Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">{children}</div>;
}

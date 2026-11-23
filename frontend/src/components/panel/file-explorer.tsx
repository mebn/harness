import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { pressIntoGroup } from "@/components/workspace/group-view";
import { FileService, type FileEntry, type GitStatus } from "@/lib/backend";
import { uid } from "@/lib/layout-tree";
import { cn } from "@/lib/utils";
import { useGitStatus } from "@/stores/git-store";
import { CodeView } from "./code-view";
import { SubTabBar, closeTab } from "./sub-tabs";

const POLL_MS = 2000;

type Decoration = { letter: string; className: string };

const DECORATIONS: Record<string, Decoration> = {
  M: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  A: { letter: "A", className: "text-emerald-600 dark:text-emerald-400" },
  "?": { letter: "U", className: "text-emerald-600 dark:text-emerald-400" },
  R: { letter: "R", className: "text-sky-600 dark:text-sky-400" },
  D: { letter: "D", className: "text-red-600 dark:text-red-400" },
};

type TreeContext = {
  /** The group this explorer sits in; files dragged out become tabs there. */
  groupId: string;
  projectId: string;
  worktree: string;
  /** Increments on every poll so open folders re-list themselves. */
  tick: number;
  files: Map<string, Decoration>;
  /** Folders that contain changes get the color of their "strongest" change. */
  dirs: Map<string, Decoration>;
  onOpen: (path: string) => void;
};

const Ctx = createContext<TreeContext | null>(null);
const useTree = () => useContext(Ctx)!;

function buildDecorations(status: GitStatus | undefined) {
  const files = new Map<string, Decoration>();
  const dirs = new Map<string, Decoration>();
  for (const f of status?.files ?? []) {
    const deco = DECORATIONS[f.status];
    if (!deco) continue;
    files.set(f.path, deco);
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      // Modified wins over added, so a folder with any edit reads as modified.
      if (!dirs.has(dir) || deco.letter === "M") dirs.set(dir, deco);
    }
  }
  return { files, dirs };
}

const TREE = "tree";

type OpenTabs = { files: string[]; active: string };

/**
 * Starts dragging a file out of the explorer; dropped in the group's layout it becomes a tab
 * of its own. A press that doesn't move stays a click.
 */
function dragFileOut(groupId: string, path: string, e: React.PointerEvent, onDrop?: () => void) {
  pressIntoGroup(groupId, e, { kind: "new", tab: { id: uid("tab"), kind: "file", path } }, path.split("/").pop()!, "file", onDrop);
}

/** Live file tree for a project (or worktree) plus open files as tabs (like editor tabs). */
export function FileExplorer({
  groupId,
  projectId,
  worktree = "",
  active,
}: {
  groupId: string;
  projectId: string;
  worktree?: string;
  active: boolean;
}) {
  const { status } = useGitStatus(projectId, active, worktree);
  const [tabs, setTabs] = useState<OpenTabs>({ files: [], active: TREE });
  const [tick, setTick] = useState(0);

  // Re-list open folders (and re-read open files) periodically and whenever git sees a change.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => setTick((n) => n + 1), [status]);

  const decorations = useMemo(() => buildDecorations(status), [status]);

  const open = (path: string) =>
    setTabs({ files: tabs.files.includes(path) ? tabs.files : [...tabs.files, path], active: path });
  const close = (path: string) =>
    setTabs((cur) => {
      const next = closeTab(cur.files.map((p) => ({ id: p })), path, cur.active);
      return { files: next.tabs.map((t) => t.id), active: next.active || TREE };
    });

  return (
    <div className="flex h-full flex-col">
      <SubTabBar
        tabs={[
          { id: TREE, label: "", icon: <FolderTree />, title: "Explorer" },
          ...tabs.files.map((path) => ({
            id: path,
            label: path.split("/").pop()!,
            title: path,
            closable: true,
          })),
        ]}
        active={tabs.active}
        onSelect={(id) => setTabs({ ...tabs, active: id })}
        onClose={close}
        // A file tab dragged out moves to its own tab in the group.
        onTabPointerDown={(id, e) => id !== TREE && dragFileOut(groupId, id, e, () => close(id))}
      />
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0 overflow-auto py-1", tabs.active !== TREE && "invisible")}>
          <Ctx.Provider value={{ groupId, projectId, worktree, tick, onOpen: open, ...decorations }}>
            <DirNode path="" depth={0} />
          </Ctx.Provider>
        </div>
        {tabs.active !== TREE && (
          <div className="absolute inset-0 flex flex-col">
            <FileContent key={tabs.active} projectId={projectId} worktree={worktree} path={tabs.active} tick={tick} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A file as a tab of its own in a window, kept up to date while shown. */
export function FileTab({
  projectId,
  worktree,
  path,
  line,
  reveals,
  active,
}: {
  projectId: string;
  worktree: string;
  path: string;
  line?: number;
  reveals: number;
  active: boolean;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    setTick((n) => n + 1);
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  return (
    <div className="flex h-full flex-col">
      <div title={path} className="flex h-7 shrink-0 items-center gap-1 truncate border-b px-3 text-[11px] text-muted-foreground">
        {path.split("/").map((part, i, all) => (
          <span key={i} className={cn("truncate", i === all.length - 1 && "text-foreground")}>
            {i > 0 && <span className="mr-1 text-muted-foreground/60">/</span>}
            {part}
          </span>
        ))}
      </div>
      <FileContent projectId={projectId} worktree={worktree} path={path} tick={tick} line={line} reveals={reveals} />
    </div>
  );
}

/** A file's content; re-reads it on every tick so it shows the latest version. */
function FileContent({
  projectId,
  worktree,
  path,
  tick,
  line,
  reveals,
}: {
  projectId: string;
  worktree: string;
  path: string;
  tick: number;
  line?: number;
  reveals?: number;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    FileService.Read(projectId, worktree, path)
      .then((text) => !cancelled && setContent((prev) => (prev === text ? prev : text)))
      .catch((e) => !cancelled && setContent(String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, worktree, path, tick]);

  if (content === null) return null;
  return <CodeView path={path} code={content} line={line} reveals={reveals} />;
}
function DirNode({ path, depth }: { path: string; depth: number }) {
  const { projectId, worktree, tick } = useTree();
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef("");

  useEffect(() => {
    let cancelled = false;
    FileService.List(projectId, worktree, path)
      .then((list) => {
        const json = JSON.stringify(list);
        if (cancelled || json === last.current) return; // unchanged: no re-render
        last.current = json;
        setEntries(list ?? []);
        setError(null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, worktree, path, tick]);

  if (error) return <p className="px-3 text-xs text-destructive">{error}</p>;
  if (!entries) return null;

  return (
    <>
      {entries.map((e) =>
        e.isDir ? <DirEntry key={e.path} entry={e} depth={depth} /> : <FileRow key={e.path} entry={e} depth={depth} />,
      )}
    </>
  );
}

function DirEntry({ entry, depth }: { entry: FileEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const deco = useTree().dirs.get(entry.path);
  return (
    <>
      <Row depth={depth} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("flex-1 truncate", deco?.className)}>{entry.name}</span>
        {deco && <span className={cn("mr-1 size-1.5 shrink-0 rounded-full bg-current", deco.className)} />}
      </Row>
      {open && <DirNode path={entry.path} depth={depth + 1} />}
    </>
  );
}

function FileRow({ entry, depth }: { entry: FileEntry; depth: number }) {
  const { groupId, files, onOpen } = useTree();
  const deco = files.get(entry.path);
  return (
    <Row depth={depth} onClick={() => onOpen(entry.path)} onPointerDown={(e) => dragFileOut(groupId, entry.path, e)}>
      <span className="w-3 shrink-0" />
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("flex-1 truncate", deco?.className)}>{entry.name}</span>
      {deco && <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", deco.className)}>{deco.letter}</span>}
    </Row>
  );
}

function Row({
  depth,
  onClick,
  onPointerDown,
  children,
}: {
  depth: number;
  onClick: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex h-6 cursor-default items-center gap-1.5 pr-2 text-xs hover:bg-accent/60"
    >
      {children}
    </div>
  );
}

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { FileService, type FileEntry, type GitStatus } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useActiveProject } from "@/stores/app-store";
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
  projectId: string;
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

/** Live file tree for the active project plus open files as tabs (like editor tabs). */
export function FileExplorer({ active }: { active: boolean }) {
  const project = useActiveProject();
  const { status } = useGitStatus(project?.id, active);
  // Open file tabs per project, so switching sessions keeps each workspace's tabs.
  const [byProject, setByProject] = useState<Record<string, OpenTabs>>({});
  const [tick, setTick] = useState(0);

  // Re-list open folders (and re-read open files) periodically and whenever git sees a change.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => setTick((n) => n + 1), [status]);

  const decorations = useMemo(() => buildDecorations(status), [status]);

  if (!project) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No project</div>;
  }

  const tabs = byProject[project.id] ?? { files: [], active: TREE };
  const setTabs = (next: OpenTabs) => setByProject((m) => ({ ...m, [project.id]: next }));
  const open = (path: string) =>
    setTabs({ files: tabs.files.includes(path) ? tabs.files : [...tabs.files, path], active: path });

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
        onClose={(id) => {
          const next = closeTab(tabs.files.map((p) => ({ id: p })), id, tabs.active);
          setTabs({ files: next.tabs.map((t) => t.id), active: next.active || TREE });
        }}
      />
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0 overflow-auto py-1", tabs.active !== TREE && "invisible")}>
          <Ctx.Provider value={{ projectId: project.id, tick, onOpen: open, ...decorations }}>
            <DirNode key={project.id} path="" depth={0} />
          </Ctx.Provider>
        </div>
        {tabs.active !== TREE && (
          <OpenFile key={`${project.id}:${tabs.active}`} projectId={project.id} path={tabs.active} tick={tick} />
        )}
      </div>
    </div>
  );
}

/** An open file tab; re-reads the file on every tick so it shows the latest content. */
function OpenFile({ projectId, path, tick }: { projectId: string; path: string; tick: number }) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    FileService.Read(projectId, path)
      .then((text) => !cancelled && setContent((prev) => (prev === text ? prev : text)))
      .catch((e) => !cancelled && setContent(String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, path, tick]);

  if (content === null) return null;
  return (
    <div className="absolute inset-0 flex flex-col">
      <CodeView path={path} code={content} />
    </div>
  );
}
function DirNode({ path, depth }: { path: string; depth: number }) {
  const { projectId, tick } = useTree();
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef("");

  useEffect(() => {
    let cancelled = false;
    FileService.List(projectId, path)
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
  }, [projectId, path, tick]);

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
  const { files, onOpen } = useTree();
  const deco = files.get(entry.path);
  return (
    <Row depth={depth} onClick={() => onOpen(entry.path)}>
      <span className="w-3 shrink-0" />
      <File className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("flex-1 truncate", deco?.className)}>{entry.name}</span>
      {deco && <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", deco.className)}>{deco.letter}</span>}
    </Row>
  );
}

function Row({ depth, onClick, children }: { depth: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      role="button"
      onClick={onClick}
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex h-6 cursor-default items-center gap-1.5 pr-2 text-xs hover:bg-accent/60"
    >
      {children}
    </div>
  );
}

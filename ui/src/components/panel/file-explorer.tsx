import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { pressIntoGroup } from "@/components/workspace/group-view";
import { FileService, type FileEntry, type GitStatus } from "@/lib/backend";
import { uid } from "@/lib/layout-tree";
import { onCloseInTab } from "@/lib/tab-close";
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

const closeFile = (cur: OpenTabs, path: string): OpenTabs => {
  const next = closeTab(cur.files.map((p) => ({ id: p })), path, cur.active);
  return { files: next.tabs.map((t) => t.id), active: next.active || TREE };
};

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * Starts dragging a file out of the explorer; dropped in the group's layout it becomes a tab
 * of its own. A press that doesn't move stays a click.
 */
function dragFileOut(groupId: string, path: string, e: React.PointerEvent, onDrop?: () => void) {
  pressIntoGroup(groupId, e, { kind: "new", tab: { id: uid("tab"), kind: "file", path } }, path.split("/").pop()!, "file", onDrop);
}

/** Live file tree for a project (or worktree) plus open files as tabs (like editor tabs). */
export function FileExplorer({
  tabId,
  groupId,
  projectId,
  worktree = "",
  active,
}: {
  /** The window tab this explorer fills; Ctrl/⌘+W closes an open file in it first. */
  tabId: string;
  groupId: string;
  projectId: string;
  worktree?: string;
  active: boolean;
}) {
  const { status } = useGitStatus(projectId, active, worktree);
  const [tabs, setTabs] = useState<OpenTabs>({ files: [], active: TREE });
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Re-list open folders (and re-read open files) periodically and whenever git sees a change.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => setTick((n) => n + 1), [status]);

  const decorations = useMemo(() => buildDecorations(status), [status]);

  const listings = useListings(projectId, worktree, expanded, tick);
  const { items, rows } = useMemo(() => flatten(listings, expanded), [listings, expanded]);

  const open = (path: string) =>
    setTabs((cur) => ({ files: cur.files.includes(path) ? cur.files : [...cur.files, path], active: path }));
  const close = (path: string) => setTabs((cur) => closeFile(cur, path));
  const toggle = (path: string, open = !expanded.has(path)) =>
    setExpanded((cur) => {
      if (cur.has(path) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });

  // Ctrl/⌘+W closes the open file before the Files tab itself.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(
    () =>
      onCloseInTab(tabId, () => {
        const cur = tabsRef.current;
        if (cur.active === TREE) return false;
        setTabs(closeFile(cur, cur.active));
        return true;
      }),
    [tabId],
  );

  // The selected row stays in view as it moves.
  useEffect(() => {
    if (!selected) return;
    treeRef.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // VS Code-style keys while the explorer has focus: arrows move and open/close, Enter opens,
  // Esc backs out (file → tree → no selection → blur).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.altKey || e.metaKey) return;
    if (tabs.active !== TREE) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setTabs({ ...tabs, active: TREE });
      return;
    }
    const i = rows.findIndex((r) => r.entry.path === selected);
    const row = rows[i];
    const select = (j: number) => rows[j] && setSelected(rows[j].entry.path);
    switch (e.key) {
      case "ArrowDown":
        select(i < 0 ? 0 : Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        select(i < 0 ? 0 : Math.max(i - 1, 0));
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row?.entry.isDir) break;
        if (!expanded.has(row.entry.path)) toggle(row.entry.path, true);
        else if ((rows[i + 1]?.depth ?? 0) > row.depth) select(i + 1);
        break;
      case "ArrowLeft":
        if (!row) break;
        if (row.entry.isDir && expanded.has(row.entry.path)) toggle(row.entry.path, false);
        else if (parentOf(row.entry.path)) setSelected(parentOf(row.entry.path));
        break;
      case "Enter":
        if (!row) break;
        if (row.entry.isDir) toggle(row.entry.path);
        else open(row.entry.path);
        break;
      case "Escape":
        if (selected) setSelected(null);
        else e.currentTarget.blur();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    // Focusable as a whole (and focused by clicks anywhere in it), so its keys work on the
    // tree and on an open file alike.
    <div tabIndex={0} onKeyDown={onKeyDown} className="group/explorer flex h-full flex-col outline-none">
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
        <div ref={treeRef} role="tree" className={cn("absolute inset-0 overflow-auto py-1", tabs.active !== TREE && "invisible")}>
          {items.map((item) =>
            "error" in item ? (
              <p key={`!${item.path}`} style={{ paddingLeft: 12 + item.depth * 12 }} className="pr-2 text-xs text-destructive">
                {item.error}
              </p>
            ) : (
              <TreeRow
                key={item.entry.path}
                entry={item.entry}
                depth={item.depth}
                open={expanded.has(item.entry.path)}
                selected={item.entry.path === selected}
                deco={(item.entry.isDir ? decorations.dirs : decorations.files).get(item.entry.path)}
                onClick={() => {
                  setSelected(item.entry.path);
                  if (item.entry.isDir) toggle(item.entry.path);
                  else open(item.entry.path);
                }}
                onPointerDown={item.entry.isDir ? undefined : (e) => dragFileOut(groupId, item.entry.path, e)}
              />
            ),
          )}
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
type Listing = { entries: FileEntry[] } | { error: string };
type Row = { entry: FileEntry; depth: number };
type Item = Row | { path: string; depth: number; error: string };

/** Whether an open folder is showing: every folder above it is open too. */
function isShown(path: string, expanded: ReadonlySet<string>) {
  for (let p = parentOf(path); p; p = parentOf(p)) if (!expanded.has(p)) return false;
  return true;
}

/** Lists the root and every open folder that is showing, again on every tick. */
function useListings(projectId: string, worktree: string, expanded: ReadonlySet<string>, tick: number) {
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(() => new Map());
  const last = useRef(new Map<string, string>());
  // As a string, so re-renders with the same folders open don't re-list them.
  const shown = ["", ...[...expanded].filter((p) => isShown(p, expanded))].join("\n");

  useEffect(() => {
    let cancelled = false;
    const set = (dir: string, key: string, listing: Listing) => {
      if (cancelled || last.current.get(dir) === key) return; // unchanged: no re-render
      last.current.set(dir, key);
      setListings((m) => new Map(m).set(dir, listing));
    };
    for (const dir of shown.split("\n")) {
      FileService.List(projectId, worktree, dir)
        .then((list) => set(dir, JSON.stringify(list), { entries: list ?? [] }))
        .catch((e) => set(dir, `!${e}`, { error: String(e) }));
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, worktree, shown, tick]);

  return listings;
}

/**
 * The tree's visible rows in order (what the keys move through), plus errors for folders that
 * failed to list. Folders not listed yet show nothing below them.
 */
function flatten(listings: ReadonlyMap<string, Listing>, expanded: ReadonlySet<string>) {
  const items: Item[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = listings.get(dir);
    if (!listing) return;
    if ("error" in listing) return void items.push({ path: dir, depth, error: listing.error });
    for (const entry of listing.entries) {
      items.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return { items, rows: items.filter((i): i is Row => "entry" in i) };
}

function TreeRow({
  entry,
  depth,
  open,
  selected,
  deco,
  onClick,
  onPointerDown,
}: {
  entry: FileEntry;
  depth: number;
  open: boolean;
  selected: boolean;
  deco?: Decoration;
  onClick: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={entry.isDir ? open : undefined}
      data-path={entry.path}
      onClick={onClick}
      onPointerDown={onPointerDown}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        "flex h-6 cursor-default items-center gap-1.5 pr-2 text-xs",
        // Selected: muted while the explorer doesn't have focus, outlined while it does.
        selected
          ? "bg-accent/50 ring-inset group-focus/explorer:bg-accent group-focus/explorer:ring-1 group-focus/explorer:ring-ring/50"
          : "hover:bg-accent/60",
      )}
    >
      {entry.isDir ? (
        <>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("flex-1 truncate", deco?.className)}>{entry.name}</span>
          {deco && <span className={cn("mr-1 size-1.5 shrink-0 rounded-full bg-current", deco.className)} />}
        </>
      ) : (
        <>
          <span className="w-3 shrink-0" />
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("flex-1 truncate", deco?.className)}>{entry.name}</span>
          {deco && <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", deco.className)}>{deco.letter}</span>}
        </>
      )}
    </div>
  );
}

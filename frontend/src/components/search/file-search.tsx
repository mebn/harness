import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CaseSensitive, File, FileSearch, Loader2, Regex, Search, WholeWord } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FileService } from "@/lib/backend";
import { fuzzyMatch, highlightRuns } from "@/lib/fuzzy";
import { shortcutLabel } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useActiveGroup, useGroups } from "@/stores/group-store";
import { useLayout } from "@/stores/layout-store";
import type { SearchOptions, SearchResult } from "@bindings/harness/internal/services/models";

const MAX_FILE_RESULTS = 80;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Find a file by name (fuzzy) or search the text of every file, in the active group's
 * workspace (or its worktree). Picking a result opens the file as a tab in that group.
 */
export function FileSearchDialog() {
  const mode = useLayout((s) => s.fileSearch);
  const setMode = useLayout((s) => s.setFileSearch);
  const group = useActiveGroup();
  const project = useApp((s) => s.tree.find((n) => n.project.id === group?.projectId)?.project);

  const open = (path: string, line?: number) => {
    if (!group) return;
    setMode(null);
    useGroups.getState().openFile(group.id, path, line);
  };

  const scope = project ? (group?.worktree ? `${project.name} · ${group.worktree}` : project.name) : "";

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
      <DialogContent
        className={cn("top-[15%] translate-y-0 overflow-hidden p-0", mode === "text" ? "sm:max-w-2xl" : "sm:max-w-xl")}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{mode === "text" ? "Search in files" : "Go to file"}</DialogTitle>
        <DialogDescription className="sr-only">Searches the files of the current workspace</DialogDescription>
        {!group || !project ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Open a workspace to search its files.</p>
        ) : mode === "text" ? (
          <TextSearch key={`${group.projectId}/${group.worktree ?? ""}`} projectId={project.id} worktree={group.worktree ?? ""} scope={scope} onOpen={open} />
        ) : (
          <FileFinder key={`${group.projectId}/${group.worktree ?? ""}`} projectId={project.id} worktree={group.worktree ?? ""} scope={scope} onOpen={open} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type PaneProps = { projectId: string; worktree: string; scope: string; onOpen: (path: string, line?: number) => void };

function FileFinder({ projectId, worktree, scope, onOpen }: PaneProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    FileService.ListAll(projectId, worktree)
      .then((list) => setFiles(list ?? []))
      .catch((e) => setError(String(e)));
  }, [projectId, worktree]);

  const results = useMemo(() => {
    if (!files) return [];
    const q = query.trim().replace(/\s+/g, "");
    if (!q) return files.slice(0, MAX_FILE_RESULTS).map((path) => ({ path, indices: [] as number[] }));
    const scored: { path: string; score: number; indices: number[] }[] = [];
    for (const path of files) {
      const m = fuzzyMatch(path, q);
      if (m) scored.push({ path, ...m });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_FILE_RESULTS);
  }, [files, query]);

  return (
    <Command shouldFilter={false}>
      <SearchRow icon={<File />} value={query} onChange={setQuery} placeholder={`Go to file in ${scope}…`} busy={!files && !error} />
      <CommandList className="max-h-[min(60vh,440px)]">
        {error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : (
          files && <CommandEmpty>No matching files</CommandEmpty>
        )}
        {results.map((r) => {
          const slash = r.path.lastIndexOf("/");
          const name = r.path.slice(slash + 1);
          const dir = slash >= 0 ? r.path.slice(0, slash) : "";
          return (
            <CommandItem key={r.path} value={r.path} onSelect={() => onOpen(r.path)} className="gap-2">
              <File className="text-muted-foreground" />
              <span className="shrink-0">
                <Highlighted text={name} indices={r.indices} offset={slash + 1} />
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                <Highlighted text={dir} indices={r.indices} offset={0} />
              </span>
            </CommandItem>
          );
        })}
      </CommandList>
      <Footer>
        <span>{files ? `${files.length.toLocaleString()} files` : "Listing files…"}</span>
        <span>Search text: {shortcutLabel("findInFiles")}</span>
      </Footer>
    </Command>
  );
}

function TextSearch({ projectId, worktree, scope, onOpen }: PaneProps) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query;
    if (!q.trim()) {
      setResult(null);
      setError(null);
      setBusy(false);
      return;
    }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      FileService.Search(projectId, worktree, q, opts)
        .then((r) => {
          if (n !== seq.current) return;
          setResult(r);
          setError(null);
        })
        .catch((e) => n === seq.current && setError(String(e)))
        .finally(() => n === seq.current && setBusy(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [projectId, worktree, query, opts]);

  const toggle = (key: keyof SearchOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));
  const files = result?.files ?? [];

  return (
    <Command shouldFilter={false}>
      <SearchRow icon={<FileSearch />} value={query} onChange={setQuery} placeholder={`Search in ${scope}…`} busy={busy}>
        <Toggle label="Match case" on={opts.caseSensitive} onClick={() => toggle("caseSensitive")}>
          <CaseSensitive />
        </Toggle>
        <Toggle label="Whole word" on={opts.wholeWord} onClick={() => toggle("wholeWord")}>
          <WholeWord />
        </Toggle>
        <Toggle label="Regular expression" on={opts.regex} onClick={() => toggle("regex")}>
          <Regex />
        </Toggle>
      </SearchRow>
      <CommandList className="max-h-[min(65vh,520px)]">
        {error && <p className="p-4 text-xs text-destructive">{error}</p>}
        {result && !error && files.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No results</p>}
        {files.map((f) => (
          <CommandGroup
            key={f.path}
            heading={
              <span className="flex items-center gap-1.5">
                <span className="truncate text-foreground">{f.path.split("/").pop()}</span>
                <span className="truncate font-normal">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                <span className="ml-auto shrink-0 rounded-full bg-foreground/[0.08] px-1.5 text-[10px] tabular-nums">{f.matches?.length ?? 0}</span>
              </span>
            }
          >
            {(f.matches ?? []).map((m) => (
              <CommandItem key={`${f.path}:${m.line}`} value={`${f.path}:${m.line}`} onSelect={() => onOpen(f.path, m.line)} className="gap-2 py-1">
                <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{m.line}</span>
                <span className="min-w-0 truncate font-mono text-xs">
                  {m.text.slice(0, m.start)}
                  <mark className="rounded-sm bg-amber-400/30 text-foreground">{m.text.slice(m.start, m.end)}</mark>
                  {m.text.slice(m.end)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <Footer>
        <span>
          {result
            ? `${result.total.toLocaleString()} ${result.total === 1 ? "result" : "results"} in ${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}${result.truncated ? " (first results only)" : ""}`
            : "Type to search the workspace"}
        </span>
        <span>Go to file: {shortcutLabel("findFile")}</span>
      </Footer>
    </Command>
  );
}

function SearchRow({
  icon,
  value,
  onChange,
  placeholder,
  busy,
  children,
}: {
  icon: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  busy: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-11 items-center gap-2 border-b px-3 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:opacity-50">
      {busy ? <Loader2 className="animate-spin" /> : (icon ?? <Search />)}
      <CommandPrimitive.Input
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
      />
      {children && <div className="flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
  );
}

function Toggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4",
        on && "bg-primary/15 text-foreground ring-1 ring-primary/40",
      )}
    >
      {children}
    </button>
  );
}

function Highlighted({ text, indices, offset }: { text: string; indices: number[]; offset: number }) {
  return (
    <>
      {highlightRuns(text, indices, offset).map((r, i) =>
        r.hit ? (
          <span key={i} className="font-semibold text-foreground">
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex h-8 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">{children}</div>;
}

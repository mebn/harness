import { useEffect, useMemo, useState } from "react";
import { Folder, FolderPlus, MessageSquare, MessagesSquare, Plus, Settings, SunMoon, type LucideIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ChatService, type ProjectTree } from "@/lib/backend";
import type { MessageHit } from "@bindings/harness/internal/store/models";
import { useApp, useActiveProject } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { useTheme } from "@/stores/theme-store";

const DEBOUNCE_MS = 150;

type Action = { id: string; label: string; icon: LucideIcon; run: () => void };

const matches = (text: string, q: string) => text.toLowerCase().includes(q);

/** Ctrl/Cmd+K palette: searches workspaces, sessions, message text and actions. */
export function SearchDialog() {
  const open = useLayout((s) => s.searchOpen);
  const setOpen = useLayout((s) => s.setSearchOpen);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search workspaces, sessions and messages</DialogDescription>
        {/* Filtering is done here, so cmdk's own fuzzy filter is off. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search…" />
          <CommandList className="max-h-[min(60vh,420px)]">
            <Results query={query.trim().toLowerCase()} close={() => setOpen(false)} />
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Results({ query, close }: { query: string; close: () => void }) {
  const tree = useApp((s) => s.tree);
  const selectSession = useApp((s) => s.selectSession);
  const toggleProject = useApp((s) => s.toggleProject);
  const actions = useActions(close);
  const hits = useMessageSearch(query);

  const workspaces = useMemo(() => tree.filter((n) => !query || matches(n.project.name, query) || matches(n.project.path, query)), [tree, query]);
  const sessions = useMemo(() => sessionsOf(tree).filter((s) => !query || matches(s.title, query)), [tree, query]);
  const shownActions = actions.filter((a) => !query || matches(a.label, query));
  const sessionTitle = useMemo(() => new Map(sessionsOf(tree).map((s) => [s.id, s])), [tree]);

  const openSession = (id: string) => {
    void selectSession(id);
    close();
  };

  return (
    <>
      <CommandEmpty>No results</CommandEmpty>
      {shownActions.length > 0 && (
        <CommandGroup heading="Actions">
          {shownActions.map((a) => (
            <CommandItem key={a.id} value={`action:${a.id}`} onSelect={a.run}>
              <a.icon /> {a.label}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {workspaces.length > 0 && (
        <CommandGroup heading="Workspaces">
          {workspaces.map(({ project }) => (
            <CommandItem
              key={project.id}
              value={`ws:${project.id}`}
              onSelect={() => {
                if (!project.expanded) void toggleProject(project.id);
                close();
              }}
            >
              <Folder />
              <span className="truncate">{project.name}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{project.path}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {sessions.length > 0 && (
        <CommandGroup heading="Sessions">
          {sessions.slice(0, query ? 50 : 8).map((s) => (
            <CommandItem key={s.id} value={`s:${s.id}`} onSelect={() => openSession(s.id)}>
              <MessagesSquare />
              <span className="truncate">{s.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.workspace}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {hits.length > 0 && (
        <CommandGroup heading="Messages">
          {hits.map((h) => (
            <CommandItem key={h.messageId} value={`m:${h.messageId}`} onSelect={() => openSession(h.sessionId)}>
              <MessageSquare />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{h.snippet}</span>
                <span className="truncate text-xs text-muted-foreground">{sessionTitle.get(h.sessionId)?.title}</span>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}

function sessionsOf(tree: ProjectTree[]) {
  return tree
    .flatMap((n) => (n.sessions ?? []).map((s) => ({ ...s, workspace: n.project.name })))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function useActions(close: () => void): Action[] {
  const project = useActiveProject();
  const newSession = useApp((s) => s.newSession);
  const addProject = useApp((s) => s.addProject);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const theme = useTheme((s) => s.theme);
  const setPref = useTheme((s) => s.setPref);

  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return [
    ...(project
      ? [{ id: "new-session", label: `New session in ${project.name}`, icon: Plus, run: run(() => void newSession(project.id)) }]
      : []),
    { id: "open-folder", label: "Open folder", icon: FolderPlus, run: run(() => void addProject()) },
    { id: "settings", label: "Settings", icon: Settings, run: run(() => setSettingsOpen(true)) },
    {
      id: "theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: SunMoon,
      run: run(() => setPref(theme === "dark" ? "light" : "dark")),
    },
  ];
}

/** Debounced full-text search over message content (backend). */
function useMessageSearch(query: string): MessageHit[] {
  const [hits, setHits] = useState<MessageHit[]>([]);
  useEffect(() => {
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      ChatService.SearchMessages(query)
        .then((r) => !cancelled && setHits(r ?? []))
        .catch(() => !cancelled && setHits([]));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);
  return hits;
}

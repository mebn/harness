import { useEffect, useMemo, useState } from "react";
import { File, FileSearch, Folder, FolderPlus, Keyboard, MessageSquare, MessagesSquare, Plus, Settings, SunMoon, type LucideIcon } from "lucide-react";
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
import type { MessageHit } from "@bindings/harness/server/internal/store/models";
import { useApp } from "@/stores/app-store";
import { groupActivity, useActiveProject, useGroups } from "@/stores/group-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useLayout } from "@/stores/layout-store";
import { useTheme } from "@/stores/theme-store";

const DEBOUNCE_MS = 150;

type Action = { id: string; label: string; icon: LucideIcon; keys?: string; run: () => void };

const matches = (text: string, q: string) => text.toLowerCase().includes(q);

/** Ctrl/Cmd+K panel: actions, plus workspaces, chats and message text to jump to. */
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
        <DialogDescription className="sr-only">Search workspaces, chats and messages</DialogDescription>
        {/* Filtering is done here, so cmdk's own fuzzy filter is off. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Run an action, or find a workspace or chat…" />
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
  const openChat = useGroups((s) => s.openChat);
  const groups = useGroups((s) => s.groups);
  const reveal = useGroups((s) => s.reveal);
  const actions = useActions(close);
  const hits = useMessageSearch(query);

  const workspaces = useMemo(() => tree.filter((n) => !query || matches(n.project.name, query) || matches(n.project.path, query)), [tree, query]);
  const sessions = useMemo(() => sessionsOf(tree).filter((s) => !query || matches(s.title, query)), [tree, query]);
  const shownActions = actions.filter((a) => !query || matches(a.label, query));
  const sessionTitle = useMemo(() => new Map(sessionsOf(tree).map((s) => [s.id, s])), [tree]);

  const openSession = (id: string) => {
    const session = sessionTitle.get(id);
    if (session) openChat(session);
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
              {a.keys && <span className="ml-auto text-xs text-muted-foreground">{a.keys}</span>}
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
                // Show the workspace's most recent group, or start one.
                const latest = groups
                  .filter((w) => w.projectId === project.id)
                  .sort((a, b) => groupActivity(b, tree) - groupActivity(a, tree))[0];
                if (latest) reveal(latest.id);
                else void useGroups.getState().newGroup(project.id);
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
        <CommandGroup heading="Chats">
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
  const newGroup = useGroups((s) => s.newGroup);
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
      ? [
          { id: "new-window", label: "New window", icon: Plus, keys: shortcutLabel("newWindow"), run: run(() => void useGroups.getState().openWindow()) },
          {
            id: "new-group",
            label: `New group in ${project.name}`,
            icon: Plus,
            keys: shortcutLabel("newGroup"),
            run: run(() => void newGroup(project.id)),
          },
          { id: "find-file", label: "Go to file", icon: File, keys: shortcutLabel("findFile"), run: run(() => useLayout.getState().setFileSearch("files")) },
          {
            id: "find-in-files",
            label: "Search in files",
            icon: FileSearch,
            keys: shortcutLabel("findInFiles"),
            run: run(() => useLayout.getState().setFileSearch("text")),
          },
        ]
      : []),
    {
      id: "add-workspace",
      label: "Add workspace",
      icon: FolderPlus,
      run: run(async () => {
        const id = await addProject();
        if (id) await newGroup(id);
      }),
    },
    { id: "settings", label: "Settings", icon: Settings, keys: shortcutLabel("settings"), run: run(() => setSettingsOpen(true)) },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: Keyboard,
      keys: shortcutLabel("shortcuts"),
      run: run(() => setSettingsOpen(true, "shortcuts")),
    },
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

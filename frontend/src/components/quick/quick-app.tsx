import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, ChevronDown, Folder, SquarePen } from "lucide-react";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { settleStale } from "@/components/chat/chat-view";
import { PreviewContainer } from "@/components/common/image-preview";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { useStartup } from "@/components/layout/startup-screen";
import { ActivityIndicator } from "@/components/sidebar/activity-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBackendEvents } from "@/hooks/use-backend-events";
import { Events, type Message, type ProjectTree, type Session } from "@/lib/backend";
import {
  EVENT_QUICK_DIALOG,
  EVENT_QUICK_HIDE,
  EVENT_QUICK_SHOWN,
  lastChat,
  noteQuickSession,
  openInMainWindow,
  rememberChat,
} from "@/lib/quick";
import { projectLastUsed, sessionState } from "@/lib/session-state";
import { cn } from "@/lib/utils";
import { findSession, useApp, useSession } from "@/stores/app-store";
import { useTheme, type ThemePref } from "@/stores/theme-store";

const EMPTY: Message[] = [];
/** Recent chats of the workspace shown as chips in the bar. */
const CHIP_COUNT = 6;

const hide = () => void Events.Emit(EVENT_QUICK_HIDE);
const dialogOpen = (open: boolean) => void Events.Emit(EVENT_QUICK_DIALOG, open);

/**
 * The quick chat: a floating window (opened by the hotkey) with one chat, as in cmdcmd. Only
 * the input shows until the chat has something in it; then a card grows up out of it.
 */
export function QuickApp() {
  const init = useApp((s) => s.init);
  const ready = useApp((s) => s.ready);
  useBackendEvents();
  const startup = useStartup(init);
  useFollowTheme();

  useEffect(() => {
    document.documentElement.classList.add("quick");
  }, []);

  if (!ready) {
    if (startup.state.phase !== "failed") return null;
    return (
      <Stage>
        <section className="quick-card expanded w-full">
          <div className="flex flex-col gap-3 p-4 text-sm">
            <p className="font-medium">Couldn't connect to the Harness server</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap select-text">
              {startup.state.error}
            </pre>
            <button className="self-end rounded-md border px-3 py-1 text-xs hover:bg-accent" onClick={startup.retry}>
              Retry
            </button>
          </div>
        </section>
      </Stage>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <QuickChat />
      <ConfirmDialog />
    </TooltipProvider>
  );
}

/** The transparent window: clicking its empty space hides it, like clicking outside. */
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex h-full items-center justify-center px-[60px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) hide();
      }}
    >
      {children}
    </div>
  );
}

/** The chat to show: the one last focused in either window, else the most recent one. */
function pickSession(tree: ProjectTree[]): string | null {
  const last = lastChat();
  if (last && findSession(tree, last)) return last;
  let best: Session | undefined;
  for (const s of tree.flatMap((n) => n.sessions ?? [])) if (!best || s.updatedAt > best.updatedAt) best = s;
  return best?.id ?? null;
}

function QuickChat() {
  const tree = useApp((s) => s.tree);
  const [sessionId, setSessionId] = useState<string | null>(() => pickSession(useApp.getState().tree));
  const [shownCount, setShownCount] = useState(0);
  const session = useSession(sessionId ?? undefined);
  const loaded = useApp((s) => (sessionId ? s.messages[sessionId] : undefined));
  const messages = loaded ?? EMPTY;
  const running = useApp((s) => !!(sessionId && s.running[sessionId]));
  const hasPending = useApp((s) => !!(sessionId && s.pending[sessionId]?.length));
  // Chats started here: listed in the main window once used, dropped if left empty.
  const startedHere = useRef(new Set<string>());

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const select = useCallback((id: string) => {
    const prev = sessionIdRef.current;
    if (prev && prev !== id && startedHere.current.has(prev) && (useApp.getState().messages[prev]?.length ?? 0) === 0) {
      startedHere.current.delete(prev);
      void useApp.getState().deleteSession(prev);
    }
    setSessionId(id);
    rememberChat(id);
  }, []);
  // Each time the window is shown: the chat last focused, a fresh list, and the input focused.
  useEffect(
    () =>
      Events.On(EVENT_QUICK_SHOWN, () => {
        setShownCount((n) => n + 1);
        const id = pickSession(useApp.getState().tree);
        if (id && id !== sessionIdRef.current) select(id);
        void useApp
          .getState()
          .refreshTree()
          .then(() => {
            const next = pickSession(useApp.getState().tree);
            if (next && next !== sessionIdRef.current) select(next);
          });
      }),
    [select],
  );

  // A chat deleted elsewhere: show another.
  useEffect(() => {
    if (sessionId && !findSession(tree, sessionId)) setSessionId(pickSession(tree));
    else if (!sessionId) setSessionId(pickSession(tree));
  }, [tree, sessionId]);

  useEffect(() => {
    if (sessionId && loaded === undefined) void useApp.getState().loadMessages(sessionId);
  }, [sessionId, loaded]);

  // A chat started here is listed in the main window once something is sent in it.
  useEffect(() => {
    if (sessionId && messages.length > 0 && startedHere.current.has(sessionId)) {
      startedHere.current.delete(sessionId);
      noteQuickSession(sessionId);
    }
  }, [sessionId, messages.length]);

  // Activity in the chat on screen is seen.
  const updatedAt = session?.updatedAt;
  useEffect(() => {
    if (sessionId && document.hasFocus()) useApp.getState().markSeen(sessionId);
  }, [sessionId, updatedAt, running, shownCount]);

  useEscapeToHide();

  // The window gets focus back when a file picker closes, even if it didn't report it.
  useEffect(() => {
    const onFocus = () => dialogOpen(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const newChat = async (projectId: string) => {
    const s = await useApp.getState().newSession(projectId);
    startedHere.current.add(s.id);
    select(s.id);
  };

  const shown = useMemo(() => settleStale(messages, running), [messages, running]);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const expanded = shown.length > 0 || running || hasPending;

  if (!session) {
    return (
      <Stage>
        <section className="quick-card expanded w-full">
          <div className="flex flex-col items-center gap-3 px-6 py-8 text-center text-sm text-muted-foreground">
            <p>Add a workspace in Harness to start chatting here.</p>
            <button
              className="rounded-full border bg-card px-4 py-1.5 text-xs text-foreground hover:bg-accent"
              onClick={() => openInMainWindow("")}
            >
              Open Harness
            </button>
          </div>
        </section>
      </Stage>
    );
  }

  return (
    <Stage>
      {/* Image previews open over the card rather than the whole (transparent) window. */}
      <section ref={setCard} className={cn("quick-card w-full", expanded && "expanded")}>
        <PreviewContainer.Provider value={card}>
          <div className="quick-chat">
            <MessageList messages={shown} running={running} sessionId={session.id} />
          </div>
          <Composer
            session={session}
            visible
            quick
            focusKey={shownCount}
            onDialog={dialogOpen}
            bar={<QuickBar session={session} onSelect={select} onNew={(p) => void newChat(p)} />}
          />
        </PreviewContainer.Provider>
      </section>
    </Stage>
  );
}

/** New chat, the workspace, its recent chats, and opening the chat in the main window. */
function QuickBar({ session, onSelect, onNew }: { session: Session; onSelect: (id: string) => void; onNew: (projectId: string) => void }) {
  const tree = useApp((s) => s.tree);
  const running = useApp((s) => s.running);
  const seen = useApp((s) => s.seen);
  const node = tree.find((n) => n.project.id === session.projectId);
  const projects = useMemo(() => [...tree].sort((a, b) => projectLastUsed(b) - projectLastUsed(a)), [tree]);
  const chips = useMemo(() => {
    const list = [...(node?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CHIP_COUNT);
    if (!list.some((s) => s.id === session.id)) list.unshift(session);
    return list;
  }, [node, session]);

  const pickProject = (projectId: string) => {
    const latest = [...(tree.find((n) => n.project.id === projectId)?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) onSelect(latest.id);
    else onNew(projectId);
  };

  return (
    <>
      <BarButton label="New chat" onClick={() => onNew(session.projectId)}>
        <SquarePen className="size-4" />
      </BarButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded-full bg-accent/60 px-2.5 text-xs outline-none hover:bg-accent data-[state=open]:bg-accent"
          >
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node?.project.name ?? "Workspace"}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="max-h-80 w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {projects.map((n) => (
            <DropdownMenuItem key={n.project.id} onSelect={() => pickProject(n.project.id)} className="text-xs">
              <Folder className="size-3.5 text-muted-foreground" />
              <span className="truncate">{n.project.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="listbox" aria-label="Chats">
        {chips.map((s) => {
          const current = s.id === session.id;
          const state = sessionState(s, !!running[s.id], current ? Date.now() : seen[s.id]);
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={current}
              title={s.title || "New chat"}
              onClick={() => onSelect(s.id)}
              className={cn(
                "flex h-7 max-w-36 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                current && "bg-accent text-foreground",
              )}
            >
              <ActivityIndicator state={state} className="-ml-1" />
              <span className="truncate">{s.title || "New chat"}</span>
            </button>
          );
        })}
      </div>
      <BarButton label="Open in Harness" onClick={() => openInMainWindow(session.id)}>
        <AppWindow className="size-4" />
      </BarButton>
    </>
  );
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] hover:bg-accent hover:text-foreground active:scale-[0.92]"
    >
      {children}
    </button>
  );
}

/**
 * Esc hides the window, unless it was closing something first (a menu, a dialog, the slash
 * command list): those are open when the key goes down, or handle it themselves.
 */
function useEscapeToHide() {
  useEffect(() => {
    let overlay = false;
    const capture = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        overlay = !!document.querySelector("[data-radix-popper-content-wrapper], [role=dialog], [role=menu]");
      }
    };
    const bubble = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !overlay && !e.defaultPrevented) hide();
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  }, []);
}

/** The theme changed in the main window: follow it. */
function useFollowTheme() {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "harness.theme" && e.newValue) useTheme.getState().setPref(e.newValue as ThemePref);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}

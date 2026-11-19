import { useEffect, useRef } from "react";
import type { Message } from "@/lib/backend";
import { useApp, useSession } from "@/stores/app-store";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

const EMPTY: Message[] = [];

/** One chat. `visible` is true while its tab is on screen. */
export function ChatView({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const session = useSession(sessionId);
  const project = useApp((s) => s.tree.find((n) => n.project.id === session?.projectId)?.project);
  const loaded = useApp((s) => s.messages[sessionId]);
  const messages = loaded ?? EMPTY;
  const running = useApp((s) => !!s.running[sessionId]);
  const loadMessages = useApp((s) => s.loadMessages);
  const markSeen = useApp((s) => s.markSeen);
  const container = useRef<HTMLDivElement>(null);
  useTypeToCompose(container, visible);

  const isLoaded = loaded !== undefined;
  useEffect(() => {
    if (!isLoaded) void loadMessages(sessionId);
  }, [sessionId, isLoaded, loadMessages]);

  // Activity in a chat you can see is seen immediately.
  const updatedAt = session?.updatedAt;
  useEffect(() => {
    if (visible) markSeen(sessionId);
  }, [visible, sessionId, updatedAt, running, markSeen]);

  if (!session) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chat not found</div>;
  }

  return (
    <div ref={container} className="flex h-full min-w-0 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <span className="text-lg font-medium text-foreground/70">{project?.name}</span>
        </div>
      ) : (
        <MessageList messages={messages} running={running} />
      )}
      <Composer session={session} visible={visible} />
    </div>
  );
}

/**
 * While the chat pane is the last place clicked, typing anywhere in it goes to the composer.
 * Clicks on message text don't move focus, so the last pointer-down location decides.
 */
function useTypeToCompose(container: React.RefObject<HTMLDivElement | null>, visible: boolean) {
  const inChat = useRef(false);
  // A chat brought to the front takes typing until something else is clicked.
  useEffect(() => {
    if (visible) inChat.current = true;
  }, [visible]);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      inChat.current = !!container.current?.contains(e.target as Node);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!visible || !inChat.current || e.defaultPrevented || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return; // printable keys only
      if (isTextEntry(document.activeElement) || document.querySelector("[role=dialog]")) return;
      const composer = container.current?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
      // Focusing during keydown lets the browser deliver this key to the composer.
      composer?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [container, visible]);
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset", "file"].includes(el.type);
  return (el as HTMLElement).isContentEditable || !!el.closest(".xterm");
}

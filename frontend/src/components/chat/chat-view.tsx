import { useEffect, useRef } from "react";
import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message } from "@/lib/backend";
import { useActiveProject, useActiveSession, useApp } from "@/stores/app-store";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

const EMPTY: Message[] = [];

export function ChatView() {
  const session = useActiveSession();
  const project = useActiveProject();
  const messages = useApp((s) => (session ? s.messages[session.id] : undefined)) ?? EMPTY;
  const running = useApp((s) => (session ? !!s.running[session.id] : false));
  const container = useRef<HTMLDivElement>(null);
  useTypeToCompose(container);

  if (!session) return <EmptyState />;

  return (
    <div ref={container} className="flex h-full min-w-0 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <span className="text-lg font-medium text-foreground/70">{project?.name}</span>
        </div>
      ) : (
        <MessageList messages={messages} running={running} />
      )}
      <Composer session={session} />
    </div>
  );
}

/**
 * While the chat pane is the last place clicked, typing anywhere in it goes to the composer.
 * Clicks on message text don't move focus, so the last pointer-down location decides.
 */
function useTypeToCompose(container: React.RefObject<HTMLDivElement | null>) {
  const inChat = useRef(true);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      inChat.current = !!container.current?.contains(e.target as Node);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!inChat.current || e.defaultPrevented || e.isComposing) return;
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
  }, [container]);
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset", "file"].includes(el.type);
  return (el as HTMLElement).isContentEditable || !!el.closest(".xterm");
}

function EmptyState() {
  const addProject = useApp((s) => s.addProject);
  return (
    <div className="flex h-full items-center justify-center">
      <Button variant="outline" onClick={() => void addProject()}>
        <FolderPlus /> Open folder
      </Button>
    </div>
  );
}

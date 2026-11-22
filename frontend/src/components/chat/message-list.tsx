import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import type { Message } from "@/lib/backend";
import { MessageItem } from "./message-item";

const STICK_THRESHOLD = 80;

type Props = { messages: Message[]; running: boolean };

export function MessageList({ messages, running }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Mirrors `stick` for rendering: the scroll-to-end button shows while scrolled up.
  const [atBottom, setAtBottom] = useState(true);

  // Follow new output only while the user is at the bottom.
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    setAtBottom(stick.current);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Always jump to the bottom when a new turn starts.
  useEffect(() => {
    if (running) {
      stick.current = true;
      setAtBottom(true);
    }
  }, [running]);

  const scrollToEnd = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
          {running && <TurnTimer since={lastUserMessageAt(messages)} />}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={scrollToEnd}
          aria-label="Scroll to end"
          title="Scroll to end"
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-md backdrop-blur-sm animate-in fade-in-0 zoom-in-90 hover:text-foreground"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  );
}

/** When the current turn started: the latest user message (survives app reloads). */
function lastUserMessageAt(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].createdAt;
  }
  return Date.now();
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Total time the agent has been working on the current turn. */
function TurnTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground tabular-nums">
      <Loader2 className="size-3 animate-spin" />
      {formatElapsed(now - since)}
    </div>
  );
}

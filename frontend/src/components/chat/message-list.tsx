import { useEffect, useLayoutEffect, useRef } from "react";
import type { Message } from "@/lib/backend";
import { MessageItem } from "./message-item";

const STICK_THRESHOLD = 80;

type Props = { messages: Message[]; running: boolean };

export function MessageList({ messages, running }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new output only while the user is at the bottom.
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Always jump to the bottom when a new turn starts.
  useEffect(() => {
    if (running) stick.current = true;
  }, [running]);

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        {running && <ThinkingDots />}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex gap-1 py-1">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </div>
  );
}

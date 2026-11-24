import { Loader2, Square } from "lucide-react";
import type { BackgroundTask } from "@/lib/backend";
import { useApp } from "@/stores/app-store";

const EMPTY: BackgroundTask[] = [];

const KIND: Record<string, string> = {
  local_bash: "Shell",
  local_agent: "Agent",
  monitor: "Monitor",
};

/** Background tasks still running in a chat, each with a stop button. */
export function TaskStrip({ sessionId }: { sessionId: string }) {
  const tasks = useApp((s) => s.tasks[sessionId] ?? EMPTY);
  const stopTask = useApp((s) => s.stopTask);
  if (tasks.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-col gap-0.5 rounded-lg border bg-card/60 px-2 py-1 text-xs">
      {tasks.map((t) => (
        <div key={t.id} className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin text-sky-500" />
          <span className="shrink-0 font-medium text-foreground/80">{KIND[t.type] ?? "Task"}</span>
          <span className="min-w-0 flex-1 truncate">{t.description}</span>
          <button
            onClick={() => void stopTask(sessionId, t.id)}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            title="Stop this task"
          >
            <Square className="size-2.5 fill-current" />
            Stop
          </button>
        </div>
      ))}
    </div>
  );
}

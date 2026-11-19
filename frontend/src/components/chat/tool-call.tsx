import { useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** One tool invocation: a single collapsed line that expands to show output. */
export function ToolCall({ part }: { part: Part }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!part.toolOutput;

  const status = !part.done ? (
    <Loader2 className="size-3 animate-spin" />
  ) : part.isError ? (
    <X className="size-3 text-destructive" />
  ) : (
    <Check className="size-3 text-emerald-500" />
  );

  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground",
          hasOutput && "hover:bg-accent/60",
        )}
      >
        <span className="shrink-0">{status}</span>
        <span className="shrink-0 font-medium text-foreground/80">{part.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{part.toolInput}</span>
        {hasOutput && <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />}
      </button>
      {open && (
        <pre className="mt-1 ml-7 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
          {part.toolOutput}
        </pre>
      )}
    </div>
  );
}

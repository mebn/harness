import { useState } from "react";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** One tool invocation: a single collapsed line that expands to show output. */
export function ToolCall({ part }: { part: Part }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!part.toolOutput;

  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground",
          hasOutput && "hover:bg-accent/60",
        )}
      >
        {/* No icons: a running tool pulses, a failed one is red. */}
        <span
          className={cn(
            "shrink-0 font-medium text-foreground/80",
            !part.done && "animate-pulse",
            part.done && part.isError && "text-destructive",
          )}
        >
          {part.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{part.toolInput}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
          {part.toolOutput}
        </pre>
      )}
    </div>
  );
}

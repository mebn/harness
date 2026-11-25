import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];

/** The model's (summarized) thinking: one muted line, expanded on click. */
export function ThinkingBlock({ part }: { part: Part }) {
  const [open, setOpen] = useState(false);
  const thinking = !part.done;
  const text = part.text ?? "";
  const firstLine = text.trim().split("\n")[0] ?? "";
  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className={cn("shrink-0 font-medium italic", thinking && "animate-pulse")}>{thinking ? "Thinking…" : "Thought"}</span>
        {!open && <span className="min-w-0 flex-1 truncate italic opacity-70">{firstLine}</span>}
      </button>
      {open && (
        <div className="prose-chat ml-[13px] border-l pl-3 text-xs text-muted-foreground italic select-text">
          <Markdown remarkPlugins={remarkPlugins}>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

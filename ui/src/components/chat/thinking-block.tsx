import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];

/** The model's (summarized) thinking, shown as it streams in muted text, as Claude Code does. */
export function ThinkingBlock({ part }: { part: Part }) {
  const thinking = !part.done;
  const text = (part.text ?? "").trim();
  return (
    <div className="my-1 px-2 text-xs text-muted-foreground">
      <span className={cn("font-medium italic", thinking && "animate-pulse")}>{thinking ? "Thinking…" : "Thought"}</span>
      {text && (
        <div className="prose-chat mt-0.5 border-l pl-3 text-xs italic select-text">
          <Markdown remarkPlugins={remarkPlugins}>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

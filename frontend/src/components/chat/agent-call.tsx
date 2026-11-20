import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { ToolCall } from "./tool-call";

const remarkPlugins = [remarkGfm];
/** Tool calls shown under a running subagent, like Claude Code: the latest few. */
const RECENT = 3;

/** Whether a tool call starts a subagent (named Task in older Claude Code versions). */
export const isAgentPart = (p: Part) => p.type === "tool" && (p.toolName === "Agent" || p.toolName === "Task");

/**
 * A subagent, shown the way Claude Code shows it: `Explore(description)`, its latest tool
 * calls while it works, then a one-line summary. Clicking expands every tool call it made and
 * its final report.
 */
export function AgentCall({ part, calls }: { part: Part; calls: Part[] }) {
  const [open, setOpen] = useState(false);
  const running = !part.done;
  const label = part.subagent && part.subagent !== "general-purpose" ? part.subagent : "Agent";
  const toolUses = part.agentToolUses || calls.length;
  const shown = open ? calls : running ? calls.slice(-RECENT) : [];
  const hidden = calls.length - shown.length;

  return (
    <div className="my-1.5 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span
          className={cn(
            "shrink-0 font-medium text-foreground/80",
            running && "animate-pulse",
            part.done && part.isError && "text-destructive",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate">{part.toolInput}</span>
      </button>

      <div className="ml-[13px] border-l pl-2">
        {shown.map((c) => (
          <ToolCall key={c.toolId} part={c} />
        ))}
        {(running || !open) && (
          <p className="px-2 py-0.5 text-muted-foreground/80 tabular-nums">
            {running ? (
              <>
                {hidden > 0 && `+${hidden} more tool ${hidden === 1 ? "use" : "uses"} · `}
                <Elapsed since={part.startedAt} />
              </>
            ) : (
              <span className={cn(part.isError && "text-destructive")}>
                {part.isError ? "Failed" : "Done"} ({summary(toolUses, part.agentTokens, duration(part))})
              </span>
            )}
          </p>
        )}
        {open && part.done && part.toolOutput && (
          <div className="prose-chat my-1 max-h-96 overflow-auto rounded-md bg-muted/50 px-3 py-2 text-xs select-text">
            <Markdown remarkPlugins={remarkPlugins}>{part.toolOutput}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function duration(p: Part): number | undefined {
  return p.startedAt && p.endedAt ? p.endedAt - p.startedAt : undefined;
}

function summary(toolUses: number, tokens: number | undefined, ms: number | undefined): string {
  const bits = [`${toolUses} tool ${toolUses === 1 ? "use" : "uses"}`];
  if (tokens) bits.push(`${formatTokens(tokens)} tokens`);
  if (ms !== undefined) bits.push(formatDuration(ms));
  return bits.join(" · ");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Time a running subagent has been working. */
function Elapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{since ? formatDuration(now - since) : "Working…"}</>;
}

import { useState, type ReactNode } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { Part } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { agentLabel, isAgentPart } from "./agent-call";
import { displayName } from "./tool-call";

/** Tool calls that stay on their own: the user took part in them (plans, questions). */
export const STANDALONE = new Set(["ExitPlanMode", "AskUserQuestion"]);

export type Segment = { part: Part; index: number } | { id: string; parts: { part: Part; index: number }[] };

const groupable = (p: Part) => p.type === "tool" && !STANDALONE.has(p.toolName ?? "");

/**
 * Splits a message's top-level parts into segments: runs of two or more tool calls become one
 * group; everything else stays a part of its own. Thinking, text and errors end a run, so
 * thinking always shows. A subagent's own calls (parentId) aren't top-level.
 */
export function segment(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  let run: { part: Part; index: number }[] = [];
  const flush = () => {
    const tools = run.filter((r) => r.part.type === "tool");
    if (tools.length >= 2) out.push({ id: tools[0].part.toolId || `${run[0].index}`, parts: run });
    else out.push(...run);
    run = [];
  };
  parts.forEach((part, index) => {
    if (part.parentId) return;
    if (groupable(part)) run.push({ part, index });
    else {
      flush();
      out.push({ part, index });
    }
  });
  flush();
  return out;
}

// Expanded groups, by their first tool call's id; kept while the app runs.
const expanded = new Set<string>();

/** A run of tool calls as one line ("Read 3 files, ran 2 commands") that expands to the calls. */
export function ToolGroup({ id, parts, children }: { id: string; parts: Part[]; children: ReactNode }) {
  const [open, setOpenState] = useState(() => expanded.has(id));
  const setOpen = (o: boolean) => {
    if (o) expanded.add(id);
    else expanded.delete(id);
    setOpenState(o);
  };
  const tools = parts.filter((p) => p.type === "tool");
  const failed = tools.filter((p) => p.done && p.isError).length;
  const active = [...parts].reverse().find((p) => !p.done);

  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 shrink truncate font-medium">{summarize(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        {active && (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            {!open && <ActiveLabel part={active} />}
          </span>
        )}
      </button>
      {open && <div className="ml-[13px] border-l pl-2">{children}</div>}
    </div>
  );
}

/** What the group is doing right now, shown while it's collapsed. */
function ActiveLabel({ part }: { part: Part }) {
  return (
    <>
      <span className="shrink-0 font-medium text-foreground/80">{isAgentPart(part) ? agentLabel(part) : displayName(part.toolName ?? "")}</span>
      <span className={cn("min-w-0 truncate", !isAgentPart(part) && "font-mono")}>{part.toolInput}</span>
    </>
  );
}

type Kind = "read" | "edit" | "search" | "command" | "fetch" | "web" | "agent" | "todo" | "other";

const KINDS: Record<string, Kind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  Search: "search",
  LS: "search",
  Bash: "command",
  PowerShell: "command",
  Shell: "command",
  WebFetch: "fetch",
  WebSearch: "web",
  Agent: "agent",
  Task: "agent",
  TodoWrite: "todo",
};

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "Read 3 files, edited 2 files, ran 1 command", in the order the kinds first appear. */
export function summarize(tools: Part[]): string {
  const byKind = new Map<Kind, Set<string>>();
  tools.forEach((p, i) => {
    const kind = KINDS[p.toolName ?? ""] ?? "other";
    // Files count once however often they're read or edited.
    const key = (kind === "read" || kind === "edit") && p.toolInput ? p.toolInput : p.toolId || `#${i}`;
    byKind.set(kind, (byKind.get(kind) ?? new Set()).add(key));
  });
  const phrases = [...byKind].map(([kind, keys]) => {
    const n = keys.size;
    switch (kind) {
      case "read":
        return `read ${count(n, "file")}`;
      case "edit":
        return `edited ${count(n, "file")}`;
      case "search":
        return `searched for ${count(n, "pattern")}`;
      case "command":
        return `ran ${count(n, "command")}`;
      case "fetch":
        return `fetched ${count(n, "page")}`;
      case "web":
        return n === 1 ? "searched the web" : `searched the web ${n} times`;
      case "agent":
        return `ran ${count(n, "agent")}`;
      case "todo":
        return "updated to-dos";
      case "other":
        return `used ${count(n, byKind.size > 1 ? "other tool" : "tool")}`;
    }
  });
  const text = phrases.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

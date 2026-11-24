import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, CircleX, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Message, Part } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { agentLabel, duration, Elapsed, formatDuration, isAgentPart, summary } from "./agent-call";
import { ToolCall, toolArgs } from "./tool-call";

const remarkPlugins = [remarkGfm];

/** A subagent and the tool calls it made. */
export type AgentEntry = { part: Part; calls: Part[] };

/** Every subagent in a chat, oldest first. */
export function collectAgents(messages: Message[]): AgentEntry[] {
  const out: AgentEntry[] = [];
  const byId = new Map<string, AgentEntry>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts ?? []) {
      if (p.parentId) byId.get(p.parentId)?.calls.push(p);
      if (isAgentPart(p) && p.toolId) {
        const entry = { part: p, calls: [] };
        byId.set(p.toolId, entry);
        out.push(entry);
      }
    }
  }
  return out;
}

function StatusIcon({ part, className }: { part: Part; className?: string }) {
  if (!part.done) return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-sky-500", className)} />;
  if (part.isError) return <CircleX className={cn("size-3.5 shrink-0 text-destructive", className)} />;
  return <Check className={cn("size-3.5 shrink-0 text-emerald-600", className)} />;
}

/** How long a subagent has run: live while it works. */
function AgentTime({ part }: { part: Part }) {
  if (!part.done) return <Elapsed since={part.startedAt} />;
  const ms = duration(part);
  return ms === undefined ? null : <>{formatDuration(ms)}</>;
}

/** One subagent in full: its prompt, every tool call it made and its report. Updates live. */
export function AgentDialog({ entry, open, onOpenChange }: { entry: AgentEntry | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open && !!entry} onOpenChange={onOpenChange}>
      {entry && (
        <DialogContent
          className="flex h-[min(720px,85vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <AgentDetails entry={entry} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function AgentDetails({ entry: { part, calls } }: { entry: AgentEntry }) {
  const prompt = useMemo(() => {
    const p = toolArgs(part)?.prompt;
    return typeof p === "string" ? p : "";
  }, [part.toolArgs]);
  const toolUses = part.agentToolUses || calls.length;

  return (
    <>
      <header className="shrink-0 border-b px-5 pt-4 pr-12 pb-3">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <StatusIcon part={part} />
          {agentLabel(part)}
        </DialogTitle>
        <DialogDescription className="mt-1 text-xs">{part.toolInput || "Subagent"}</DialogDescription>
        <p className={cn("mt-1 text-[11px] text-muted-foreground tabular-nums", part.done && part.isError && "text-destructive")}>
          {!part.done ? (
            <>
              Running · {toolUses} tool {toolUses === 1 ? "use" : "uses"} · <AgentTime part={part} />
            </>
          ) : (
            `${part.isError ? "Failed" : "Done"} · ${summary(toolUses, part.agentTokens, duration(part))}`
          )}
        </p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
        {prompt && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground">Prompt</h3>
            <div className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 whitespace-pre-wrap select-text">{prompt}</div>
          </section>
        )}
        <section>
          <h3 className="mb-1 font-medium text-muted-foreground">Tool calls</h3>
          {calls.length === 0 ? (
            <p className="px-2 text-muted-foreground/80">{part.done ? "None" : "None yet"}</p>
          ) : (
            calls.map((c, i) => <ToolCall key={c.toolId || i} part={c} />)
          )}
        </section>
        {part.done && part.toolOutput && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground">{part.isError ? "Error" : "Report"}</h3>
            <div className="prose-chat rounded-md bg-muted/50 px-3 py-2 text-xs select-text">
              <Markdown remarkPlugins={remarkPlugins}>{part.toolOutput}</Markdown>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/** A chip listing a chat's running subagents, shown only while any run; picking one opens it. */
export function AgentsOverview({ agents, onOpen }: { agents: AgentEntry[]; onOpen: (toolId: string) => void }) {
  const running = agents.filter((a) => !a.part.done);
  if (running.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded-full border bg-background px-2.5 text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
        >
          <Loader2 className="size-3 animate-spin text-sky-500" />
          <span className="tabular-nums">
            {running.length} {running.length === 1 ? "agent" : "agents"} running
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-[60vh] w-80">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Running subagents</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {running.map(({ part }) => (
          <DropdownMenuItem key={part.toolId} onSelect={() => onOpen(part.toolId!)} className="items-start text-xs">
            <StatusIcon part={part} className="mt-px" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{agentLabel(part)}</span>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  <AgentTime part={part} />
                </span>
              </div>
              <p className="truncate text-muted-foreground">{part.toolInput}</p>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

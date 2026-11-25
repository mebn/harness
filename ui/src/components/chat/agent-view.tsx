import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Bot, Check, CircleX, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Message, Part } from "@/lib/backend";
import { tabsOf } from "@/lib/layout-tree";
import { cn } from "@/lib/utils";
import { findSession, useApp } from "@/stores/app-store";
import { useGroups } from "@/stores/group-store";
import { agentLabel, duration, Elapsed, formatDuration, isAgentPart, summary } from "./agent-call";
import { settleStale } from "./chat-view";
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

/** A subagent's tab name: its type and task. */
export function tabTitle(part: Part): string {
  return part.toolInput ? `${agentLabel(part)}: ${part.toolInput}` : agentLabel(part);
}

/** The id Claude Code gave the subagent (for SendMessage), from its result once it has one. */
function cliAgentId(part: Part): string | undefined {
  return part.toolOutput?.match(/agentId:\s*([\w-]+)/)?.[1];
}

/**
 * What the main agent gets when the user writes to a subagent. The CLI has no way to send to a
 * subagent directly, so the main agent passes it on with SendMessage.
 */
function relayPrompt(part: Part, text: string): string {
  const id = cliAgentId(part);
  const ref = id ? `agent ID ${id}` : `Agent call ${part.toolId}`;
  const who = `the ${agentLabel(part)} subagent "${part.toolInput || "untitled"}" (${ref})`;
  return `Message for ${who}. Pass it on to that subagent with SendMessage, word for word, rather than acting on it yourself:\n\n${text}`;
}

const EMPTY: Message[] = [];

/**
 * One subagent in a tab of its own: its task, every tool call it made and its report, live.
 * Tinted and labeled so it doesn't pass for a chat; what's typed goes to it through the main agent.
 */
export function AgentTab({
  sessionId,
  agentId,
  groupId,
  visible,
}: {
  sessionId: string;
  agentId: string;
  groupId: string;
  visible: boolean;
}) {
  const loaded = useApp((s) => s.messages[sessionId]);
  const running = useApp((s) => !!s.running[sessionId]);
  const chatTitle = useApp((s) => findSession(s.tree, sessionId)?.title) || "Chat";
  const loadMessages = useApp((s) => s.loadMessages);
  useEffect(() => {
    if (loaded === undefined) void loadMessages(sessionId);
  }, [sessionId, loaded, loadMessages]);
  const shown = useMemo(() => settleStale(loaded ?? EMPTY, running), [loaded, running]);
  const entry = useMemo(() => collectAgents(shown).find((a) => a.part.toolId === agentId), [shown, agentId]);
  // The chat it belongs to, when that's open in this group.
  const chatTab = useGroups((s) => {
    const g = s.groups.find((x) => x.id === groupId);
    return g ? tabsOf(g.root).find((t) => t.kind === "chat" && t.sessionId === sessionId)?.id : undefined;
  });

  return (
    <div className="flex h-full min-w-0 flex-col border-t-2 border-sky-500/70 bg-sky-500/[0.04]">
      <header className="shrink-0 border-b border-sky-500/20 bg-sky-500/[0.06] px-5 py-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 font-medium tracking-wide text-sky-700 uppercase dark:text-sky-300">
            <Bot className="size-3" />
            Subagent
          </span>
          <span className="min-w-0 truncate">
            of{" "}
            {chatTab ? (
              <button
                className="font-medium text-foreground/80 hover:underline"
                onClick={() => useGroups.getState().selectTab(groupId, chatTab)}
              >
                {chatTitle}
              </button>
            ) : (
              <span className="font-medium text-foreground/80">{chatTitle}</span>
            )}
          </span>
        </div>
        {entry && <AgentHeading entry={entry} />}
      </header>
      {entry ? (
        <>
          <AgentBody entry={entry} />
          <RelayInput sessionId={sessionId} part={entry.part} running={running} visible={visible} />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {loaded === undefined ? "Loading…" : "This subagent is no longer in the chat."}
        </div>
      )}
    </div>
  );
}

function AgentHeading({ entry: { part, calls } }: { entry: AgentEntry }) {
  const toolUses = part.agentToolUses || calls.length;
  return (
    <>
      <h2 className="mt-2 flex min-w-0 items-center gap-2 text-sm font-semibold">
        <StatusIcon part={part} />
        <span className="shrink-0">{agentLabel(part)}</span>
        <span className="min-w-0 truncate font-normal text-muted-foreground">{part.toolInput}</span>
      </h2>
      <p className={cn("mt-0.5 text-[11px] text-muted-foreground tabular-nums", part.done && part.isError && "text-destructive")}>
        {!part.done ? (
          <>
            Running · {toolUses} tool {toolUses === 1 ? "use" : "uses"} · <AgentTime part={part} />
          </>
        ) : (
          `${part.isError ? "Failed" : "Done"} · ${summary(toolUses, part.agentTokens, duration(part))}`
        )}
      </p>
    </>
  );
}

function AgentBody({ entry: { part, calls } }: { entry: AgentEntry }) {
  const prompt = useMemo(() => {
    const p = toolArgs(part)?.prompt;
    return typeof p === "string" ? p : "";
  }, [part.toolArgs]);
  // Follows new tool calls while scrolled to the bottom.
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [calls.length, part.done]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-4 text-xs">
        {prompt && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground">Task from the main agent</h3>
            <div className="max-h-48 overflow-auto rounded-md border border-sky-500/20 bg-background/60 p-2 whitespace-pre-wrap select-text">
              {prompt}
            </div>
          </section>
        )}
        <section>
          <h3 className="mb-1 font-medium text-muted-foreground">Tool calls</h3>
          {calls.length === 0 && part.done ? (
            <p className="px-2 text-muted-foreground/80">None</p>
          ) : (
            calls.map((c, i) => <ToolCall key={c.toolId || i} part={c} />)
          )}
          {!part.done && (
            <p className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-sky-500" /> Working…
            </p>
          )}
        </section>
        {part.done && part.toolOutput && (
          <section>
            <h3 className="mb-1 font-medium text-muted-foreground">{part.isError ? "Error" : "Report to the main agent"}</h3>
            <div className="prose-chat rounded-md border border-sky-500/20 bg-background/60 px-3 py-2 text-xs select-text">
              <Markdown remarkPlugins={remarkPlugins}>{part.toolOutput}</Markdown>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Writes to the subagent: sent into the chat for the main agent to pass on. */
function RelayInput({ sessionId, part, running, visible }: { sessionId: string; part: Part; running: boolean; visible: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useApp((s) => s.send);
  const steer = useApp((s) => s.steer);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [visible]);
  // Grow with content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setError(null);
    try {
      // While the main agent works, the message goes into its turn rather than waiting for it.
      const queued = await send(sessionId, relayPrompt(part, body));
      if (running && queued) await steer(sessionId, queued);
    } catch (e) {
      setText(body);
      setError(String(e));
    }
  };

  return (
    <div className="shrink-0 border-t border-sky-500/20 px-6 pt-2 pb-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-dashed border-sky-500/40 bg-background px-3 py-2 focus-within:border-sky-500/70">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={`Message ${agentLabel(part)}…`}
            className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim()}
            aria-label="Send to subagent"
            title="Send to subagent (↵)"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
        <p className={cn("mt-1 px-1 text-[11px] text-muted-foreground", error && "text-destructive")}>
          {error ?? "Sent through the main agent, which passes it on to this subagent with SendMessage."}
        </p>
      </div>
    </div>
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

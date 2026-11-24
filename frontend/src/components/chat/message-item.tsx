import { memo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import { PreviewableImage } from "@/components/common/image-preview";
import remarkGfm from "remark-gfm";
import type { Message, Part } from "@/lib/backend";
import { AttachmentView } from "./attachment-view";
import { AgentCall, isAgentPart } from "./agent-call";
import { MessageActions } from "./message-actions";
import { ThinkingBlock } from "./thinking-block";
import { ToolCall } from "./tool-call";
import { segment, STANDALONE, summarize, ToolGroup } from "./tool-group";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];
/** Images in replies open in the app's preview rather than the system browser. */
const markdownComponents: Components = {
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <PreviewableImage src={src} alt={alt}>
        <img src={src} alt={alt ?? ""} className="max-h-80 rounded-md border" />
      </PreviewableImage>
    ) : null,
};

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return (
        <div className="prose-chat">
          <Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>{part.text ?? ""}</Markdown>
        </div>
      );
    case "thinking":
      return <ThinkingBlock part={part} />;
    case "tool":
      return <ToolCall part={part} />;
    case "error":
      return <p className="my-2 text-xs whitespace-pre-wrap text-destructive select-text">{part.text}</p>;
    default:
      return null;
  }
}

/**
 * Where a finished reply's answer starts: the trailing run of text, errors and tool calls
 * the user took part in (plans, questions). Everything before it is the work that led there.
 */
function answerStart(parts: Part[]): number {
  let i = parts.length;
  while (i > 0) {
    const p = parts[i - 1];
    const shown = p.parentId || p.type === "text" || p.type === "error" || (p.type === "tool" && STANDALONE.has(p.toolName ?? ""));
    if (!shown) break;
    i--;
  }
  return i;
}

// Finished replies whose work is expanded, by message id; kept while the app runs.
const workExpanded = new Set<string>();

/** A finished reply's thinking, tool calls and interim text as one line that expands to them. */
function WorkSection({ id, parts, children }: { id: string; parts: Part[]; children: ReactNode }) {
  const [open, setOpenState] = useState(() => workExpanded.has(id));
  const setOpen = (o: boolean) => {
    if (o) workExpanded.add(id);
    else workExpanded.delete(id);
    setOpenState(o);
  };
  const tools = parts.filter((p) => p.type === "tool" && !p.parentId);
  const failed = tools.filter((p) => p.isError).length;
  return (
    <div className="mb-2 text-xs">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 shrink truncate font-medium">{tools.length ? summarize(tools) : "Thought"}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
      </button>
      {open && <div className="ml-[13px] border-l pl-3 text-sm">{children}</div>}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, live = false }: { message: Message; live?: boolean }) {
  const parts = message.parts ?? [];

  // Shown in the chat only (e.g. the model changed); never part of the conversation.
  if (message.role === "event") {
    const text = parts.map((p) => p.text).join(" ");
    return (
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground" role="separator">
        <div className="h-px flex-1 bg-border" />
        <span>{parts[0]?.type === "model-switch" ? `Switched model · ${text}` : text}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (message.role === "user") {
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    return (
      <div className="group/msg flex flex-col items-end gap-1">
        <AttachmentView parts={parts.filter((p) => p.type === "attachment")} />
        {text && (
          <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2 whitespace-pre-wrap select-text">{text}</div>
        )}
        <MessageActions message={message} />
      </div>
    );
  }

  // A subagent's tool calls are shown under its Agent call, not in the main flow.
  const byParent = new Map<string, Part[]>();
  for (const p of parts) {
    if (p.parentId) byParent.set(p.parentId, [...(byParent.get(p.parentId) ?? []), p]);
  }
  const view = (p: Part, i: number) =>
    isAgentPart(p) ? (
      <AgentCall key={p.toolId || i} part={p} calls={byParent.get(p.toolId ?? "") ?? []} />
    ) : (
      <PartView key={p.toolId || i} part={p} />
    );
  // Consecutive tool calls collapse into one line.
  const segments = segment(parts);
  const render = (list: typeof segments) =>
    list.map((s) =>
      "id" in s ? (
        <ToolGroup key={`group:${s.id}`} id={s.id} parts={s.parts.map((r) => r.part)}>
          {s.parts.map((r) => view(r.part, r.index))}
        </ToolGroup>
      ) : (
        view(s.part, s.index)
      ),
    );

  // Once the reply is finished, its work folds away behind one line and only the answer shows.
  const start = live ? 0 : answerStart(parts);
  const work = parts.slice(0, start);
  if (work.some((p) => p.type === "thinking" || p.type === "tool")) {
    const first = (s: (typeof segments)[number]) => ("id" in s ? s.parts[0].index : s.index);
    return (
      <div className="min-w-0">
        <WorkSection id={message.id} parts={work}>
          {render(segments.filter((s) => first(s) < start))}
        </WorkSection>
        {render(segments.filter((s) => first(s) >= start))}
      </div>
    );
  }
  return <div className="min-w-0">{render(segments)}</div>;
});

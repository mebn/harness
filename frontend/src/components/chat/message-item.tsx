import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import { PreviewableImage } from "@/components/common/image-preview";
import remarkGfm from "remark-gfm";
import type { Message, Part } from "@/lib/backend";
import { AttachmentView } from "./attachment-view";
import { AgentCall, isAgentPart } from "./agent-call";
import { MessageActions } from "./message-actions";
import { ThinkingBlock } from "./thinking-block";
import { ToolCall } from "./tool-call";
import { segment, ToolGroup } from "./tool-group";

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

export const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
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
  return (
    <div className="min-w-0">
      {segment(parts).map((s) =>
        "id" in s ? (
          <ToolGroup key={`group:${s.id}`} id={s.id} parts={s.parts.map((r) => r.part)}>
            {s.parts.map((r) => view(r.part, r.index))}
          </ToolGroup>
        ) : (
          view(s.part, s.index)
        ),
      )}
    </div>
  );
});

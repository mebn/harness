import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Part } from "@/lib/backend";
import { AttachmentView } from "./attachment-view";
import { ToolCall } from "./tool-call";

const remarkPlugins = [remarkGfm];

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return (
        <div className="prose-chat">
          <Markdown remarkPlugins={remarkPlugins}>{part.text ?? ""}</Markdown>
        </div>
      );
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

  if (message.role === "user") {
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    return (
      <div className="flex flex-col items-end gap-2">
        <AttachmentView parts={parts.filter((p) => p.type === "attachment")} />
        {text && (
          <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2 whitespace-pre-wrap select-text">{text}</div>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {parts.map((p, i) => (
        <PartView key={p.toolId || i} part={p} />
      ))}
    </div>
  );
});

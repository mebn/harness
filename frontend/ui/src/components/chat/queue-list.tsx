import { useState } from "react";
import { CornerDownRight, Loader2, Paperclip, Pencil, X } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { useApp } from "@/stores/app-store";
import type { QueuedMessage } from "@bindings/harness/server/internal/services/models";

const EMPTY: QueuedMessage[] = [];

/**
 * Messages waiting for the running turn, at the end of the chat: bubbles like sent messages but
 * outlined with a dashed border, since they aren't in the conversation yet. Each can be steered
 * in now, edited (back into the input) or dropped.
 */
export function QueueList({ sessionId }: { sessionId: string }) {
  const items = useApp((s) => s.queues[sessionId] ?? EMPTY);
  const running = useApp((s) => !!s.running[sessionId]);
  const canSteer = useApp((s) => {
    const sess = s.tree.flatMap((n) => n.sessions ?? []).find((x) => x.id === sessionId);
    return !!s.providers.find((p) => p.id === sess?.provider)?.steer;
  });
  const steer = useApp((s) => s.steer);
  const remove = useApp((s) => s.removeQueued);
  const putDraft = useApp((s) => s.putDraft);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  const run = (p: Promise<void>) => {
    setError(null);
    p.catch((e) => setError(String(e)));
  };
  const steerLabel = !running ? "Send now" : canSteer ? "Steer: send into the running turn now" : "Steer: stop the turn and send this next";

  return (
    <div className="flex flex-col gap-3">
      {items.map((q, i) => {
        const files = q.attachments?.length ?? 0;
        return (
          <div key={q.id} className="group/msg flex flex-col items-end gap-1">
            <div className="max-w-[85%] rounded-2xl border border-dashed border-foreground/30 px-4 py-2 whitespace-pre-wrap select-text">
              {files > 0 && (
                <span className="mr-2 inline-flex items-center gap-0.5 align-middle text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {files}
                </span>
              )}
              {q.text || <span className="text-muted-foreground">Attached files</span>}
            </div>
            <div className="flex h-6 items-center gap-1 text-[11px] text-muted-foreground">
              {q.steering ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Steering
                </>
              ) : (
                <>
                  <div className="flex items-center opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
                    <IconButton label={steerLabel} className="size-6 [&_svg]:size-3.5" onClick={() => run(steer(sessionId, q.id))}>
                      <CornerDownRight />
                    </IconButton>
                    {files === 0 && (
                      <IconButton
                        label="Edit"
                        className="size-6 [&_svg]:size-3.5"
                        onClick={() => run(remove(sessionId, q.id).then(() => putDraft(sessionId, q.text)))}
                      >
                        <Pencil />
                      </IconButton>
                    )}
                    <IconButton label="Remove" className="size-6 [&_svg]:size-3.5" onClick={() => run(remove(sessionId, q.id))}>
                      <X />
                    </IconButton>
                  </div>
                  {i === 0 && running ? "Next" : "Queued"}
                </>
              )}
            </div>
          </div>
        );
      })}
      {error && <p className="text-right text-xs text-destructive select-text">{error}</p>}
    </div>
  );
}

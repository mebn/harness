import { CornerDownRight, Loader2, Paperclip, Pencil, X } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { useApp } from "@/stores/app-store";
import type { QueuedMessage } from "@bindings/harness/internal/services/models";

const EMPTY: QueuedMessage[] = [];

type Props = {
  sessionId: string;
  /** Puts a queued message back in the composer for editing. */
  onEdit: (text: string) => void;
  onError: (err: string) => void;
};

/** Messages waiting for the running turn: steer one in now, edit it, or drop it. */
export function QueueList({ sessionId, onEdit, onError }: Props) {
  const items = useApp((s) => s.queues[sessionId] ?? EMPTY);
  const running = useApp((s) => !!s.running[sessionId]);
  const canSteer = useApp((s) => {
    const sess = s.tree.flatMap((n) => n.sessions ?? []).find((x) => x.id === sessionId);
    return !!s.providers.find((p) => p.id === sess?.provider)?.steer;
  });
  const steer = useApp((s) => s.steer);
  const remove = useApp((s) => s.removeQueued);

  if (items.length === 0) return null;

  const run = (p: Promise<void>) => p.catch((e) => onError(String(e)));
  const steerLabel = !running ? "Send now" : canSteer ? "Steer: send into the running turn now" : "Steer: stop the turn and send this next";

  return (
    <div className="mx-3 -mb-px flex flex-col overflow-hidden rounded-t-lg border border-b-0 bg-muted/40 text-xs">
      {items.map((q, i) => (
        <div key={q.id} className="group flex h-8 items-center gap-2 border-t px-2 first:border-t-0">
          <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
            {q.steering ? "Steering" : i === 0 && running ? "Next" : "Queued"}
          </span>
          {(q.attachments?.length ?? 0) > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <Paperclip className="size-3" />
              {q.attachments!.length}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{q.text || "Attached files"}</span>
          {q.steering ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex shrink-0 items-center opacity-60 group-hover:opacity-100">
              <IconButton label={steerLabel} className="size-6 [&_svg]:size-3.5" onClick={() => void run(steer(sessionId, q.id))}>
                <CornerDownRight />
              </IconButton>
              {(q.attachments?.length ?? 0) === 0 && (
                <IconButton
                  label="Edit"
                  className="size-6 [&_svg]:size-3.5"
                  onClick={() =>
                    void run(
                      remove(sessionId, q.id).then(() => {
                        onEdit(q.text);
                      }),
                    )
                  }
                >
                  <Pencil />
                </IconButton>
              )}
              <IconButton label="Remove" className="size-6 [&_svg]:size-3.5" onClick={() => void run(remove(sessionId, q.id))}>
                <X />
              </IconButton>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

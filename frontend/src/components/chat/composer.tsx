import { useEffect, useRef, useState } from "react";
import { ArrowUp, ListPlus, Paperclip, Square } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { Button } from "@/components/ui/button";
import { releasePreviews, toInputs, useAttachments } from "@/hooks/use-attachments";
import type { Session } from "@/lib/backend";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { AttachmentChips } from "./attachment-chips";
import { LocationPicker } from "./location-picker";
import { ModelPicker } from "./model-picker";
import { QueueList } from "./queue-list";
import { UsageIndicator } from "./usage-indicator";

const MAX_HEIGHT = 240;

export function Composer({ session, visible }: { session: Session; visible: boolean }) {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();
  const providers = useApp((s) => s.providers);
  const running = useApp((s) => !!s.running[session.id]);
  const send = useApp((s) => s.send);
  const steer = useApp((s) => s.steer);
  const stop = useApp((s) => s.stop);
  const update = useApp((s) => s.updateSettings);

  const provider = providers.find((p) => p.id === session.provider) ?? providers[0];
  // While a turn runs, sending queues the message (Alt+Enter steers it in right away).
  const canSend = text.trim() !== "" || attachments.items.length > 0;
  const error = sendError ?? attachments.error;

  // Focus the input when the chat comes to the front.
  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [visible]);

  // Grow with content up to MAX_HEIGHT.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = async (steerNow = false) => {
    if (!canSend) return;
    const prompt = text.trim();
    const pending = attachments.take();
    setText("");
    setSendError(null);
    attachments.setError(null);
    try {
      const queuedId = await send(session.id, prompt, await toInputs(pending));
      releasePreviews(pending);
      if (steerNow && queuedId) await steer(session.id, queuedId);
    } catch (e) {
      setText(prompt);
      attachments.restore(pending);
      setSendError(String(e));
    }
  };

  if (!provider) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="mb-1 flex justify-end">
        <UsageIndicator session={session} />
      </div>
      <QueueList
        sessionId={session.id}
        onEdit={(t) => {
          setText((cur) => (cur.trim() ? `${t}\n\n${cur}` : t));
          ref.current?.focus();
        }}
        onError={setSendError}
      />
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          attachments.add(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-xl border bg-card shadow-sm focus-within:border-ring/60",
          dragOver && "border-ring ring-2 ring-ring/30",
        )}
      >
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        <textarea
          ref={ref}
          data-composer
          value={text}
          rows={1}
          placeholder={running ? `Queue a message… (${isMac ? "⌥" : "Alt+"}↵ to steer)` : "Ask anything…"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Pasted screenshots and copied files become attachments.
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              attachments.add(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(e.altKey);
            }
          }}
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none select-text placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) attachments.add(e.target.files);
              e.target.value = ""; // allow picking the same file again
            }}
          />
          <ModelPicker
            providers={providers}
            provider={provider}
            session={session}
            onChange={(patch) => void update(session.id, patch)}
            lockProvider={running}
          />
          <div className="flex-1" />
          {running && (
            <Button size="icon" variant="secondary" className="size-8 rounded-lg" onClick={() => stop(session.id)} aria-label="Stop">
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          {(!running || canSend) && (
            <Button
              size="icon"
              className="ml-1 size-8 rounded-lg"
              disabled={!canSend}
              onClick={(e) => void submit(e.altKey)}
              aria-label={running ? "Queue" : "Send"}
              title={running ? `Queue (↵) · steer now (${isMac ? "⌥" : "Alt+"}↵)` : undefined}
            >
              {running ? <ListPlus className="size-4" /> : <ArrowUp className="size-4" />}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1 flex items-center px-1">
        <LocationPicker session={session} visible={visible} />
      </div>
    </div>
  );
}

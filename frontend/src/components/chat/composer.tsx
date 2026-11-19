import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/backend";
import { useApp } from "@/stores/app-store";
import { OptionPicker } from "./option-picker";

const MAX_HEIGHT = 240;

export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const providers = useApp((s) => s.providers);
  const running = useApp((s) => !!s.running[session.id]);
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const update = useApp((s) => s.updateSettings);

  const provider = providers.find((p) => p.id === session.provider) ?? providers[0];

  // Focus the input when switching sessions.
  useEffect(() => ref.current?.focus(), [session.id]);

  // Grow with content up to MAX_HEIGHT.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || running) return;
    setText("");
    setError(null);
    try {
      await send(session.id, prompt);
    } catch (e) {
      setText(prompt);
      setError(String(e));
    }
  };

  if (!provider) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="rounded-xl border bg-card shadow-sm focus-within:border-ring/60">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder="Ask anything…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none select-text placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <OptionPicker
            value={provider.id}
            options={providers.map((p) => ({ id: p.id, label: p.name }))}
            onChange={(id) => void update(session.id, { provider: id })}
            disabled={running}
          />
          <OptionPicker
            value={session.model}
            options={provider.models ?? []}
            onChange={(model) => void update(session.id, { model })}
          />
          <OptionPicker
            value={session.effort}
            options={provider.efforts ?? []}
            onChange={(effort) => void update(session.id, { effort })}
          />
          <OptionPicker
            value={session.mode}
            options={provider.modes ?? []}
            onChange={(mode) => void update(session.id, { mode })}
          />
          <div className="flex-1" />
          {running ? (
            <Button size="icon" variant="secondary" className="size-8 rounded-lg" onClick={() => stop(session.id)} aria-label="Stop">
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon" className="size-8 rounded-lg" disabled={!text.trim()} onClick={() => void submit()} aria-label="Send">
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

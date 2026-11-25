import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CornerDownRight, ListPlus, Plus, Square } from "lucide-react";
import { releasePreviews, toInputs, useAttachments } from "@/hooks/use-attachments";
import type { Session } from "@/lib/backend";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useSettings } from "@/stores/settings-store";
import { AttachmentChips } from "./attachment-chips";
import { LocationPicker } from "./location-picker";
import { ModelPicker } from "./model-picker";
import { PermissionPrompt } from "./permission-prompt";
import { SlashMenu, matchCommands, slashQuery } from "./slash-menu";
import { TaskStrip } from "./task-strip";
import { UsageIndicator } from "./usage-indicator";

const MAX_HEIGHT = 240;

type Props = {
  session: Session;
  /** The chat is on screen: the input takes focus when this turns true. */
  visible: boolean;
  /** Goes on the left of the row above the input (the usage indicator is on the right). */
  status?: ReactNode;
  /** The quick chat: no outer margins or branch picker; `bar` adds its own controls. */
  quick?: boolean;
  /** Controls at the start of the bar under the input. */
  bar?: ReactNode;
  /** Changing it focuses the input again (the quick chat being shown). */
  focusKey?: number;
  /** A native file picker opened (true) or closed (false). */
  onDialog?: (open: boolean) => void;
};

/**
 * The chat input, as in cmdcmd: one rounded box with the input between a round attach and a
 * round send button, and a bar of pickers under a hairline. While the agent works a ring
 * spins around the send button, which stops the turn when there is nothing to send.
 */
export function Composer({ session, visible, status, quick, bar, focusKey, onDialog }: Props) {
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
  const draft = useApp((s) => s.drafts[session.id]);
  const takeDraft = useApp((s) => s.takeDraft);
  const commands = useApp((s) => s.commands[session.id]);
  const loadCommands = useApp((s) => s.loadCommands);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);

  // A removed account's chats fall back to its CLI's own sign-in.
  const provider =
    providers.find((p) => p.id === session.provider) ??
    providers.find((p) => p.id === session.provider.split("@")[0]) ??
    providers[0];

  // Text handed over (a rewind, fork or edited queued message) goes into the input, ahead of
  // anything already typed there.
  useEffect(() => {
    if (draft === undefined) return;
    const t = takeDraft(session.id);
    if (t !== undefined) {
      setText((cur) => (cur.trim() ? `${t}\n\n${cur}` : t));
      ref.current?.focus();
    }
  }, [draft, session.id, takeDraft]);

  // Slash commands: offered while typing "/name".
  const query = provider?.interactive ? slashQuery(text) : null;
  const menuOpen = query !== null && !menuClosed;
  const matches = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);
  useEffect(() => {
    if (query !== null && commands === undefined) void loadCommands(session.id).catch(() => {});
  }, [query !== null, commands, loadCommands, session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMenuIndex(0), [query]);
  useEffect(() => {
    if (query === null) setMenuClosed(false);
  }, [query]);

  const pickCommand = (name: string, argumentHint: string) => {
    if (argumentHint) {
      setText(`/${name} `);
      ref.current?.focus();
    } else {
      void submit(false, `/${name}`);
    }
  };
  // While a turn runs, Enter queues the message or steers it in right away (per the setting);
  // Alt+Enter does the other.
  const steerByDefault = useSettings((s) => s.sendWhileRunning === "steer");
  const alt = isMac ? "⌥" : "Alt+";
  const canSend = text.trim() !== "" || attachments.items.length > 0;
  const error = sendError ?? attachments.error;

  // Focus the input when the chat comes to the front.
  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [visible, focusKey, session.id]);

  // Grow with content up to MAX_HEIGHT.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = async (otherMode = false, override?: string) => {
    const steerNow = otherMode !== steerByDefault;
    if (!canSend && override === undefined) return;
    const prompt = (override ?? text).trim();
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

  // Closing the file picker without choosing fires "cancel" (no React prop for it).
  useEffect(() => {
    const el = fileInput.current;
    if (!el || !onDialog) return;
    const closed = () => onDialog(false);
    el.addEventListener("cancel", closed);
    return () => el.removeEventListener("cancel", closed);
  }, [onDialog]);

  const pickFiles = () => {
    onDialog?.(true);
    fileInput.current?.click();
  };

  if (!provider) return null;

  // The send button: send, or while the agent works, steer/queue what's typed or stop.
  const stopping = running && !canSend;
  const sendLabel = stopping ? "Stop" : running ? (steerByDefault ? "Steer" : "Queue") : "Send";
  const sendTitle = stopping
    ? "Stop"
    : running
      ? steerByDefault
        ? `Steer now (↵) · queue (${alt}↵)`
        : `Queue (↵) · steer now (${alt}↵)`
      : "Send (↵)";

  return (
    <div className={cn("w-full", !quick && "mx-auto max-w-3xl px-4 pb-4")}>
      {error && <p className="mb-2 px-2 text-xs text-destructive">{error}</p>}
      {(!quick || status) && (
        <div className="mb-1 flex min-h-6 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">{status}</div>
          {!quick && <UsageIndicator session={session} />}
        </div>
      )}
      <PermissionPrompt sessionId={session.id} />
      <TaskStrip sessionId={session.id} />
      {menuOpen && (
        <SlashMenu
          items={matches}
          loading={commands === undefined}
          index={menuIndex}
          onHover={setMenuIndex}
          onPick={(c) => pickCommand(c.name, c.argumentHint)}
        />
      )}
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
          "composer-box flex flex-col border bg-card transition-[box-shadow,border-color] duration-150",
          quick ? "rounded-[1.375rem]" : "rounded-2xl",
          dragOver && "border-ring ring-2 ring-ring/30",
        )}
      >
        <div className={cn("flex flex-wrap items-center", quick ? "gap-x-2 p-3" : "gap-x-1.5 p-2")}>
          <div className="basis-full pb-2 empty:hidden [&>div]:px-0 [&>div]:pt-0">
            <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
          </div>
          <button
            type="button"
            onClick={pickFiles}
            aria-label="Attach files"
            title="Attach files or images"
            className={cn(
              "flex shrink-0 items-center justify-center self-center rounded-full text-muted-foreground transition-[background-color,color,transform] hover:bg-accent hover:text-foreground active:scale-[0.92]",
              quick ? "size-[1.875rem]" : "size-7",
            )}
          >
            <Plus className={quick ? "size-[1.125rem]" : "size-4"} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              onDialog?.(false);
              if (e.target.files) attachments.add(e.target.files);
              e.target.value = ""; // allow picking the same file again
            }}
          />
          <textarea
            ref={ref}
            data-composer
            value={text}
            rows={1}
            placeholder={
              running
                ? steerByDefault
                  ? `Steer the agent… (${alt}↵ to queue)`
                  : `Queue a message… (${alt}↵ to steer)`
                : provider.interactive
                  ? "Ask anything… (/ for commands)"
                  : "Ask anything…"
            }
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // Pasted screenshots and copied files become attachments.
              if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                attachments.add(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (menuOpen && matches.length > 0 && !e.nativeEvent.isComposing) {
                const pick = matches[Math.min(menuIndex, matches.length - 1)];
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setMenuIndex((i) => (i + d + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  if (e.key === "Tab") {
                    setText(`/${pick.name} `);
                  } else {
                    pickCommand(pick.name, pick.argumentHint);
                  }
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenuClosed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e.altKey);
              }
            }}
            className={cn(
              "block max-h-60 min-w-0 flex-1 resize-none bg-transparent outline-none select-text placeholder:text-muted-foreground/70",
              quick ? "min-h-[1.625rem] text-lg leading-[1.625rem] tracking-[-0.012em]" : "min-h-5 text-sm leading-5",
            )}
          />
          <button
            type="button"
            disabled={!running && !canSend}
            onClick={(e) => (stopping ? stop(session.id) : void submit(e.altKey))}
            aria-label={sendLabel}
            title={sendTitle}
            className={cn(
              "relative flex shrink-0 items-center justify-center self-center rounded-full bg-primary text-primary-foreground transition-[background-color,color,transform]",
              "enabled:hover:scale-[1.06] enabled:active:scale-[0.92] disabled:bg-muted disabled:text-muted-foreground",
              quick ? "size-[2.375rem]" : "size-8",
            )}
          >
            {stopping ? (
              <Square className="size-3.5 fill-current" />
            ) : !running ? (
              <ArrowUp className={quick ? "size-[1.125rem]" : "size-4"} strokeWidth={2.4} />
            ) : steerByDefault ? (
              <CornerDownRight className="size-4" />
            ) : (
              <ListPlus className="size-4" />
            )}
            {running && (
              <span className="pointer-events-none absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-primary [animation-duration:0.9s]" />
            )}
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1 border-t px-1.5 py-1">
          {bar}
          <ModelPicker
            providers={providers}
            provider={provider}
            session={session}
            onChange={(patch) => void update(session.id, patch)}
            lockProvider={running}
          />
          {!quick && (
            <div className="min-w-0">
              <LocationPicker session={session} visible={visible} />
            </div>
          )}
          {quick && (
            <div className="ml-auto shrink-0">
              <UsageIndicator session={session} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

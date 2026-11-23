import { useState } from "react";
import { GitFork, Undo2 } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatService, type Message } from "@/lib/backend";
import { useApp } from "@/stores/app-store";
import { useGroups } from "@/stores/group-store";

/**
 * Rewind and fork for one of your messages, like Claude Code's /rewind: go back to just
 * before it (the conversation, the code, or both), or continue from there in a new chat.
 */
export function MessageActions({ message }: { message: Message }) {
  const running = useApp((s) => !!s.running[message.sessionId]);
  const rewind = useApp((s) => s.rewind);
  const fork = useApp((s) => s.fork);
  const openChat = useGroups((s) => s.openChat);
  const [files, setFiles] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (!message.cliUuid) return null;

  const run = async (what: () => Promise<string | void>) => {
    setStatus(null);
    try {
      const note = await what();
      if (note) setStatus(note);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const restore = (conversation: boolean, code: boolean) =>
    run(async () => {
      const res = await rewind(message.sessionId, message.id, conversation, code);
      if (code && !conversation) {
        const n = res.filesChanged?.length ?? 0;
        return n === 0 ? "No files to restore" : `Restored ${n} ${n === 1 ? "file" : "files"}`;
      }
    });

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 has-[[data-state=open]]:opacity-100">
      {status && <span className="mr-1 text-[11px] text-muted-foreground">{status}</span>}
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          setFiles(null);
          ChatService.RewindPreview(message.sessionId, message.id)
            .then((f) => setFiles(f ?? []))
            .catch(() => setFiles([]));
        }}
      >
        <DropdownMenuTrigger asChild>
          <IconButton label="Rewind to before this message" className="size-6 [&_svg]:size-3.5" disabled={running}>
            <Undo2 />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Go back to before this message.{" "}
            {files === null
              ? "Checking files…"
              : files.length === 0
                ? "No file changes since then."
                : `${files.length} ${files.length === 1 ? "file" : "files"} changed since then.`}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void restore(true, true)} disabled={!files?.length}>
            Restore conversation and code
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void restore(true, false)}>Restore conversation only</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void restore(false, true)} disabled={!files?.length}>
            Restore code only
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton
        label="Fork: continue from before this message in a new chat"
        className="size-6 [&_svg]:size-3.5"
        onClick={() =>
          void run(async () => {
            const session = await fork(message.sessionId, message.id);
            openChat(session);
          })
        }
      >
        <GitFork />
      </IconButton>
    </div>
  );
}

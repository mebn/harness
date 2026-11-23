import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChatService, type ClaudeChat, type Project } from "@/lib/backend";
import { timeAgo, useNow } from "@/lib/time";
import { useApp } from "@/stores/app-store";
import { useGroups } from "@/stores/group-store";

/** Lists Claude Code conversations started in a workspace's folder and adds one as a chat. */
export function ImportChatDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [chats, setChats] = useState<ClaudeChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const importChat = useApp((s) => s.importClaudeChat);
  const openChat = useGroups((s) => s.openChat);
  const now = useNow();

  useEffect(() => {
    if (!open) return;
    setChats(null);
    setError(null);
    ChatService.ClaudeChats(project.id, "")
      .then((list) => setChats(list ?? []))
      .catch((e) => setError(String(e)));
  }, [open, project.id]);

  const pick = async (c: ClaudeChat) => {
    setBusy(c.id);
    setError(null);
    try {
      const session = await importChat(project.id, "", c.id);
      onOpenChange(false);
      openChat(session);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a Claude Code chat</DialogTitle>
          <DialogDescription>
            Conversations started with the claude CLI in {project.name}. The imported chat continues the same conversation.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {chats === null && !error && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Looking for conversations…
          </p>
        )}
        {chats?.length === 0 && <p className="text-xs text-muted-foreground">No conversations to import in this folder.</p>}
        {chats && chats.length > 0 && (
          <div className="-mx-2 max-h-80 overflow-y-auto">
            {chats.map((c) => (
              <button
                key={c.id}
                disabled={busy !== null}
                onClick={() => void pick(c)}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {busy === c.id ? (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(c.updatedAt, now)}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

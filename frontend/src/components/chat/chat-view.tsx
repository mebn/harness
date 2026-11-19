import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message } from "@/lib/backend";
import { useActiveProject, useActiveSession, useApp } from "@/stores/app-store";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

const EMPTY: Message[] = [];

export function ChatView() {
  const session = useActiveSession();
  const project = useActiveProject();
  const messages = useApp((s) => (session ? s.messages[session.id] : undefined)) ?? EMPTY;
  const running = useApp((s) => (session ? !!s.running[session.id] : false));

  if (!session) return <EmptyState />;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <span className="text-lg font-medium text-foreground/70">{project?.name}</span>
        </div>
      ) : (
        <MessageList messages={messages} running={running} />
      )}
      <Composer session={session} />
    </div>
  );
}

function EmptyState() {
  const addProject = useApp((s) => s.addProject);
  return (
    <div className="flex h-full items-center justify-center">
      <Button variant="outline" onClick={() => void addProject()}>
        <FolderPlus /> Open folder
      </Button>
    </div>
  );
}

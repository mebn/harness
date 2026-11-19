import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Session } from "@/lib/backend";
import { sessionState } from "@/lib/session-state";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";

export function SessionItem({ session }: { session: Session }) {
  const [editing, setEditing] = useState(false);
  const active = useApp((s) => s.activeSessionId === session.id);
  const state = useApp((s) => sessionState(session, !!s.running[session.id], s.seen[session.id]));
  const select = useApp((s) => s.selectSession);
  const rename = useApp((s) => s.renameSession);
  const remove = useApp((s) => s.deleteSession);
  const now = useNow();

  return (
    <div
      role="button"
      onClick={() => void select(session.id)}
      onDoubleClick={() => setEditing(true)}
      className={cn(
        "group flex h-7 cursor-default items-center gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      {/* Fixed-width slot keeps titles aligned whether or not a state is shown. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <ActivityIndicator state={state} />
      </span>
      {editing ? (
        <InlineEdit
          value={session.title}
          onSubmit={(v) => {
            setEditing(false);
            void rename(session.id, v);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span className={cn("flex-1 truncate", STATE_TEXT[state])}>{session.title}</span>
      )}
      <HoverSwap idle={timeAgo(session.updatedAt, now)}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <button aria-label="Session options" className="rounded p-0.5 hover:text-foreground">
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void remove(session.id)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </HoverSwap>
    </div>
  );
}

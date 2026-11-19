import { useState } from "react";
import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectTree } from "@/lib/backend";
import { projectLastUsed, sessionState, strongest } from "@/lib/session-state";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";
import { SessionItem } from "./session-item";

export function ProjectItem({ node }: { node: ProjectTree }) {
  const { project } = node;
  const sessions = node.sessions ?? [];
  const [editing, setEditing] = useState(false);
  const toggle = useApp((s) => s.toggleProject);
  const newSession = useApp((s) => s.newSession);
  const rename = useApp((s) => s.renameProject);
  const remove = useApp((s) => s.removeProject);
  const now = useNow();
  // The folder shows the most urgent state among its sessions.
  const state = useApp((s) => strongest(sessions.map((x) => sessionState(x, !!s.running[x.id], s.seen[x.id]))));

  return (
    <Collapsible open={project.expanded}>
      <div
        role="button"
        onClick={() => void toggle(project.id)}
        title={project.path}
        className="group flex h-8 cursor-default items-center gap-1.5 rounded-md px-1.5 hover:bg-sidebar-accent"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", project.expanded && "rotate-90")}
        />
        {state !== "idle" && <ActivityIndicator state={state} />}
        {editing ? (
          <InlineEdit
            value={project.name}
            onSubmit={(v) => {
              setEditing(false);
              void rename(project.id, v);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className={cn("flex-1 truncate font-medium", STATE_TEXT[state])}>{project.name}</span>
        )}
        {project.env === "wsl" && (
          <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">WSL</span>
        )}

        <HoverSwap idle={timeAgo(projectLastUsed(node), now)}>
          <button
            aria-label="New session"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              void newSession(project.id);
            }}
          >
            <Plus className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <button aria-label="Project options" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(project.id)}>
                <Trash2 /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </HoverSwap>
      </div>

      <CollapsibleContent>
        <div className="ml-3.5 flex flex-col gap-0.5 border-l border-sidebar-border py-0.5 pl-2">
          {sessions.map((s) => (
            <SessionItem key={s.id} session={s} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

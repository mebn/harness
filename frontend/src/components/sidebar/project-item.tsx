import { useMemo, useState } from "react";
import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectTree } from "@/lib/backend";
import { projectLastUsed, sessionState, strongest } from "@/lib/session-state";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useDrag } from "@/stores/drag-store";
import { canElevate, groupActivity, useGroups } from "@/stores/group-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";
import { GroupItem } from "./group-item";

export function ProjectItem({ node }: { node: ProjectTree }) {
  const { project } = node;
  const sessions = node.sessions ?? [];
  const [editing, setEditing] = useState(false);
  // The ⋯ menu; right-clicking the row opens it too.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useApp((s) => s.toggleProject);
  const newGroup = useGroups((s) => s.newGroup);
  const allGroups = useGroups((s) => s.groups);
  const tree = useApp((s) => s.tree);
  // Most recently active first, like the workspaces themselves.
  const groups = useMemo(
    () =>
      allGroups
        .filter((g) => g.projectId === project.id)
        .sort((a, b) => groupActivity(b, tree) - groupActivity(a, tree)),
    [allGroups, project.id, tree],
  );
  // A tab or window from this workspace dragged over the sidebar lands here as a new group.
  const dropHere = useDrag((s) => s.drag?.projectId === project.id && s.drag.target?.kind === "newGroup");
  const rename = useApp((s) => s.renameProject);
  const remove = useApp((s) => s.removeProject);
  const setAdminTerminals = useApp((s) => s.setAdminTerminals);
  const elevatable = useApp((s) => canElevate(project, s.system.os));
  const now = useNow();
  // The folder shows the most urgent state among its sessions.
  const state = useApp((s) => strongest(sessions.map((x) => sessionState(x, !!s.running[x.id], s.seen[x.id]))));

  return (
    <Collapsible open={project.expanded}>
      <div
        role="button"
        onClick={() => void toggle(project.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
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
            aria-label="New group"
            title={`New group (${shortcutLabel("newGroup")})`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              void newGroup(project.id);
            }}
          >
            <Plus className="size-3.5" />
          </button>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <button aria-label="Project options" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil /> Rename
              </DropdownMenuItem>
              {elevatable && (
                <DropdownMenuCheckboxItem
                  checked={project.adminTerminals}
                  onCheckedChange={(v) => void setAdminTerminals(project.id, v === true)}
                >
                  Terminals as admin
                </DropdownMenuCheckboxItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(project.id)}>
                <Trash2 /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </HoverSwap>
      </div>

      <CollapsibleContent>
        <div className="ml-3.5 flex flex-col gap-0.5 border-l border-sidebar-border py-0.5 pl-2">
          {groups.map((g) => (
            <GroupItem key={g.id} group={g} />
          ))}
          {groups.length === 0 && !dropHere && (
            <button
              onClick={() => void newGroup(project.id)}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-3.5" /> New group
            </button>
          )}
        </div>
      </CollapsibleContent>
      {dropHere && (
        <div className="mt-0.5 ml-3.5 border-l border-sidebar-border py-0.5 pl-2">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-dashed border-ring/70 bg-ring/10 px-1.5 text-xs text-foreground animate-in fade-in-0 slide-in-from-top-1 duration-150">
            <Plus className="size-3.5" /> New group
          </div>
        </div>
      )}
    </Collapsible>
  );
}

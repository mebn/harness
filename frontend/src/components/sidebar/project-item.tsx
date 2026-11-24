import { useState } from "react";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectTree } from "@/lib/backend";
import { projectLastUsed, sessionState, strongest } from "@/lib/session-state";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useDrag } from "@/stores/drag-store";
import { canElevate, moveGroupTo, useGroups, type Group } from "@/stores/group-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";
import { GroupItem } from "./group-item";
import { useLiveReorder } from "./use-live-reorder";
import { WorkspaceIcon } from "./workspace-icon";

/** Marks the slot a dragged tab or window would become a new group in. */
const PLACEHOLDER = "\u0000new-group";

export function ProjectItem({
  node,
  groups,
  dragging,
}: {
  node: ProjectTree;
  groups: Group[];
  /** Being dragged to a new position. */
  dragging?: boolean;
}) {
  const { project } = node;
  const sessions = node.sessions ?? [];
  const [editing, setEditing] = useState(false);
  // The ⋯ menu; right-clicking the row opens it too.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useApp((s) => s.toggleProject);
  const newGroup = useGroups((s) => s.newGroup);
  const rename = useApp((s) => s.renameProject);
  const remove = useApp((s) => s.removeProject);
  const setAdminTerminals = useApp((s) => s.setAdminTerminals);
  const elevatable = useApp((s) => canElevate(project, s.system.os));
  const now = useNow();
  // Folded, the header shows the most urgent state among its sessions.
  const state = useApp((s) => strongest(sessions.map((x) => sessionState(x, !!s.running[x.id], s.seen[x.id]))));

  // A tab or window from this workspace dragged over the sidebar becomes a new group here:
  // at the hovered place among the groups, or (no place) at the end.
  const dropAt = useDrag((s) => {
    const t = s.drag?.projectId === project.id ? s.drag.target : null;
    return t?.kind === "newGroup" ? (t.index ?? -1) : null;
  });

  const reorder = useLiveReorder({
    ids: groups.map((g) => g.id),
    pick: (target) =>
      target.closest("button, input, [role=menu]") ? null : (target.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup ?? null),
    onDrop: moveGroupTo,
  });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows = [...reorder.order];
  if (dropAt !== null && project.expanded) rows.splice(dropAt < 0 ? rows.length : dropAt, 0, PLACEHOLDER);

  return (
    <div
      data-flip-key={project.id}
      className={cn("relative rounded-lg", dragging && "z-20 bg-(--backdrop) shadow-lg ring-1 ring-sidebar-border")}
    >
      <Collapsible open={project.expanded}>
        <div
          role="button"
          data-project-header
          onClick={() => void toggle(project.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
          title={project.path}
          className="group flex h-8 cursor-default items-center gap-1.5 rounded-lg px-2 text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent/60"
        >
          {/* The workspace's icon turns into the fold chevron on hover. */}
          <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <WorkspaceIcon projectId={project.id} className="group-hover:invisible" />
            <ChevronRight
              className={cn("invisible absolute size-3.5 transition-transform group-hover:visible", project.expanded && "rotate-90")}
            />
          </span>
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
            <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", !project.expanded && STATE_TEXT[state])}>
              {project.name}
            </span>
          )}
          {/* Expanded, each group shows its own activity; folded, the header carries it. */}
          {!project.expanded && state !== "idle" && <ActivityIndicator state={state} />}
          {project.env === "wsl" && (
            <span className="rounded border border-sidebar-border px-1 text-[10px] leading-4 font-medium text-muted-foreground">WSL</span>
          )}

          <HoverSwap idle={timeAgo(projectLastUsed(node), now)}>
            <button
              aria-label="New group"
              title={`New group (${shortcutLabel("newGroup")})`}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                void newGroup(project.id);
              }}
            >
              <Plus className="size-3.5" />
            </button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button
                  aria-label="Workspace options"
                  className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => void newGroup(project.id)}>
                  New group
                  <DropdownMenuShortcut>{shortcutLabel("newGroup")}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditing(true)}>Rename</DropdownMenuItem>
                {elevatable && (
                  <DropdownMenuCheckboxItem
                    checked={project.adminTerminals}
                    onCheckedChange={(v) => void setAdminTerminals(project.id, v === true)}
                  >
                    Terminals as admin
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void remove(project.id)}>
                  Remove workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </HoverSwap>
        </div>

        <CollapsibleContent>
          <div
            ref={reorder.listRef}
            onPointerDown={reorder.onPointerDown}
            data-group-list={project.id}
            className="relative flex flex-col gap-0.5 pt-0.5 pb-1 pl-[1.375rem]"
          >
            {rows.map((id) =>
              id === PLACEHOLDER ? (
                <NewGroupSlot key={id} />
              ) : byId.has(id) ? (
                <GroupItem key={id} group={byId.get(id)!} dragging={reorder.dragId === id} />
              ) : null,
            )}
            {groups.length === 0 && dropAt === null && (
              <button
                onClick={() => void newGroup(project.id)}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <Plus className="size-3.5" /> New group
              </button>
            )}
          </div>
        </CollapsibleContent>
        {/* Folded: the new group shows under the header. */}
        {dropAt !== null && !project.expanded && (
          <div className="pt-0.5 pb-1 pl-[1.375rem]">
            <NewGroupSlot />
          </div>
        )}
      </Collapsible>
    </div>
  );
}

/** Where a tab or window being dragged in will become a new group. */
function NewGroupSlot() {
  return (
    <div
      data-flip-key={PLACEHOLDER}
      data-group-placeholder
      className="flex h-11 items-center rounded-lg border border-dashed border-ring/70 bg-ring/10 px-2 text-[13px] text-foreground animate-in fade-in-0 zoom-in-95 duration-150"
    >
      New group
    </div>
  );
}

import { useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
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
import { canElevate, sidebarOrder, useGroups, type Group } from "@/stores/group-store";
import { useSort } from "@/stores/sort-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";
import { GroupItem } from "./group-item";

export function ProjectItem({ node, groups }: { node: ProjectTree; groups: Group[] }) {
  const { project } = node;
  const sessions = node.sessions ?? [];
  const [editing, setEditing] = useState(false);
  // The ⋯ menu; right-clicking the row opens it too.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useApp((s) => s.toggleProject);
  const newGroup = useGroups((s) => s.newGroup);
  const reorder = useGroupReorder(project.id, groups);
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
                Rename
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
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </HoverSwap>
      </div>

      <CollapsibleContent>
        <div
          ref={reorder.listRef}
          onPointerDown={reorder.onPointerDown}
          className="mx-3.5 flex flex-col gap-0.5 border-l border-sidebar-border py-0.5 pl-2"
        >
          {groups.map((g) => (
            <GroupItem
              key={g.id}
              group={g}
              dragging={reorder.dragId === g.id}
              dropEdge={reorder.drop?.id === g.id ? reorder.drop.edge : undefined}
            />
          ))}
          {groups.length === 0 && !dropHere && (
            <button
              onClick={() => void newGroup(project.id)}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              New group
            </button>
          )}
        </div>
      </CollapsibleContent>
      {dropHere && (
        <div className="mt-0.5 mx-3.5 border-l border-sidebar-border py-0.5 pl-2">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-dashed border-ring/70 bg-ring/10 px-1.5 text-xs text-foreground animate-in fade-in-0 slide-in-from-top-1 duration-150">
            New group
          </div>
        </div>
      )}
    </Collapsible>
  );
}

type DropSpot = { id: string; edge: "before" | "after" };

/**
 * Drag a group row up or down within its workspace. Dropping saves the new order and
 * switches the sidebar to manual sorting. A press without movement stays a click.
 */
function useGroupReorder(projectId: string, groups: Group[]) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropSpot | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, [role=menu]")) return;
    const row = target.closest<HTMLElement>("[data-drop-group]");
    const id = row?.dataset.dropGroup;
    if (!id || groups.length < 2) return;

    const startY = e.clientY;
    let active = false;
    let spot: DropSpot | null = null;

    const spotAt = (x: number, y: number): DropSpot | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-group]");
      if (!el || !listRef.current?.contains(el) || el.dataset.dropGroup === id) return null;
      const r = el.getBoundingClientRect();
      return { id: el.dataset.dropGroup!, edge: y < r.top + r.height / 2 ? "before" : "after" };
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        setDragId(id);
        document.body.style.cursor = "grabbing";
      }
      // Keep the pointer's x inside the list so dragging off to the side still targets a row.
      const rect = listRef.current!.getBoundingClientRect();
      spot = spotAt(Math.min(Math.max(ev.clientX, rect.left + 4), rect.right - 4), ev.clientY);
      setDrop(spot);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = "";
      setDragId(null);
      setDrop(null);
    };
    const swallowClick = (ev: Event) => ev.stopPropagation();
    const onUp = () => {
      finish();
      if (!active) return;
      // The drag ends in a click on the row; it shouldn't open the group.
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      if (spot) save(id, spot);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", finish);
  };

  const save = (id: string, spot: DropSpot) => {
    const ids = groups.map((g) => g.id).filter((x) => x !== id);
    const at = ids.indexOf(spot.id) + (spot.edge === "after" ? 1 : 0);
    ids.splice(at, 0, id);
    // Freeze everything else where it is on screen now, then apply this workspace's new order.
    const shown = sidebarOrder(useApp.getState().tree, useGroups.getState().groups);
    const groupsOrder = Object.fromEntries(shown.map((x) => [x.node.project.id, x.groups.map((g) => g.id)]));
    groupsOrder[projectId] = ids;
    useSort.getState().setManual({ projects: shown.map((x) => x.node.project.id), groups: groupsOrder });
  };

  return { listRef, onPointerDown, dragId, drop };
}

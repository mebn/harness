import { useState } from "react";
import { GitBranch, MoreHorizontal } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGroupTitle } from "@/components/workspace/tab-meta";
import { panesOf, tabsOf } from "@/lib/layout-tree";
import { sessionState, strongest } from "@/lib/session-state";
import { shortcutLabel } from "@/lib/shortcuts";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { findSession, useApp } from "@/stores/app-store";
import { useDrag } from "@/stores/drag-store";
import { groupActivity, sidebarOrder, useGroups, type Group } from "@/stores/group-store";
import { useLayout } from "@/stores/layout-store";
import { ActivityIndicator, STATE_TEXT } from "./activity-indicator";
import { HoverSwap } from "./hover-swap";

/** A group in the sidebar: name, activity and last use on top, window and tab counts below. */
type Props = {
  group: Group;
  /** Being dragged to a new position. */
  dragging?: boolean;
  /** A dragged group will land on this side of the row. */
  dropEdge?: "before" | "after";
};

export function GroupItem({ group, dragging, dropEdge }: Props) {
  const [editingByMenu, setEditing] = useState(false);
  // The ⋯ menu; right-clicking the row opens it too.
  const [menuOpen, setMenuOpen] = useState(false);
  const renamingGroup = useLayout((s) => s.renamingGroup);
  const setRenamingGroup = useLayout((s) => s.setRenamingGroup);
  const editing = editingByMenu || renamingGroup === group.id;
  const stopEditing = () => {
    setEditing(false);
    if (renamingGroup === group.id) setRenamingGroup(null);
  };

  const active = useGroups((s) => s.activeId === group.id);
  const reveal = useGroups((s) => s.reveal);
  const closeGroup = useGroups((s) => s.closeGroup);
  const renameGroup = useGroups((s) => s.renameGroup);
  const renameSession = useApp((s) => s.renameSession);
  const title = useGroupTitle(group);
  const tabs = tabsOf(group.root);
  const windowCount = panesOf(group.root).length;
  // Second line: "1 window", or "2 windows · 5 tabs" when windows hold several tabs.
  const summary =
    `${windowCount} ${windowCount === 1 ? "window" : "windows"}` +
    (tabs.length > windowCount ? ` · ${tabs.length} tabs` : "");
  const chats = tabs.filter((t) => t.kind === "chat" && t.sessionId);
  // The group shows the most urgent state among its chats.
  const state = useApp((s) =>
    strongest(
      chats.map((t) => {
        const session = findSession(s.tree, t.sessionId!);
        return session ? sessionState(session, !!s.running[session.id], s.seen[session.id]) : "idle";
      }),
    ),
  );
  const lastActive = useApp((s) => groupActivity(group, s.tree));
  const now = useNow();

  // ⌘/Ctrl held: show this group's number for ⌘/Ctrl+1–9.
  const modHeld = useLayout((s) => s.modHeld);
  const number = useGroups((s) => {
    if (!modHeld) return 0;
    const list = sidebarOrder(useApp.getState().tree, s.groups).flatMap((x) => x.groups);
    const i = list.findIndex((g) => g.id === group.id);
    return i >= 0 && i < 9 ? i + 1 : 0;
  });

  // A dragged tab or window hovering this row will move here.
  const dropTarget = useDrag((s) => s.drag?.target?.kind === "group" && s.drag.target.groupId === group.id);

  const rename = (value: string) => {
    // A group named after its chat renames the chat, so search and history agree.
    const chat = chats[0];
    if (!group.title && chat?.sessionId) void renameSession(chat.sessionId, value);
    else renameGroup(group.id, value);
  };

  return (
    <div data-drop-group={group.id} data-project={group.projectId} className={cn("relative", dragging && "opacity-40")}>
      {dropEdge && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-ring",
            dropEdge === "before" ? "-top-[2px]" : "-bottom-[2px]",
          )}
        />
      )}
      <div
        role="button"
        onClick={() => reveal(group.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        onDoubleClick={() => setEditing(true)}
        className={cn(
          "group flex cursor-default rounded-lg px-2 py-1.5 text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
          dropTarget && "bg-ring/15 text-foreground ring-1 ring-ring/60",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-1.5">
            {editing ? (
              <InlineEdit
                value={title}
                onSubmit={(v) => {
                  stopEditing();
                  rename(v);
                }}
                onCancel={stopEditing}
              />
            ) : (
              <span className={cn("flex-1 truncate", STATE_TEXT[state])}>{title}</span>
            )}
            {/* Activity sits on the right so titles stay flush with the workspace header. */}
            <ActivityIndicator state={state} />
            {number > 0 ? (
              <kbd className="rounded border bg-background/70 px-1 font-sans text-[10px] text-muted-foreground">{number}</kbd>
            ) : (
              <HoverSwap idle={timeAgo(lastActive, now)}>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <button aria-label="Group options" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      Rename
                      <DropdownMenuShortcut>{shortcutLabel("renameGroup")}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => closeGroup(group.id)}>
                      Close group
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </HoverSwap>
            )}
          </div>
          <div className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground/80">
            <span className="shrink-0">{summary}</span>
            {group.worktree && (
              <>
                <span aria-hidden>·</span>
                <span title={`Worktree: ${group.worktree}`} className="flex min-w-0 items-center gap-0.5">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{group.worktree}</span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

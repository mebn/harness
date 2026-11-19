import { useState } from "react";
import { MoreHorizontal, Pencil, X } from "lucide-react";
import { InlineEdit } from "@/components/common/inline-edit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabIcon, useGroupTitle } from "@/components/workspace/tab-meta";
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

/** A group in the sidebar: its name, activity, and how many tabs it holds. */
export function GroupItem({ group }: { group: Group }) {
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
    <div data-drop-group={group.id} data-project={group.projectId}>
      <div
        role="button"
        onClick={() => reveal(group.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        onDoubleClick={() => setEditing(true)}
        className={cn(
          "group flex h-7 cursor-default items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
          dropTarget && "bg-ring/15 text-foreground ring-1 ring-ring/60",
        )}
      >
        {/* Fixed-width slot keeps titles aligned: activity, else the single tab's kind. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {state !== "idle" ? (
            <ActivityIndicator state={state} />
          ) : (
            tabs.length === 1 && <TabIcon kind={tabs[0].kind} className="size-3.5 opacity-70" />
          )}
        </span>
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
        {tabs.length > 1 && number === 0 && (
          <span
            title={`${windowCount} ${windowCount === 1 ? "window" : "windows"} · ${tabs.length} tabs`}
            className="min-w-4 shrink-0 rounded bg-foreground/[0.07] px-1 text-center text-[10px] font-medium tabular-nums text-muted-foreground"
          >
            {tabs.length}
          </span>
        )}
        {number > 0 ? (
          <kbd className="rounded border bg-background/70 px-1 font-sans text-[10px] text-muted-foreground">{number}</kbd>
        ) : (
          <HoverSwap idle={timeAgo(lastActive, now)}>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button aria-label="Group options" className="rounded p-0.5 hover:text-foreground">
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Rename
                  <DropdownMenuShortcut>{shortcutLabel("renameGroup")}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => closeGroup(group.id)}>
                  <X /> Close group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </HoverSwap>
        )}
      </div>
    </div>
  );
}

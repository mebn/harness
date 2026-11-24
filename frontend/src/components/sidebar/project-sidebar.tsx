import { useState } from "react";
import { ArrowDownUp, Check, FolderPlus, Search, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dragStyle, MAC_TITLE_BAR_HEIGHT, onTitleBarDoubleClick, useMacTitleBar } from "@/components/layout/window-controls";
import { useShortcutLabel } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { moveProjectTo, useGroups, useSidebarOrder } from "@/stores/group-store";
import { SORT_LABELS, useSort, type SortMode } from "@/stores/sort-store";
import { ProjectItem } from "./project-item";
import { useLiveReorder } from "./use-live-reorder";

const RECENT_LIMIT = 5;

/** Adds a workspace from the folder picker and opens a group in it. */
export function useAddWorkspace() {
  const addProject = useApp((s) => s.addProject);
  const newGroup = useGroups((s) => s.newGroup);
  return async () => {
    const id = await addProject();
    if (id) await newGroup(id);
  };
}

export function ProjectSidebar() {
  const addWorkspace = useAddWorkspace();
  const isMac = useMacTitleBar();
  const setSearchOpen = useLayout((s) => s.setSearchOpen);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const [showAll, setShowAll] = useState(false);
  const sorted = useSidebarOrder();
  const visible = showAll ? sorted : sorted.slice(0, RECENT_LIMIT);
  const byId = new Map(visible.map((x) => [x.node.project.id, x]));

  // Drag a workspace by its header row; the list reorders live.
  const reorder = useLiveReorder({
    ids: visible.map((x) => x.node.project.id),
    pick: (target) => {
      // Only the header row; group rows inside reorder their own list.
      if (target.closest("button, input, [role=menu]") || !target.closest("[data-project-header]")) return null;
      return target.closest<HTMLElement>("[data-flip-key]")?.dataset.flipKey ?? null;
    },
    onDrop: moveProjectTo,
  });

  const newGroupHere = () => {
    const { groups, activeId, newGroup } = useGroups.getState();
    const projectId = groups.find((g) => g.id === activeId)?.projectId ?? sorted[0]?.node.project.id;
    if (projectId) void newGroup(projectId);
    else void addWorkspace();
  };

  return (
    // Dropping a dragged tab or window anywhere here makes it a new group.
    <aside data-drop-sidebar className="group/sidebar flex h-full flex-col text-sidebar-foreground">
      {/* On macOS the traffic lights sit here; the strip doubles as the window's drag region. */}
      {isMac && <div className="h-11 shrink-0" style={{ ...dragStyle, height: MAC_TITLE_BAR_HEIGHT, paddingLeft: 80 }} onDoubleClick={onTitleBarDoubleClick} />}

      <nav className="flex shrink-0 flex-col gap-px px-2 pt-2">
        <NavRow icon={SquarePen} label="New group" shortcut="newGroup" onClick={newGroupHere} />
        <NavRow icon={Search} label="Search" shortcut="search" onClick={() => setSearchOpen(true)} />
      </nav>

      <div className="mt-4 flex h-7 shrink-0 items-center gap-0.5 pr-2 pl-4">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground/80">Workspaces</span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/sidebar:opacity-100 has-[[data-state=open]]:opacity-100">
          <SortMenu />
          <IconButton label="Add workspace" onClick={() => void addWorkspace()} className="size-6 [&_svg]:size-3.5">
            <FolderPlus />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={reorder.listRef} onPointerDown={reorder.onPointerDown} className="relative flex flex-col gap-1 px-2 pt-0.5 pb-3">
          {reorder.order.map((id) => {
            const item = byId.get(id);
            if (!item) return null;
            return <ProjectItem key={id} node={item.node} groups={item.groups} dragging={reorder.dragId === id} />;
          })}
          {sorted.length > RECENT_LIMIT && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="flex h-7 items-center rounded-md pl-[1.875rem] text-xs text-muted-foreground hover:text-sidebar-foreground"
            >
              {showAll ? "Show fewer" : `Show all ${sorted.length}`}
            </button>
          )}
          {sorted.length === 0 && (
            <button
              onClick={() => void addWorkspace()}
              className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-sidebar-border text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <FolderPlus className="size-4" />
              Add a workspace
            </button>
          )}
        </div>
      </div>

      <footer className="flex h-11 shrink-0 items-center gap-1 border-t border-sidebar-border px-2">
        <ServerBadge />
        <IconButton label={`Settings (${useShortcutLabel("settings")})`} onClick={() => setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </footer>
    </aside>
  );
}

/** An app-wide action at the top of the sidebar, with its shortcut on hover. */
function NavRow({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  shortcut: Parameters<typeof useShortcutLabel>[0];
  onClick: () => void;
}) {
  const keys = useShortcutLabel(shortcut);
  return (
    <button
      onClick={onClick}
      className="group/nav flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Icon className="size-4 text-muted-foreground group-hover/nav:text-sidebar-accent-foreground" />
      <span className="flex-1 text-left">{label}</span>
      {keys && <span className="text-[11px] text-muted-foreground/70 opacity-0 transition-opacity group-hover/nav:opacity-100">{keys}</span>}
    </button>
  );
}

const SORT_HINTS: Record<SortMode, string> = {
  recent: "Latest activity first",
  status: "Finished first, then waiting, failed, working",
  name: "Alphabetical",
  manual: "The order you drag them into",
};

/** Picks how workspaces and groups are ordered; dragging one switches to manual. */
function SortMenu() {
  const mode = useSort((s) => s.mode);
  const setMode = useSort((s) => s.setMode);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label="Sort"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent"
          >
            <ArrowDownUp className="size-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sort: {SORT_LABELS[mode]}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
        {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
          <DropdownMenuItem key={m} onSelect={() => setMode(m)} className="items-start">
            <Check className={cn("mt-0.5", m !== mode && "invisible")} />
            <span className="flex flex-col">
              <span>{SORT_LABELS[m]}</span>
              <span className="text-[11px] text-muted-foreground">{SORT_HINTS[m]}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which machine's server this window talks to. The server always runs locally for now. */
function ServerBadge() {
  const system = useApp((s) => s.system);
  const label = system.os === "darwin" ? "This Mac" : "This PC";
  return (
    <div
      title={system.hostname ? `Connected to ${system.hostname}` : "Connected"}
      className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground"
    >
      <span className="relative flex size-1.5 shrink-0">
        <span className="absolute inset-0 rounded-full bg-emerald-500/40 blur-[2px]" />
        <span className="relative size-1.5 rounded-full bg-emerald-500" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

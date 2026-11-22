import { useState } from "react";
import { Plus, Settings } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dragStyle, onTitleBarDoubleClick, useMacTitleBar } from "@/components/layout/window-controls";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useGroups, useSidebarOrder } from "@/stores/group-store";
import { SORT_LABELS, useSort, type SortMode } from "@/stores/sort-store";
import { ProjectItem } from "./project-item";

const RECENT_LIMIT = 5;

export function ProjectSidebar() {
  const addProject = useApp((s) => s.addProject);
  const newGroup = useGroups((s) => s.newGroup);
  const openFolder = async () => {
    const id = await addProject();
    if (id) await newGroup(id);
  };
  const isMac = useMacTitleBar();
  const setSearchOpen = useLayout((s) => s.setSearchOpen);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const [showAll, setShowAll] = useState(false);
  const sorted = useSidebarOrder();
  const visible = showAll ? sorted : sorted.slice(0, RECENT_LIMIT);

  return (
    // Dropping a dragged tab or window anywhere here makes it a new group.
    <aside data-drop-sidebar className="flex h-full flex-col text-sidebar-foreground">
      {/* On macOS the traffic lights sit here; the strip doubles as the window's drag region. */}
      {isMac && <div className="h-11 shrink-0" style={{ ...dragStyle, paddingLeft: 80 }} onDoubleClick={onTitleBarDoubleClick} />}

      <nav className="flex flex-col gap-0.5 px-2 pt-2">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-muted-foreground/70">{shortcutLabel("search")}</kbd>
        </button>
      </nav>

      <div className="h-2" />

      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-xs font-medium text-muted-foreground">Workspaces</span>
        <div className="flex items-center gap-0.5">
          <SortMenu />
          <IconButton label="Open folder" onClick={() => void openFolder()} className="size-6">
            <Plus />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {visible.map(({ node, groups }) => (
            <ProjectItem key={node.project.id} node={node} groups={groups} />
          ))}
          {sorted.length > RECENT_LIMIT && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {showAll ? "Show less" : `View all (${sorted.length})`}
            </button>
          )}
        </div>
      </div>

      <footer className="flex h-11 shrink-0 items-center gap-1 px-2">
        <ServerBadge />
        <IconButton label={`Settings (${shortcutLabel("settings")})`} onClick={() => setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </footer>
    </aside>
  );
}

const SORT_HINTS: Record<SortMode, string> = {
  recent: "Latest activity first",
  status: "Finished first, then waiting, failed, working",
  name: "Alphabetical",
  manual: "Drag groups to reorder",
};

/** Picks how workspaces and groups are ordered; dragging a group switches to manual. */
function SortMenu() {
  const mode = useSort((s) => s.mode);
  const setMode = useSort((s) => s.setMode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Sort workspaces and groups"
        className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent"
      >
        {SORT_LABELS[mode]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as SortMode)}>
          {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="flex-col items-start gap-0">
              <span>{SORT_LABELS[m]}</span>
              <span className="text-[11px] text-muted-foreground">{SORT_HINTS[m]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
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
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{label}</span>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Laptop, Plus, Search, Settings } from "lucide-react";
import { projectLastUsed as lastUsed } from "@/lib/session-state";
import { IconButton } from "@/components/common/icon-button";
import { dragStyle, onTitleBarDoubleClick, useMacTitleBar } from "@/components/layout/window-controls";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useGroups } from "@/stores/group-store";
import { ProjectItem } from "./project-item";

const RECENT_LIMIT = 5;

export function ProjectSidebar() {
  const tree = useApp((s) => s.tree);
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
  const sorted = useMemo(() => [...tree].sort((a, b) => lastUsed(b) - lastUsed(a)), [tree]);
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
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-muted-foreground/70">{shortcutLabel("search")}</kbd>
        </button>
      </nav>

      <div className="h-2" />

      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-xs font-medium text-muted-foreground">Workspaces</span>
        <IconButton label="Open folder" onClick={() => void openFolder()} className="size-6">
          <Plus />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {visible.map((node) => (
            <ProjectItem key={node.project.id} node={node} />
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

/** Which machine's server this window talks to. The server always runs locally for now. */
function ServerBadge() {
  const system = useApp((s) => s.system);
  const label = system.os === "darwin" ? "This Mac" : "This PC";
  return (
    <div
      title={system.hostname ? `Connected to ${system.hostname}` : "Connected"}
      className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground"
    >
      <span className="relative flex shrink-0">
        <Laptop className="size-4" />
        <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-emerald-500" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Plus, Search, Settings } from "lucide-react";
import { projectLastUsed as lastUsed } from "@/lib/session-state";
import { IconButton } from "@/components/common/icon-button";
import { dragStyle, useMacTitleBar } from "@/components/layout/window-controls";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { ProjectItem } from "./project-item";

const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
const RECENT_LIMIT = 5;

export function ProjectSidebar() {
  const tree = useApp((s) => s.tree);
  const addProject = useApp((s) => s.addProject);
  const isMac = useMacTitleBar();
  const setSearchOpen = useLayout((s) => s.setSearchOpen);
  const setSettingsOpen = useLayout((s) => s.setSettingsOpen);
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => [...tree].sort((a, b) => lastUsed(b) - lastUsed(a)), [tree]);
  const visible = showAll ? sorted : sorted.slice(0, RECENT_LIMIT);

  return (
    <aside className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Empty strip that doubles as the window's drag region. */}
      <div className="h-11 shrink-0" style={{ ...dragStyle, paddingLeft: isMac ? 80 : undefined }} />

      <nav className="flex flex-col gap-0.5 px-2">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-muted-foreground/70">{isMacPlatform ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      </nav>

      <div className="mx-3 my-2 border-t border-sidebar-border" />

      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-xs font-medium text-muted-foreground">Workspaces</span>
        <IconButton label="Open folder" onClick={() => void addProject()} className="size-6">
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

      <footer className="flex h-11 shrink-0 items-center px-2">
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </footer>
    </aside>
  );
}

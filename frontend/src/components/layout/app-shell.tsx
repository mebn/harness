import { useEffect, useState } from "react";
import { FolderPlus, PanelLeft, Plus } from "lucide-react";
import { IconButton } from "@/components/common/icon-button";
import { ProjectSidebar } from "@/components/sidebar/project-sidebar";
import { Button } from "@/components/ui/button";
import { GroupView } from "@/components/workspace/group-view";
import { TabLayer } from "@/components/workspace/tab-layer";
import { WorktreePicker } from "@/components/workspace/worktree-picker";
import { useGroupTitle } from "@/components/workspace/tab-meta";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { shortcutLabel } from "@/lib/shortcuts";
import { useActiveGroup, useActiveProject, useGroups } from "@/stores/group-store";
import {
  WINDOW_CONTROLS_WIDTH,
  dragStyle,
  noDragStyle,
  onTitleBarDoubleClick,
  useCustomTitleBar,
  useMacTitleBar,
} from "./window-controls";

const WIDTH_KEY = "harness.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
/** Dragging the sidebar narrower than this closes it. */
const CLOSE_WIDTH = 120;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

/**
 * The sidebar's width: saved after a drag, and animated when it opens or closes. Windows are
 * laid out in percentages of their area, so they follow the slide without lagging.
 */
function useSidebar() {
  const open = useLayout((s) => s.sidebarOpen);
  const setOpen = useLayout((s) => s.setSidebarOpen);
  const [width, setWidth] = useState(() => clampWidth(Number(storage.get(WIDTH_KEY)) || 260));
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = open ? width : 0;
    let latest = width;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const w = startWidth + ev.clientX - startX;
      if (w < CLOSE_WIDTH) {
        if (useLayout.getState().sidebarOpen) setOpen(false);
        return;
      }
      if (!useLayout.getState().sidebarOpen) setOpen(true);
      latest = clampWidth(w);
      setWidth(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      storage.set(WIDTH_KEY, String(latest));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return { open, width, dragging, onPointerDown };
}

/** Workspaces and groups on the left; the active group's windows floating on the backdrop. */
export function AppShell() {
  const sidebar = useSidebar();

  // Keep group layouts in step with the backend's projects and sessions.
  const tree = useApp((s) => s.tree);
  useEffect(() => useGroups.getState().sync(tree), [tree]);

  return (
    <div className="app-backdrop flex h-full">
      {/* The sidebar keeps its width while it slides shut, so its contents don't reflow. */}
      <div
        className={cn("relative h-full shrink-0 overflow-hidden", !sidebar.dragging && "sidebar-anim")}
        style={{ width: sidebar.open ? sidebar.width : 0 }}
        inert={!sidebar.open}
      >
        <div className="h-full" style={{ width: sidebar.width }}>
          <ProjectSidebar />
        </div>
      </div>
      <div
        onPointerDown={sidebar.onPointerDown}
        className="relative z-10 -mx-1 h-full w-2 shrink-0 cursor-col-resize"
        style={noDragStyle}
      />
      <div className="flex h-full min-w-[320px] flex-1 flex-col">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-hidden border-t border-l border-(--pane-border)">
          <GroupStack />
        </div>
      </div>
    </div>
  );
}

/**
 * Every group opened this run stays mounted (hidden when inactive) so its terminals and
 * pages keep running; groups are first mounted when shown.
 */
function GroupStack() {
  const groups = useGroups((s) => s.groups);
  const activeId = useGroups((s) => s.activeId);
  const [visited, setVisited] = useState<string[]>([]);

  useEffect(() => {
    setVisited((v) => {
      const alive = v.filter((id) => groups.some((g) => g.id === id));
      const next = activeId && !alive.includes(activeId) ? [...alive, activeId] : alive;
      return next.length === v.length && next.every((id, i) => id === v[i]) ? v : next;
    });
  }, [groups, activeId]);

  const active = groups.find((g) => g.id === activeId);
  // The active group counts as mounted right away, so a tab moved into it is never dropped.
  const mounted = activeId && !visited.includes(activeId) ? [...visited, activeId] : visited;
  const mountedGroups = mounted.map((id) => groups.find((g) => g.id === id)).filter((g) => !!g);

  return (
    <div className="relative h-full overflow-hidden">
      {mounted.map((id) => {
        const group = groups.find((g) => g.id === id);
        if (!group) return null;
        return (
          <div key={id} className={cn("absolute inset-0", id !== activeId && "pointer-events-none invisible")}>
            <GroupView group={group} active={id === activeId} />
          </div>
        );
      })}
      {/* Tab contents for every mounted group, above the window cards. */}
      <TabLayer groups={mountedGroups} activeId={activeId} />
      {!active && <EmptyState />}
    </div>
  );
}

function EmptyState() {
  const tree = useApp((s) => s.tree);
  const addProject = useApp((s) => s.addProject);
  const newGroup = useGroups((s) => s.newGroup);
  const latest = tree[tree.length - 1]?.project;

  return (
    <div className="pane-card flex h-full items-center justify-center gap-2">
      <Button
        variant="outline"
        onClick={async () => {
          const id = await addProject();
          if (id) await newGroup(id);
        }}
      >
        <FolderPlus /> Open folder
      </Button>
      {latest && (
        <Button variant="ghost" onClick={() => void newGroup(latest.id)}>
          <Plus /> New group in {latest.name}
        </Button>
      )}
    </div>
  );
}

function TopBar() {
  const group = useActiveGroup();
  const title = useGroupTitle(group);
  const project = useActiveProject();
  const toggleSidebar = useLayout((s) => s.toggleSidebar);
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const isMac = useMacTitleBar();
  const customControls = useCustomTitleBar();
  return (
    // Part of the window's title bar: draggable, and padded around OS/window controls.
    <header
      onDoubleClick={onTitleBarDoubleClick}
      className="flex h-11 shrink-0 items-center gap-2 px-1"
      style={{
        ...dragStyle,
        paddingLeft: isMac && !sidebarOpen ? 80 : undefined,
        paddingRight: customControls ? WINDOW_CONTROLS_WIDTH : undefined,
      }}
    >
      <IconButton label={`Toggle sidebar (${shortcutLabel("toggleSidebar")})`} onClick={toggleSidebar} style={noDragStyle}>
        <PanelLeft />
      </IconButton>
      <span className="min-w-0 truncate text-[13px]">
        <span className="font-medium">{title}</span>
        {project && <span className="text-muted-foreground"> · {project.name}</span>}
      </span>
      {group && <WorktreePicker group={group} />}
    </header>
  );
}

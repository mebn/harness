import { useEffect, useState } from "react";
import { FolderPlus, PanelLeft, Plus } from "lucide-react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { IconButton } from "@/components/common/icon-button";
import { ProjectSidebar } from "@/components/sidebar/project-sidebar";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { GroupView } from "@/components/workspace/group-view";
import { TabLayer } from "@/components/workspace/tab-layer";
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
  useCustomTitleBar,
  useMacTitleBar,
} from "./window-controls";

// Pane sizes are saved after user drags; open/closed state is persisted by the stores.
const layoutStorage = { getItem: storage.get, setItem: storage.set };

/** Keeps a collapsible panel in sync with an open/closed flag (both directions). */
function useCollapsible(open: boolean, setOpen: (open: boolean) => void) {
  const ref = usePanelRef();
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (open && p.isCollapsed()) p.expand();
    if (!open && !p.isCollapsed()) p.collapse();
  }, [open, ref]);
  const onResize = () => {
    const collapsed = ref.current?.isCollapsed() ?? false;
    if (collapsed === open) setOpen(!collapsed);
  };
  return { panelRef: ref, onResize };
}

/** Workspaces and groups on the left; the active group's windows floating on the backdrop. */
export function AppShell() {
  const sidebar = useCollapsible(
    useLayout((s) => s.sidebarOpen),
    useLayout((s) => s.setSidebarOpen),
  );
  const layout = useDefaultLayout({
    id: "harness.shell",
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  // Keep group layouts in step with the backend's projects and sessions.
  const tree = useApp((s) => s.tree);
  useEffect(() => useGroups.getState().sync(tree), [tree]);

  return (
    <div className="app-backdrop h-full">
      <ResizablePanelGroup orientation="horizontal" className="h-full" {...layout}>
        <ResizablePanel id="sidebar" defaultSize={260} minSize={200} collapsible collapsedSize={0} {...sidebar}>
          <ProjectSidebar />
        </ResizablePanel>
        <ResizableHandle className="bg-transparent" />
        <ResizablePanel id="main" minSize={320}>
          <div className="flex h-full flex-col">
            <TopBar />
            <div className="min-h-0 flex-1 overflow-hidden pr-2 pb-2 pl-1">
              <GroupStack />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
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
    </header>
  );
}

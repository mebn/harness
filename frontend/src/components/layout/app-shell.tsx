import { useEffect } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { ChatView } from "@/components/chat/chat-view";
import { IconButton } from "@/components/common/icon-button";
import { RightPanel } from "@/components/panel/right-panel";
import { ProjectSidebar } from "@/components/sidebar/project-sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { storage } from "@/lib/storage";
import { useActiveSession } from "@/stores/app-store";
import { useLayout } from "@/stores/layout-store";
import { usePanel } from "@/stores/panel-store";
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

/** Three-pane layout: projects | chat | tools. */
export function AppShell() {
  const sidebar = useCollapsible(
    useLayout((s) => s.sidebarOpen),
    useLayout((s) => s.setSidebarOpen),
  );
  const tools = useCollapsible(
    usePanel((s) => s.open),
    usePanel((s) => s.setOpen),
  );
  const layout = useDefaultLayout({
    id: "harness.layout",
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full" {...layout}>
      <ResizablePanel id="sidebar" defaultSize={260} minSize={200} collapsible collapsedSize={0} {...sidebar}>
        <ProjectSidebar />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="main" minSize={280}>
        <div className="flex h-full flex-col">
          <TopBar />
          <div className="min-h-0 flex-1">
            <ChatView />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="tools" defaultSize={440} minSize={280} collapsible collapsedSize={0} {...tools}>
        <RightPanel />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function TopBar() {
  const session = useActiveSession();
  const toggleSidebar = useLayout((s) => s.toggleSidebar);
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const togglePanel = usePanel((s) => s.toggle);
  const panelOpen = usePanel((s) => s.open);
  const isMac = useMacTitleBar();
  const customControls = useCustomTitleBar();
  return (
    // Part of the window's title bar: draggable, and padded around OS/window controls.
    <header
      className="flex h-11 shrink-0 items-center gap-2 px-2"
      style={{
        ...dragStyle,
        paddingLeft: isMac && !sidebarOpen ? 80 : undefined,
        paddingRight: customControls && !panelOpen ? WINDOW_CONTROLS_WIDTH : undefined,
      }}
    >
      <IconButton label="Toggle sidebar" onClick={toggleSidebar} style={noDragStyle}>
        <PanelLeft />
      </IconButton>
      <span className="flex-1 truncate text-center text-xs text-muted-foreground">{session?.title}</span>
      <IconButton label="Toggle panel" onClick={togglePanel} style={noDragStyle}>
        <PanelRight />
      </IconButton>
    </header>
  );
}

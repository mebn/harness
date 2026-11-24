import { useRef, useState } from "react";
import { Command, Plus, Settings } from "lucide-react";
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
import { sidebarOrder, useGroups, useSidebarOrder } from "@/stores/group-store";
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
  const reorder = useProjectReorder(visible.length);

  return (
    // Dropping a dragged tab or window anywhere here makes it a new group.
    <aside data-drop-sidebar className="flex h-full flex-col text-sidebar-foreground">
      {/* On macOS the traffic lights sit here; the strip doubles as the window's drag region. */}
      {isMac && <div className="h-11 shrink-0" style={{ ...dragStyle, paddingLeft: 80 }} onDoubleClick={onTitleBarDoubleClick} />}

      <div className="h-2 shrink-0" />

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
        <div ref={reorder.listRef} onPointerDown={reorder.onPointerDown} className="flex flex-col gap-2 px-2 pb-3">
          {visible.map(({ node, groups }) => (
            <ProjectItem
              key={node.project.id}
              node={node}
              groups={groups}
              dragging={reorder.dragId === node.project.id}
              dropEdge={reorder.drop?.id === node.project.id ? reorder.drop.edge : undefined}
            />
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
        <IconButton label={`Actions and chats (${shortcutLabel("search")})`} onClick={() => setSearchOpen(true)}>
          <Command />
        </IconButton>
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
  manual: "Drag workspaces and groups to reorder",
};

type DropSpot = { id: string; edge: "before" | "after" };

/**
 * Drag a workspace by its header row, up or down the sidebar. Dropping saves the new order and
 * switches to manual sorting. A press without movement stays a click (it folds the workspace).
 */
function useProjectReorder(count: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropSpot | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || count < 2) return;
    const target = e.target as HTMLElement;
    // Only the header row; group rows inside reorder their own list.
    if (target.closest("button, input, [role=menu]") || !target.closest("[data-project-header]")) return;
    const id = target.closest<HTMLElement>("[data-drop-project]")?.dataset.dropProject;
    if (!id) return;

    const startY = e.clientY;
    let active = false;
    let spot: DropSpot | null = null;

    const spotAt = (x: number, y: number): DropSpot | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-project]");
      if (!el || !listRef.current?.contains(el) || el.dataset.dropProject === id) return null;
      const r = el.getBoundingClientRect();
      return { id: el.dataset.dropProject!, edge: y < r.top + r.height / 2 ? "before" : "after" };
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        setDragId(id);
        document.body.style.cursor = "grabbing";
      }
      // Keep x inside the list so dragging off to the side still targets a workspace.
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
      // The drag ends in a click on the header; it shouldn't fold the workspace.
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      if (spot) save(id, spot);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", finish);
  };

  const save = (id: string, spot: DropSpot) => {
    // Freeze everything where it is on screen now (hidden workspaces included), then move this one.
    const shown = sidebarOrder(useApp.getState().tree, useGroups.getState().groups);
    const ids = shown.map((x) => x.node.project.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(spot.id) + (spot.edge === "after" ? 1 : 0), 0, id);
    const groups = Object.fromEntries(shown.map((x) => [x.node.project.id, x.groups.map((g) => g.id)]));
    useSort.getState().setManual({ projects: ids, groups });
  };

  return { listRef, onPointerDown, dragId, drop };
}

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

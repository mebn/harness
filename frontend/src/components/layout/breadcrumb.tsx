import { Check, ChevronDown, FolderPlus, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActivityIndicator } from "@/components/sidebar/activity-indicator";
import { useAddWorkspace } from "@/components/sidebar/project-sidebar";
import { WorkspaceIcon } from "@/components/sidebar/workspace-icon";
import { useGroupTitle } from "@/components/workspace/tab-meta";
import { useShortcutLabel } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app-store";
import { groupState, useActiveGroup, useActiveProject, useGroups, useSidebarOrder, type Group } from "@/stores/group-store";
import { noDragStyle } from "./window-controls";

const TRIGGER =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none transition-colors hover:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.08]";

/** "Workspace / Group" in the title bar; each part opens a menu to switch or add one. */
export function Breadcrumb() {
  const group = useActiveGroup();
  const project = useActiveProject();
  if (!group || !project) return null;
  return (
    <nav className="flex min-w-0 items-center" style={noDragStyle} onDoubleClick={(e) => e.stopPropagation()}>
      <WorkspaceMenu current={project.id} name={project.name} />
      <span className="px-0.5 text-[13px] text-muted-foreground/50">/</span>
      <GroupMenu group={group} />
    </nav>
  );
}

function WorkspaceMenu({ current, name }: { current: string; name: string }) {
  const order = useSidebarOrder();
  const addWorkspace = useAddWorkspace();
  const open = (projectId: string, groups: Group[]) => {
    const { reveal, newGroup } = useGroups.getState();
    // Its first group as the sidebar lists them, or a new one if it has none.
    if (groups[0]) reveal(groups[0].id);
    else void newGroup(projectId);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(TRIGGER, "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground")}>
        <WorkspaceIcon projectId={current} className="shrink-0" />
        <span className="truncate">{name}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspaces</DropdownMenuLabel>
        {order.map(({ node, groups }) => (
          <DropdownMenuItem key={node.project.id} onSelect={() => open(node.project.id, groups)}>
            <WorkspaceIcon projectId={node.project.id} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.project.name}</span>
            {node.project.id === current && <Check />}
            {node.project.env === "wsl" && <span className="text-[10px] text-muted-foreground">WSL</span>}
            <span className="text-xs text-muted-foreground tabular-nums">{groups.length}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void addWorkspace()}>
          <FolderPlus /> New workspace…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupMenu({ group }: { group: Group }) {
  const title = useGroupTitle(group);
  const order = useSidebarOrder();
  const groups = order.find((x) => x.node.project.id === group.projectId)?.groups ?? [];
  const newGroupKeys = useShortcutLabel("newGroup");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(TRIGGER, "font-medium text-foreground")}>
        <span className="truncate">{title}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Groups</DropdownMenuLabel>
        <div className="max-h-80 overflow-y-auto">
          {groups.map((g) => (
            <GroupMenuItem key={g.id} group={g} current={g.id === group.id} />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void useGroups.getState().newGroup(group.projectId)}>
          <Plus /> New group
          {newGroupKeys && <DropdownMenuShortcut>{newGroupKeys}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupMenuItem({ group, current }: { group: Group; current: boolean }) {
  const title = useGroupTitle(group);
  const state = useApp((s) => groupState(group, s.tree, s.running, s.seen));
  return (
    <DropdownMenuItem onSelect={() => useGroups.getState().reveal(group.id)}>
      <Check className={cn(!current && "invisible")} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ActivityIndicator state={state} />
    </DropdownMenuItem>
  );
}

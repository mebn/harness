import { useEffect } from "react";
import { Folder } from "lucide-react";
import { create } from "zustand";
import { ProjectService } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** Each workspace's icon as a data URL ("" when its folder has none), once looked up. */
const useIcons = create<{ icons: Record<string, string> }>(() => ({ icons: {} }));
const loading = new Set<string>();

function load(projectId: string) {
  if (loading.has(projectId)) return;
  loading.add(projectId);
  ProjectService.Icon(projectId)
    .catch(() => "")
    .then((icon) => useIcons.setState((s) => ({ icons: { ...s.icons, [projectId]: icon } })));
}

/**
 * A workspace's picture: the app icon, favicon or logo found in its folder, so workspaces are
 * told apart at a glance. A folder when it has none.
 */
export function WorkspaceIcon({ projectId, className }: { projectId: string; className?: string }) {
  const icon = useIcons((s) => s.icons[projectId]);
  useEffect(() => load(projectId), [projectId]);
  if (!icon) return <Folder className={cn("size-3.5 text-muted-foreground", className)} />;
  return <img src={icon} alt="" draggable={false} className={cn("size-4 rounded-[3px] object-contain", className)} />;
}

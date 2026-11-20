import { memo, useRef } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { BrowserView } from "@/components/panel/browser-view";
import { FileExplorer } from "@/components/panel/file-explorer";
import { GitChanges } from "@/components/panel/git-changes";
import { TerminalView } from "@/components/panel/terminal-view";
import { tabsOf, type ContentKind, type Tab } from "@/lib/layout-tree";
import { KindPicker } from "./kind-picker";
import { cn } from "@/lib/utils";
import { useGroups, type Group } from "@/stores/group-store";
import { FONT_META, fontSize } from "@/stores/settings-store";
import { useSettings } from "@/stores/settings-store";
import { useTabLayer } from "@/stores/tab-layer-store";

/**
 * Every open tab's content, for all mounted groups, in one layer over the group area. Each is
 * keyed by tab id alone, so moving a tab between windows or groups never remounts it.
 */
export function TabLayer({ groups, activeId }: { groups: Group[]; activeId: string | null }) {
  const placements = useTabLayer((s) => s.placements);
  const animate = useTabLayer((s) => s.animate);
  const setHovered = useTabLayer((s) => s.setHovered);
  const fontSizes = useSettings((s) => s.fontSizes);
  // Once started, a tab stays mounted even if its new group hasn't placed it yet.
  const started = useRef(new Set<string>());

  return (
    <>
      {groups.flatMap((group) =>
        tabsOf(group.root).map((tab) => {
          const place = placements[group.id]?.[tab.id];
          const shown = !!place?.shown && group.id === activeId;
          if (place) started.current.add(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-content={tab.id}
              onPointerDownCapture={() => place && useGroups.getState().focusPane(group.id, place.paneId)}
              onPointerEnter={() => place && setHovered({ groupId: group.id, paneId: place.paneId })}
              onPointerLeave={() => setHovered(null)}
              className={cn(
                "absolute overflow-hidden",
                animate[group.id] !== false && "layout-anim",
                !shown && "pointer-events-none invisible",
              )}
              style={place?.style ?? { inset: 0 }}
            >
              {/* Nothing starts before it has a place, or terminals would begin zero columns wide. */}
              {started.current.has(tab.id) && (
                <TabContent
                  tab={tab}
                  groupId={group.id}
                  projectId={group.projectId}
                  worktree={group.worktree ?? ""}
                  paneId={place?.paneId}
                  visible={shown}
                  focused={shown && group.focused === place?.paneId}
                  size={tab.kind === "new" ? 0 : fontSize(tab.kind, fontSizes)}
                />
              )}
            </div>
          );
        }),
      )}
    </>
  );
}

const TabContent = memo(function TabContent({
  tab,
  groupId,
  projectId,
  worktree,
  paneId,
  visible,
  focused,
  size,
}: {
  tab: Tab;
  groupId: string;
  projectId: string;
  worktree: string;
  paneId: string | undefined;
  visible: boolean;
  /** Visible and in the focused window (its number keys are live). */
  focused: boolean;
  /** Text size for this kind of tab (px; percent for the browser). */
  size: number;
}) {
  // A new tab shows the numbered choices until one is picked; it then becomes that kind in place.
  if (tab.kind === "new") {
    const pick = (kind: ContentKind) => paneId && void useGroups.getState().fillTab(groupId, paneId, kind);
    return <KindPicker focused={focused} onPick={pick} />;
  }
  // Terminals take a real font size; everything else is scaled from its default size.
  if (tab.kind === "terminal") return (
      // A restart (or switching to administrator) is a fresh shell.
      <TerminalView
        key={`${tab.admin ? "admin" : "user"}:${tab.restarts ?? 0}`}
        projectId={projectId}
        worktree={worktree}
        admin={!!tab.admin}
        active={visible}
        fontSize={size}
      />
    );
  return (
    <div className="h-full w-full" style={{ zoom: size / FONT_META[tab.kind].def }}>
      <ScaledContent tab={tab} groupId={groupId} projectId={projectId} worktree={worktree} visible={visible} />
    </div>
  );
});

function ScaledContent({
  tab,
  groupId,
  projectId,
  worktree,
  visible,
}: {
  tab: Tab;
  groupId: string;
  projectId: string;
  worktree: string;
  visible: boolean;
}) {
  switch (tab.kind) {
    case "chat":
      return tab.sessionId ? <ChatView sessionId={tab.sessionId} visible={visible} /> : null;
    case "browser":
      return <BrowserView initialUrl={tab.url} onNavigate={(url) => useGroups.getState().setTabUrl(groupId, tab.id, url)} />;
    case "changes":
      return <GitChanges projectId={projectId} worktree={worktree} active={visible} />;
    case "files":
      return <FileExplorer key={worktree} projectId={projectId} worktree={worktree} active={visible} />;
    default:
      return null;
  }
}

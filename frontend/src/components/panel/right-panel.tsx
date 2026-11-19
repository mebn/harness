import { useState } from "react";
import { FolderTree, GitCompare, Globe, SquareTerminal, type LucideIcon } from "lucide-react";
import { WINDOW_CONTROLS_WIDTH, dragStyle, useCustomTitleBar } from "@/components/layout/window-controls";
import { cn } from "@/lib/utils";
import { PANEL_KINDS, usePanel, type PanelKind } from "@/stores/panel-store";
import { BrowserView } from "./browser-view";
import { FileExplorer } from "./file-explorer";
import { GitChanges } from "./git-changes";
import { TerminalView } from "./terminal-view";

const KINDS: Record<PanelKind, { label: string; icon: LucideIcon }> = {
  files: { label: "Files", icon: FolderTree },
  changes: { label: "Changes", icon: GitCompare },
  terminal: { label: "Terminal", icon: SquareTerminal },
  browser: { label: "Browser", icon: Globe },
};

export function RightPanel() {
  const active = usePanel((s) => s.active);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <TabBar />
      <div className="relative min-h-0 flex-1">
        {/* Every tab stays mounted so terminals and pages keep their state. */}
        {PANEL_KINDS.map((kind) => (
          <div key={kind} className={cn("absolute inset-0", kind !== active && "invisible")}>
            <TabContent kind={kind} active={kind === active} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TabContent({ kind, active }: { kind: PanelKind; active: boolean }) {
  switch (kind) {
    case "files":
      return <FileExplorer active={active} />;
    case "changes":
      return <GitChanges active={active} />;
    case "terminal":
      return <TerminalView active={active} />;
    case "browser":
      return <BrowserView active={active} />;
  }
}

const DRAG_TYPE = "application/x-harness-tab";

/** Fixed tabs; drag to reorder (the order is remembered). */
function TabBar() {
  const order = usePanel((s) => s.order);
  const active = usePanel((s) => s.active);
  const activate = usePanel((s) => s.activate);
  const move = usePanel((s) => s.move);
  const customControls = useCustomTitleBar();
  const [dragging, setDragging] = useState<PanelKind | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const endDrag = () => {
    setDragging(null);
    setDropIndex(null);
  };

  return (
    // Part of the window's title bar: empty space drags the window.
    <div
      className="flex h-11 shrink-0 items-center border-b px-2"
      style={{ ...dragStyle, paddingRight: customControls ? WINDOW_CONTROLS_WIDTH : undefined }}
    >
      <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {order.map((kind, i) => {
          const { label, icon: Icon } = KINDS[kind];
          const selected = kind === active;
          return (
            <div
              key={kind}
              role="tab"
              aria-selected={selected}
              aria-label={label}
              title={label}
              draggable
              onClick={() => activate(kind)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, kind);
                e.dataTransfer.effectAllowed = "move";
                setDragging(kind);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                // Drop before or after this tab depending on which half the pointer is over.
                const rect = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientX < rect.left + rect.width / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = e.dataTransfer.getData(DRAG_TYPE) as PanelKind;
                if (from && dropIndex !== null) {
                  const current = order.indexOf(from);
                  move(from, dropIndex > current ? dropIndex - 1 : dropIndex);
                }
                endDrag();
              }}
              onDragEnd={endDrag}
              style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}
              className={cn(
                "relative flex size-8 shrink-0 cursor-default items-center justify-center rounded-md text-xs text-muted-foreground hover:text-foreground",
                selected && "bg-accent text-foreground",
                dragging === kind && "opacity-40",
              )}
            >
              {dragging && dropIndex === i && <DropMarker side="left" />}
              {dragging && dropIndex === i + 1 && i === order.length - 1 && <DropMarker side="right" />}
              <Icon className="size-4" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DropMarker({ side }: { side: "left" | "right" }) {
  return <span className={cn("absolute inset-y-1 w-0.5 rounded bg-ring", side === "left" ? "-left-0.5" : "-right-0.5")} />;
}

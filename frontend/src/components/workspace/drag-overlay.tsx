import { useDrag } from "@/stores/drag-store";
import { TabIcon } from "./tab-meta";

/**
 * Shown while a tab or window is dragged: a full-screen layer (so iframes and terminals don't
 * swallow the pointer) and a chip following the cursor.
 */
export function DragOverlay() {
  const drag = useDrag((s) => s.drag);
  const pointer = useDrag((s) => s.pointer);
  if (!drag) return null;
  const nowhere = !drag.target;

  return (
    <div data-drag-overlay className="fixed inset-0 z-[60] cursor-grabbing select-none">
      <div
        className="pointer-events-none absolute flex max-w-60 items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-[13px] font-medium text-popover-foreground shadow-lg transition-opacity"
        style={{ left: pointer.x + 12, top: pointer.y + 10, opacity: nowhere ? 0.6 : 1 }}
      >
        {drag.icon && <TabIcon kind={drag.icon} className="size-3.5 shrink-0 opacity-80" />}
        <span className="truncate">{drag.label}</span>
        {drag.payload.kind === "pane" && <span className="text-xs font-normal text-muted-foreground">window</span>}
      </div>
    </div>
  );
}

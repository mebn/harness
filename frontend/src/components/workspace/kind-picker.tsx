import { TAB_KINDS, type ContentKind } from "@/lib/layout-tree";
import { cn } from "@/lib/utils";
import { KIND_META, TabIcon } from "./tab-meta";

/**
 * The numbered choices shown by a new tab or an empty window: click one, or press its number
 * while the window is focused. Sized by the window it sits in, and scrolls rather than overflowing.
 */
export function KindPicker({ focused, onPick }: { focused: boolean; onPick: (kind: ContentKind) => void }) {
  return (
    <div className="flex h-full overflow-auto">
      <div className="m-auto flex w-full max-w-56 flex-col gap-0.5 p-3">
        {TAB_KINDS.map((kind, i) => (
          <button
            key={kind}
            onClick={() => onPick(kind)}
            className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <TabIcon kind={kind} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{KIND_META[kind].label}</span>
            <kbd
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded border font-sans text-[11px]",
                focused ? "border-ring/50 text-foreground" : "text-muted-foreground/60",
              )}
            >
              {i + 1}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

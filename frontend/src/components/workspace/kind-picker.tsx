import { TAB_KINDS, type ContentKind } from "@/lib/layout-tree";
import { cn } from "@/lib/utils";
import { KIND_META, TabIcon } from "./tab-meta";

/**
 * The numbered choices shown by a new tab or an empty window: click one, or press its number
 * while the window is focused. Sized by the window it sits in, and scrolls rather than overflowing.
 */
export function KindPicker({ focused, onPick }: { focused: boolean; onPick: (kind: ContentKind) => void }) {
  return (
    <div className="@container flex h-full overflow-auto">
      <div className="m-auto flex flex-wrap justify-center gap-1 p-2 @sm:gap-2 @sm:p-4">
        {TAB_KINDS.map((kind, i) => (
          <button
            key={kind}
            onClick={() => onPick(kind)}
            className="relative flex w-[4.5rem] flex-col items-center gap-1.5 rounded-xl border border-transparent px-2 py-2 text-xs text-muted-foreground hover:border-border hover:bg-foreground/[0.03] hover:text-foreground @sm:w-24 @sm:gap-2 @sm:px-3 @sm:py-3"
          >
            <kbd
              className={cn(
                "absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded border font-sans text-[10px]",
                focused ? "border-ring/50 text-foreground" : "text-muted-foreground/60",
              )}
            >
              {i + 1}
            </kbd>
            <TabIcon kind={kind} className="size-5" />
            {KIND_META[kind].label}
          </button>
        ))}
      </div>
    </div>
  );
}

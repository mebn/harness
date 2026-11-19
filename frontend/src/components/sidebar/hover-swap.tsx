import type { ReactNode } from "react";

/**
 * Right-aligned slot for a `group` row: shows muted `idle` text normally and swaps to
 * `children` (actions) on hover or while one of its menus is open.
 *
 * Both stay laid out in the same grid cell and only toggle visibility: a menu is anchored to
 * its trigger, and a trigger removed from layout (display: none) as the menu closes would send
 * the closing menu to the top-left corner.
 */
export function HoverSwap({ idle, children }: { idle: string; children: ReactNode }) {
  return (
    <div className="grid shrink-0 items-center justify-items-end">
      <span className="col-start-1 row-start-1 text-[11px] whitespace-nowrap text-muted-foreground/70 group-hover:invisible group-has-[[data-state=open]]:invisible">
        {idle}
      </span>
      <div className="invisible col-start-1 row-start-1 flex items-center group-hover:visible group-has-[[data-state=open]]:visible">
        {children}
      </div>
    </div>
  );
}

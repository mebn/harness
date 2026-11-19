import type { ReactNode } from "react";

/**
 * Right-aligned slot for a `group` row: shows muted `idle` text normally and
 * swaps to `children` (actions) on hover or while one of its menus is open.
 */
export function HoverSwap({ idle, children }: { idle: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center">
      <span className="text-[11px] whitespace-nowrap text-muted-foreground/70 group-hover:hidden group-has-[[data-state=open]]:hidden">
        {idle}
      </span>
      <div className="hidden items-center group-hover:flex group-has-[[data-state=open]]:flex">{children}</div>
    </div>
  );
}

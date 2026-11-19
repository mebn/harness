import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type SubTab = {
  id: string;
  label: string;
  icon?: ReactNode;
  title?: string;
  /** Pinned tabs (e.g. the file tree) have no close button. */
  closable?: boolean;
};

type Props = {
  tabs: SubTab[];
  active: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onAdd?: () => void;
  addLabel?: string;
};

/** Secondary tab strip inside a panel (files, terminals, browser pages). */
export function SubTabBar({ tabs, active, onSelect, onClose, onAdd, addLabel = "New tab" }: Props) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1">
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={selected}
              title={t.title ?? t.label}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => e.button === 1 && t.closable && onClose?.(t.id)}
              className={cn(
                "group flex h-6 max-w-40 shrink-0 cursor-default items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                selected && "bg-accent text-foreground",
              )}
            >
              {/* Leading slot: the icon, swapped for the close button on hover. */}
              {(t.icon || (t.closable && onClose)) && (
                <span className="relative flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
                  {t.icon && <span className={cn("flex", t.closable && onClose && "group-hover:invisible")}>{t.icon}</span>}
                  {t.closable && onClose && (
                    <button
                      aria-label={`Close ${t.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(t.id);
                      }}
                      className={cn(
                        "absolute inset-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted",
                        !t.icon && selected && "opacity-60",
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              )}
              {t.label && <span className="truncate">{t.label}</span>}
            </div>
          );
        })}
      </div>
      {onAdd && (
        <button
          aria-label={addLabel}
          title={addLabel}
          onClick={onAdd}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Small helper for "add / close / select" tab lists with stable ids. */
export function closeTab<T extends { id: string }>(tabs: T[], id: string, active: string) {
  const i = tabs.findIndex((t) => t.id === id);
  const next = tabs.filter((t) => t.id !== id);
  const nextActive = active === id ? (next[Math.min(i, next.length - 1)]?.id ?? "") : active;
  return { tabs: next, active: nextActive };
}

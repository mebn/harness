import { useEffect, useMemo, useRef } from "react";
import type { SlashCommand } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** Handled by Harness itself, so always offered. */
const LOCAL: SlashCommand[] = [
  { name: "clear", description: "Clear this chat and start a fresh conversation", argumentHint: "", aliases: ["new", "reset"], builtin: true },
];

/** The command being typed: "/name" with no space yet, or null. */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Commands matching a query: name prefix first, then alias prefix, then anywhere in the name. */
export function matchCommands(all: SlashCommand[] | undefined, query: string): SlashCommand[] {
  const seen = new Set<string>();
  const list = [...LOCAL, ...(all ?? [])].filter((c) => !seen.has(c.name) && seen.add(c.name));
  const rank = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(query)) return 0;
    if ((c.aliases ?? []).some((a) => a.toLowerCase().startsWith(query))) return 1;
    if (name.includes(query)) return 2;
    return -1;
  };
  return list
    .map((c) => [c, rank(c)] as const)
    .filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([c]) => c);
}

type Props = {
  items: SlashCommand[];
  loading: boolean;
  index: number;
  onHover: (i: number) => void;
  onPick: (c: SlashCommand) => void;
};

/** Autocomplete for slash commands, shown above the composer. */
export function SlashMenu({ items, loading, index, onHover, onPick }: Props) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const shown = useMemo(() => items.slice(0, 200), [items]);
  if (!loading && shown.length === 0) return null;
  return (
    <div ref={list} className="mb-1.5 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 text-sm shadow-md" role="listbox">
      {shown.map((c, i) => (
        <button
          key={c.name}
          data-index={i}
          role="option"
          aria-selected={i === index}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the composer
            onPick(c);
          }}
          className={cn("flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left", i === index && "bg-accent")}
        >
          <span className="shrink-0 font-mono text-xs">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.argumentHint}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
        </button>
      ))}
      {loading && <p className="px-2 py-1 text-xs text-muted-foreground">Loading commands…</p>}
    </div>
  );
}

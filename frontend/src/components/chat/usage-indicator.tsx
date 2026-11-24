import { useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/backend";
import { useUsage } from "@/stores/usage-store";
import type { Window } from "@bindings/harness/internal/usage/models";

const POLL_MS = 2 * 60_000;
/** Assumed when the provider has not reported the model's context size. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context used in this chat, plus plan usage for its provider: Claude 5h + week, Copilot month. */
export function UsageIndicator({ session }: { session: Session }) {
  const provider = session.provider;
  const snap = useUsage((s) => (provider ? s.snapshots[provider] : undefined));
  const load = useUsage((s) => s.load);
  const now = useNow();

  useEffect(() => {
    if (!provider) return;
    void load(provider);
    const t = setInterval(() => void load(provider), POLL_MS);
    return () => clearInterval(t);
  }, [provider, load]);

  const windows = snap?.windows ?? [];
  const context = contextUsage(session);

  // Context first (empty until a turn reports it), then each plan window (5h, week / month).
  const items: Item[] = [
    {
      id: "context",
      label: "Context",
      used: context?.used ?? 0,
      explain: "How much of the model's context window this chat fills. Near the limit, Claude compacts older parts of the conversation.",
      detail: context
        ? `${formatTokens(context.tokens)} of ${formatTokens(context.window)} tokens · ${Math.round((1 - context.used) * 100)}% left`
        : "Shown after the first reply",
    },
  ];
  for (const w of windows) {
    items.push({
      id: w.id,
      label: w.label,
      used: w.unlimited ? undefined : effectiveUsed(w, now),
      explain: WINDOW_EXPLAIN[w.id] ?? `Your plan's usage for this period (${w.label}).`,
      detail: describe(w, now),
    });
  }

  return <UsageSummary items={items} />;
}

type Item = { id: string; label: string; used?: number; explain: string; detail: string };

const WINDOW_EXPLAIN: Record<string, string> = {
  five_hour: "Your plan's usage in the current 5-hour window. When it reaches 100%, turns pause until the window resets.",
  seven_day: "Your plan's usage over the current 7-day window, across all your Claude sessions.",
  month: "Premium requests used this month on your Copilot plan.",
};

const pctText = (used?: number) => (used === undefined ? "∞" : `${Math.round(used * 100)}%`);
const pctColor = (used?: number) =>
  used === undefined ? "" : used >= 0.9 ? "text-red-500" : used >= 0.7 ? "text-amber-500" : "text-foreground/80";

/** "Context 5% · 5h 30% · Week 44%"; hovering or clicking opens a card explaining each. */
function UsageSummary({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  // Clicked open: stays until clicked again or dismissed, instead of closing on mouse leave.
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const hover = (inside: boolean) => {
    clearTimeout(closeTimer.current);
    if (pinned.current) return;
    if (inside) setOpen(true);
    else closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) pinned.current = false;
      }}
    >
      <PopoverPrimitive.Trigger
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        onClick={(e) => {
          // Radix toggles on click; turn that into pin / unpin.
          e.preventDefault();
          pinned.current = !(pinned.current && open);
          setOpen(pinned.current);
        }}
        className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums outline-none hover:bg-accent data-[state=open]:bg-accent"
        style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}
      >
        {items.map((it, i) => (
          <span key={it.id} className="flex items-center gap-1">
            {i > 0 && <span className="mr-1 opacity-40">·</span>}
            {it.label}
            <span className={cn("font-medium", pctColor(it.used))}>{pctText(it.used)}</span>
          </span>
        ))}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 flex w-72 flex-col gap-3 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          {items.map((it) => (
            <div key={it.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{it.label}</span>
                <span className={cn("font-medium tabular-nums", pctColor(it.used))}>{pctText(it.used)}</span>
              </div>
              <p className="text-muted-foreground">{it.explain}</p>
              <p className="text-[11px] text-muted-foreground/80 tabular-nums">{it.detail}</p>
            </div>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Usage after a window has reset is 0, even if the stored snapshot is older. */
function effectiveUsed(w: Window, now: number): number {
  return w.resetsAt && now >= w.resetsAt ? 0 : w.used;
}

function describe(w: Window, now: number): string {
  // The percentage is shown beside the label already.
  const parts = w.unlimited ? [w.detail || "Unlimited"] : w.detail ? [w.detail] : [];
  if (w.resetsAt) parts.push(`Resets ${w.resetsAt > now ? `in ${until(w.resetsAt - now)}` : "now"}`);
  return parts.join(" · ");
}

function until(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** How full the chat's context was after its latest turn; undefined until a turn reports it. */
function contextUsage(s: Session) {
  if (!s.contextTokens) return undefined;
  const window = s.contextWindow || DEFAULT_CONTEXT_WINDOW;
  return { tokens: s.contextTokens, window, used: Math.min(1, s.contextTokens / window) };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

import { useEffect } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/backend";
import { useUsage } from "@/stores/usage-store";
import type { Window } from "@bindings/harness/server/internal/usage/models";

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
  const items: Item[] = [{ id: "context", label: "Context", used: context ?? 0 }];
  for (const w of windows) {
    items.push({
      id: w.id,
      label: w.label,
      used: w.unlimited ? undefined : effectiveUsed(w, now),
      resets: w.resetsAt ? (w.resetsAt > now ? `Resets in ${until(w.resetsAt - now)}` : "Resets now") : undefined,
    });
  }

  return <UsageSummary items={items} />;
}

type Item = { id: string; label: string; used?: number; resets?: string };

const pctText = (used?: number) => (used === undefined ? "∞" : `${Math.round(used * 100)}%`);
const pctColor = (used?: number) =>
  used === undefined ? "" : used >= 0.9 ? "text-red-500" : used >= 0.7 ? "text-amber-500" : "text-foreground/80";

/** "Context 5% · 5h 30% · Week 44%"; clicking opens a card with each one and when it resets. */
function UsageSummary({ items }: { items: Item[] }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
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
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 flex w-56 flex-col gap-2 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          {items.map((it) => (
            <div key={it.id} className="flex items-baseline gap-2">
              <span className="font-medium">{it.label}</span>
              <span className={cn("font-medium tabular-nums", pctColor(it.used))}>{pctText(it.used)}</span>
              {it.resets && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{it.resets}</span>}
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
  return Math.min(1, s.contextTokens / (s.contextWindow || DEFAULT_CONTEXT_WINDOW));
}

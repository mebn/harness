import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useActiveSession } from "@/stores/app-store";
import { useUsage } from "@/stores/usage-store";
import type { Window } from "@bindings/harness/internal/usage/models";

const POLL_MS = 2 * 60_000;

/** Plan usage for the active session's provider: Claude 5h + week, Copilot month. */
export function UsageIndicator() {
  const provider = useActiveSession()?.provider;
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
  if (windows.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums" style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}>
          {windows.map((w) => (
            <UsageMeter key={w.id} window={w} now={now} />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-0.5">
        {windows.map((w) => (
          <span key={w.id}>
            {w.label}: {describe(w, now)}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** Usage after a window has reset is 0, even if the stored snapshot is older. */
function effectiveUsed(w: Window, now: number): number {
  return w.resetsAt && now >= w.resetsAt ? 0 : w.used;
}

function UsageMeter({ window: w, now }: { window: Window; now: number }) {
  if (w.unlimited) {
    return (
      <span>
        {w.label} <span className="text-foreground/70">{w.detail || "∞"}</span>
      </span>
    );
  }
  const pct = Math.round(effectiveUsed(w, now) * 100);
  return (
    <span className="flex items-center gap-1.5">
      {w.label}
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-foreground/40",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="w-7 text-right">{pct}%</span>
    </span>
  );
}

function describe(w: Window, now: number): string {
  const used = w.unlimited ? w.detail || "unlimited" : `${Math.round(effectiveUsed(w, now) * 100)}% used`;
  const extra = !w.unlimited && w.detail ? ` (${w.detail})` : "";
  if (!w.resetsAt) return used + extra;
  return `${used}${extra} · resets ${w.resetsAt > now ? `in ${until(w.resetsAt - now)}` : "now"}`;
}

function until(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

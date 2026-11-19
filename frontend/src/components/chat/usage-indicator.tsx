import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/backend";
import { useUsage } from "@/stores/usage-store";
import type { Window } from "@bindings/harness/internal/usage/models";

const POLL_MS = 2 * 60_000;
/** Assumed when the provider has not reported the model's context size. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context left in this chat, plus plan usage for its provider: Claude 5h + week, Copilot month. */
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
  if (windows.length === 0 && !context) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums" style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}>
          {context && <Meter label="Context" used={context.used} text={`${Math.round((1 - context.used) * 100)}% left`} />}
          {windows.map((w) => (
            <UsageMeter key={w.id} window={w} now={now} />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-0.5">
        {context && (
          <span>
            Context: {formatTokens(context.tokens)} of {formatTokens(context.window)} used ·{" "}
            {Math.round((1 - context.used) * 100)}% left
          </span>
        )}
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
  const used = effectiveUsed(w, now);
  return <Meter label={w.label} used={used} text={`${Math.round(used * 100)}%`} />;
}

function Meter({ label, used, text }: { label: string; used: number; text: string }) {
  const pct = Math.round(used * 100);
  return (
    <span className="flex items-center gap-1.5">
      {label}
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-foreground/40",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="min-w-7 text-right">{text}</span>
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

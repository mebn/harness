import { Loader2 } from "lucide-react";
import type { ActivityState } from "@/lib/session-state";
import { cn } from "@/lib/utils";

const LABELS: Record<ActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  finished: "Finished",
  error: "Failed",
  idle: "",
};

const DOT: Partial<Record<ActivityState, string>> = {
  waiting: "bg-amber-500",
  finished: "bg-emerald-500",
  error: "bg-red-500",
};

/** Spinner while working, a colored dot for unseen outcomes, nothing when idle. */
export function ActivityIndicator({ state, className }: { state: ActivityState; className?: string }) {
  if (state === "idle") return null;
  return (
    <span title={LABELS[state]} aria-label={LABELS[state]} className={cn("flex size-3.5 shrink-0 items-center justify-center", className)}>
      {state === "working" ? (
        <Loader2 className="size-3 animate-spin text-sky-500" />
      ) : (
        <span className={cn("size-1.5 rounded-full", DOT[state])} />
      )}
    </span>
  );
}

/** Text tint applied to a row's title so states read at a glance. */
export const STATE_TEXT: Partial<Record<ActivityState, string>> = {
  working: "text-foreground",
  waiting: "text-foreground font-medium",
  finished: "text-foreground font-medium",
  error: "text-foreground font-medium",
};

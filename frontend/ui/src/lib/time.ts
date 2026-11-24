import { useEffect, useState } from "react";

const UNITS: [number, string][] = [
  [365 * 24 * 3600, "y"],
  [30 * 24 * 3600, "mo"],
  [7 * 24 * 3600, "w"],
  [24 * 3600, "d"],
  [3600, "h"],
  [60, "m"],
];

/** "just now", "5m ago", "6h ago", "3d ago" … */
export function timeAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  for (const [size, unit] of UNITS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

const listeners = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Current time that re-renders subscribers once a minute (one shared timer). */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    listeners.add(setNow);
    timer ??= setInterval(() => listeners.forEach((l) => l(Date.now())), 60_000);
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return now;
}

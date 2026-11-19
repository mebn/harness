import type { Session } from "@/lib/backend";

/** What the sidebar shows for a session or folder. */
export type ActivityState = "working" | "error" | "waiting" | "finished" | "idle";

// Higher wins when summarizing a folder.
const PRIORITY: Record<ActivityState, number> = { idle: 0, finished: 1, waiting: 2, error: 3, working: 4 };

/**
 * working:  agent is running
 * waiting:  turn ended with a question for you, not seen yet
 * finished: turn completed, not seen yet
 * error:    turn failed, not seen yet
 * idle:     nothing new
 */
export function sessionState(s: Session, running: boolean, seenAt: number | undefined): ActivityState {
  if (running) return "working";
  const unseen = seenAt === undefined || s.updatedAt > seenAt;
  if (!unseen) return "idle";
  switch (s.lastStatus) {
    case "error":
      return "error";
    case "waiting":
      return "waiting";
    case "done":
      return "finished";
    default:
      return "idle";
  }
}

export function strongest(states: ActivityState[]): ActivityState {
  return states.reduce<ActivityState>((a, b) => (PRIORITY[b] > PRIORITY[a] ? b : a), "idle");
}

/** A workspace's last activity: newest session update, else when it was added. */
export function projectLastUsed(node: { project: { createdAt: number }; sessions: Session[] | null }): number {
  return Math.max(node.project.createdAt, ...(node.sessions ?? []).map((s) => s.updatedAt));
}

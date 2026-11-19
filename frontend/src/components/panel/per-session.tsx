import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { findSession, useApp } from "@/stores/app-store";

type Instance = { sessionId: string; projectId: string };

type Props = {
  /** Whether the panel tab hosting this is visible. */
  active: boolean;
  render: (instance: Instance, visible: boolean) => ReactNode;
  empty?: ReactNode;
};

/**
 * Keeps one instance per session (e.g. a terminal) so the right panel follows the
 * active session. Instances are created the first time their session is shown while
 * the tab is open, stay alive in the background, and are disposed when the session
 * is deleted.
 */
export function PerSession({ active, render, empty }: Props) {
  const activeSessionId = useApp((s) => s.activeSessionId);
  const tree = useApp((s) => s.tree);
  const [instances, setInstances] = useState<Instance[]>([]);

  // Create an instance for the active session the first time it is shown.
  useEffect(() => {
    if (!active || !activeSessionId) return;
    const session = findSession(tree, activeSessionId);
    if (!session) return;
    setInstances((list) =>
      list.some((i) => i.sessionId === session.id) ? list : [...list, { sessionId: session.id, projectId: session.projectId }],
    );
  }, [active, activeSessionId, tree]);

  // Drop instances whose session was deleted.
  useEffect(() => {
    setInstances((list) => {
      const next = list.filter((i) => findSession(tree, i.sessionId));
      return next.length === list.length ? list : next;
    });
  }, [tree]);

  const hasCurrent = instances.some((i) => i.sessionId === activeSessionId);

  return (
    <div className="relative h-full">
      {instances.map((inst) => {
        const visible = inst.sessionId === activeSessionId;
        return (
          <div key={inst.sessionId} className={cn("absolute inset-0", !visible && "invisible")}>
            {render(inst, active && visible)}
          </div>
        );
      })}
      {!hasCurrent && (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{empty ?? "No session"}</div>
      )}
    </div>
  );
}

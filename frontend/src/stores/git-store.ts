import { useEffect } from "react";
import { create } from "zustand";
import { GitService, type GitStatus } from "@/lib/backend";
import { useApp } from "@/stores/app-store";

const POLL_MS = 3000;

type GitState = {
  statuses: Record<string, GitStatus>;
  errors: Record<string, string>;
  refresh: (projectId: string) => Promise<void>;
};

/** Git status per project, shared by the file explorer and the Changes tab. */
export const useGit = create<GitState>((set, get) => ({
  statuses: {},
  errors: {},
  refresh: async (projectId) => {
    try {
      const status = await GitService.Status(projectId);
      const prev = get().statuses[projectId];
      // Skip identical results so subscribers don't re-render every poll.
      if (!prev || JSON.stringify(prev) !== JSON.stringify(status)) {
        set({ statuses: { ...get().statuses, [projectId]: status } });
      }
      if (get().errors[projectId]) {
        const { [projectId]: _, ...rest } = get().errors;
        set({ errors: rest });
      }
    } catch (e) {
      set({ errors: { ...get().errors, [projectId]: String(e) } });
    }
  },
}));

/**
 * Keeps a project's git status fresh while `active`: polls, re-checks on window
 * focus and whenever an agent turn finishes.
 */
export function useGitStatus(projectId: string | undefined, active: boolean) {
  const runningCount = useApp((s) => Object.values(s.running).filter(Boolean).length);
  const status = useGit((s) => (projectId ? s.statuses[projectId] : undefined));
  const error = useGit((s) => (projectId ? s.errors[projectId] : undefined));

  useEffect(() => {
    if (!active || !projectId) return;
    const refresh = () => void useGit.getState().refresh(projectId);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [active, projectId, runningCount]);

  return { status, error, refresh: () => (projectId ? useGit.getState().refresh(projectId) : Promise.resolve()) };
}

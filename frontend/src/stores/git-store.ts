import { useEffect } from "react";
import { create } from "zustand";
import { GitService, type GitStatus } from "@/lib/backend";
import { useApp } from "@/stores/app-store";

const POLL_MS = 3000;

type GitState = {
  /** Keyed by project and worktree (see `gitKey`). */
  statuses: Record<string, GitStatus>;
  errors: Record<string, string>;
  refresh: (projectId: string, worktree?: string) => Promise<void>;
};

const gitKey = (projectId: string, worktree?: string) => (worktree ? `${projectId}/${worktree}` : projectId);

/** Git status per project (or worktree), shared by the file explorer and the Changes tab. */
export const useGit = create<GitState>((set, get) => ({
  statuses: {},
  errors: {},
  refresh: async (projectId, worktree) => {
    const key = gitKey(projectId, worktree);
    try {
      const status = await GitService.Status(projectId, worktree ?? "");
      const prev = get().statuses[key];
      // Skip identical results so subscribers don't re-render every poll.
      if (!prev || JSON.stringify(prev) !== JSON.stringify(status)) {
        set({ statuses: { ...get().statuses, [key]: status } });
      }
      if (get().errors[key]) {
        const { [key]: _, ...rest } = get().errors;
        set({ errors: rest });
      }
    } catch (e) {
      set({ errors: { ...get().errors, [key]: String(e) } });
    }
  },
}));

/**
 * Keeps a project's git status fresh while `active`: polls, re-checks on window
 * focus and whenever an agent turn finishes.
 */
export function useGitStatus(projectId: string | undefined, active: boolean, worktree?: string) {
  const runningCount = useApp((s) => Object.values(s.running).filter(Boolean).length);
  const key = projectId ? gitKey(projectId, worktree) : undefined;
  const status = useGit((s) => (key ? s.statuses[key] : undefined));
  const error = useGit((s) => (key ? s.errors[key] : undefined));

  useEffect(() => {
    if (!active || !projectId) return;
    const refresh = () => void useGit.getState().refresh(projectId, worktree);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [active, projectId, worktree, runningCount]);

  return { status, error, refresh: () => (projectId ? useGit.getState().refresh(projectId, worktree) : Promise.resolve()) };
}

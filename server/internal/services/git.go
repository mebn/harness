package services

import (
	"context"
	"errors"
	"strings"

	"harness/server/internal/gitx"
	"harness/server/internal/platform"
	"harness/server/internal/store"
)

// GitService exposes working-tree changes, commit and push for a project or one of its
// worktrees (worktree "" is the project's own checkout), and lists and creates worktrees.
type GitService struct{ store *store.Store }

func NewGitService(s *store.Store) *GitService { return &GitService{store: s} }

func (g *GitService) repo(projectID, worktree string) (gitx.Repo, error) {
	loc, err := locate(g.store, projectID, worktree)
	if err != nil {
		return gitx.Repo{}, err
	}
	return gitx.Repo{Dir: loc.Dir, Env: loc.Env}, nil
}

func (g *GitService) Status(projectID, worktree string) (gitx.Status, error) {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return gitx.Status{}, err
	}
	return r.Status(context.Background())
}

func (g *GitService) Diff(projectID, worktree string, file gitx.File) (string, error) {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return "", err
	}
	return r.Diff(context.Background(), file)
}

// Commit commits the staged changes, or every change when nothing is staged.
func (g *GitService) Commit(projectID, worktree, message string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.Commit(context.Background(), message)
}

// Stage adds paths to the index; no paths stages every change.
func (g *GitService) Stage(projectID, worktree string, paths []string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.Stage(context.Background(), paths)
}

// Unstage takes paths out of the index, keeping their edits; no paths unstages everything.
func (g *GitService) Unstage(projectID, worktree string, paths []string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.Unstage(context.Background(), paths)
}

// Discard throws away the unstaged changes of files (untracked files are deleted).
func (g *GitService) Discard(projectID, worktree string, files []gitx.File) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.Discard(context.Background(), files)
}

func (g *GitService) Push(projectID, worktree string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	st, err := r.Status(context.Background())
	if err != nil {
		return err
	}
	return r.Push(context.Background(), st.Upstream != "")
}

// Branches lists local branches of the project's checkout or a worktree, current first.
func (g *GitService) Branches(projectID, worktree string) ([]gitx.Branch, error) {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return nil, err
	}
	return r.Branches(context.Background())
}

// SwitchBranch checks out an existing branch in the project's checkout or a worktree.
func (g *GitService) SwitchBranch(projectID, worktree, branch string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.Switch(context.Background(), branch)
}

// CreateBranch makes a branch from the current commit and switches to it.
func (g *GitService) CreateBranch(projectID, worktree, branch string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.CreateBranch(context.Background(), strings.TrimSpace(branch))
}

// Worktrees lists the project's Claude Code worktrees (none outside a git repository).
func (g *GitService) Worktrees(projectID string) ([]gitx.Worktree, error) {
	proj, err := g.store.Project(projectID)
	if err != nil {
		return nil, err
	}
	list, err := gitx.Repo{Dir: proj.Path, Env: platform.EnvForPath(proj.Path)}.Worktrees(context.Background())
	if err != nil && strings.Contains(err.Error(), "not a git repository") {
		return []gitx.Worktree{}, nil
	}
	return list, err
}

// CreateWorktree adds a worktree named name, as `claude --worktree <name>` would.
func (g *GitService) CreateWorktree(projectID, name string) (gitx.Worktree, error) {
	name = strings.TrimSpace(name)
	if !validWorktree.MatchString(name) {
		return gitx.Worktree{}, errors.New("use letters, digits, '.', '_' or '-' (no spaces)")
	}
	proj, err := g.store.Project(projectID)
	if err != nil {
		return gitx.Worktree{}, err
	}
	root, _, err := repoRoot(proj)
	if err != nil {
		return gitx.Worktree{}, err
	}
	existing, err := g.Worktrees(projectID)
	if err != nil {
		return gitx.Worktree{}, err
	}
	for _, w := range existing {
		if w.Name == name {
			return gitx.Worktree{}, errors.New("a worktree named " + name + " already exists")
		}
	}
	return gitx.Repo{Dir: root, Env: platform.EnvForPath(proj.Path)}.AddWorktree(context.Background(), root, name)
}

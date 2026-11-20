package services

import (
	"context"
	"errors"
	"strings"

	"harness/internal/gitx"
	"harness/internal/platform"
	"harness/internal/store"
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

// Commit stages all changes and commits them with message.
func (g *GitService) Commit(projectID, worktree, message string) error {
	r, err := g.repo(projectID, worktree)
	if err != nil {
		return err
	}
	return r.CommitAll(context.Background(), message)
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

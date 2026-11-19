package services

import (
	"context"

	"harness/internal/gitx"
	"harness/internal/platform"
	"harness/internal/store"
)

// GitService exposes working-tree changes, commit and push for a project.
type GitService struct{ store *store.Store }

func NewGitService(s *store.Store) *GitService { return &GitService{store: s} }

func (g *GitService) repo(projectID string) (gitx.Repo, error) {
	proj, err := g.store.Project(projectID)
	if err != nil {
		return gitx.Repo{}, err
	}
	return gitx.Repo{Dir: proj.Path, Env: platform.EnvForPath(proj.Path)}, nil
}

func (g *GitService) Status(projectID string) (gitx.Status, error) {
	r, err := g.repo(projectID)
	if err != nil {
		return gitx.Status{}, err
	}
	return r.Status(context.Background())
}

func (g *GitService) Diff(projectID string, file gitx.File) (string, error) {
	r, err := g.repo(projectID)
	if err != nil {
		return "", err
	}
	return r.Diff(context.Background(), file)
}

// Commit stages all changes and commits them with message.
func (g *GitService) Commit(projectID, message string) error {
	r, err := g.repo(projectID)
	if err != nil {
		return err
	}
	return r.CommitAll(context.Background(), message)
}

func (g *GitService) Push(projectID string) error {
	r, err := g.repo(projectID)
	if err != nil {
		return err
	}
	st, err := r.Status(context.Background())
	if err != nil {
		return err
	}
	return r.Push(context.Background(), st.Upstream != "")
}

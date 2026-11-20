package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"harness/internal/gitx"
	"harness/internal/platform"
	"harness/internal/store"
)

// validWorktree matches worktree names: one path segment, as Claude Code allows.
var validWorktree = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// prefixes caches each project folder's path inside its repository ("" at the root).
var prefixes sync.Map // project path -> string

// location is where a project's tools run: its folder, or the same folder in a worktree.
type location struct {
	Dir string
	Env platform.Env
}

// repoRoot returns the repository root (as a host path) and the project's prefix inside it.
func repoRoot(proj store.Project) (root, prefix string, err error) {
	env := platform.EnvForPath(proj.Path)
	if v, ok := prefixes.Load(proj.Path); ok {
		prefix = v.(string)
	} else {
		prefix, err = gitx.Repo{Dir: proj.Path, Env: env}.Prefix(context.Background())
		if err != nil {
			if strings.Contains(err.Error(), "not a git repository") {
				return "", "", gitx.ErrNotRepo
			}
			return "", "", err
		}
		prefixes.Store(proj.Path, prefix)
	}
	root = filepath.Clean(proj.Path)
	for _, seg := range strings.Split(strings.Trim(prefix, "/"), "/") {
		if seg != "" {
			root = filepath.Dir(root)
		}
	}
	return root, prefix, nil
}

// worktreeRoot is the host path of a worktree's checkout.
func worktreeRoot(repo, name string) string {
	return filepath.Join(repo, filepath.FromSlash(gitx.WorktreesDir), name)
}

// locate resolves a project, or one of its worktrees when worktree is set, to a folder.
// In a worktree the folder is the project's own subfolder, if the project is one.
func locate(s *store.Store, projectID, worktree string) (location, error) {
	proj, err := s.Project(projectID)
	if err != nil {
		return location{}, err
	}
	env := platform.EnvForPath(proj.Path)
	if worktree == "" {
		return location{Dir: proj.Path, Env: env}, nil
	}
	if !validWorktree.MatchString(worktree) {
		return location{}, errors.New("invalid worktree name")
	}
	root, prefix, err := repoRoot(proj)
	if err != nil {
		return location{}, err
	}
	dir := filepath.Join(worktreeRoot(root, worktree), filepath.FromSlash(prefix))
	if _, err := os.Stat(dir); err != nil {
		return location{}, errors.New("worktree not found: " + worktree)
	}
	return location{Dir: dir, Env: env}, nil
}

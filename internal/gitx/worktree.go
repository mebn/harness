package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Worktrees follow Claude Code's `--worktree` layout: <repo>/.claude/worktrees/<name>, on
// branch worktree-<name>. Staying with that layout means worktrees made here and by the CLI
// are the same thing.
const (
	WorktreesDir  = ".claude/worktrees"
	BranchPrefix  = "worktree-"
	worktreesPath = "/" + WorktreesDir + "/"
)

// Worktree is one of the repository's Claude Code worktrees.
type Worktree struct {
	Name   string `json:"name"`
	Branch string `json:"branch"`
}

// Prefix is the workspace's path inside the repository ("" at the root, else "sub/dir/").
func (r Repo) Prefix(ctx context.Context) (string, error) {
	out, err := r.run(ctx, readTimeout, "rev-parse", "--show-prefix")
	return strings.TrimSpace(string(out)), err
}

// Worktrees lists the repository's worktrees under .claude/worktrees.
func (r Repo) Worktrees(ctx context.Context) ([]Worktree, error) {
	out, err := r.run(ctx, readTimeout, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	return parseWorktrees(string(out)), nil
}

func parseWorktrees(out string) []Worktree {
	list := []Worktree{}
	for _, block := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n\n") {
		var name, branch string
		prunable := false
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				p := strings.ReplaceAll(strings.TrimPrefix(line, "worktree "), `\`, "/")
				if i := strings.LastIndex(p, worktreesPath); i >= 0 && !strings.Contains(p[i+len(worktreesPath):], "/") {
					name = p[i+len(worktreesPath):]
				}
			case strings.HasPrefix(line, "branch "):
				branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
			case strings.HasPrefix(line, "prunable"):
				prunable = true
			}
		}
		if name != "" && !prunable {
			list = append(list, Worktree{Name: name, Branch: branch})
		}
	}
	return list
}

// AddWorktree creates .claude/worktrees/<name> on branch worktree-<name>, starting from HEAD
// (or reusing the branch if it already exists). r must be at the repository root (rootDir is
// the same folder as a host path). The worktrees folder is added to the local exclude file so
// the main checkout doesn't list it as untracked.
func (r Repo) AddWorktree(ctx context.Context, rootDir, name string) (Worktree, error) {
	branch := BranchPrefix + name
	path := WorktreesDir + "/" + name
	args := []string{"worktree", "add"}
	if _, err := r.run(ctx, readTimeout, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		args = append(args, path, branch)
	} else {
		args = append(args, "-b", branch, path, "HEAD")
	}
	if _, err := r.run(ctx, writeTimeout, args...); err != nil {
		return Worktree{}, err
	}
	r.exclude(ctx, rootDir)
	return Worktree{Name: name, Branch: branch}, nil
}

// exclude adds the worktrees folder to .git/info/exclude, once. Best effort.
func (r Repo) exclude(ctx context.Context, rootDir string) {
	out, err := r.run(ctx, readTimeout, "rev-parse", "--git-path", "info/exclude")
	rel := strings.TrimSpace(string(out))
	// An absolute path here is in git's own spelling (e.g. Linux inside WSL); leave it alone.
	if err != nil || rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return
	}
	file := filepath.Join(rootDir, filepath.FromSlash(rel))
	entry := "/" + WorktreesDir + "/"
	data, _ := os.ReadFile(file)
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == entry {
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString(entry + "\n")
}

// ErrNotRepo is returned when worktrees are asked of a folder outside git.
var ErrNotRepo = errors.New("not a git repository")

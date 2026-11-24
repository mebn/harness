package gitx

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
)

// Branch is a local branch.
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	// Worktree is the folder of another checkout that has this branch out; git won't switch
	// to it here while that lasts. "" when free (or checked out right here).
	Worktree  string `json:"worktree"`
	UpdatedAt int64  `json:"updatedAt"` // last commit, unix ms
}

// Branches lists local branches, the current one first, then the most recently committed.
func (r Repo) Branches(ctx context.Context) ([]Branch, error) {
	out, err := r.run(ctx, readTimeout, "for-each-ref",
		"--format=%(refname:short)%09%(HEAD)%09%(worktreepath)%09%(committerdate:unix)", "refs/heads")
	if err != nil {
		return nil, err
	}
	here, _ := r.run(ctx, readTimeout, "rev-parse", "--show-toplevel")
	return parseBranches(string(out), strings.TrimSpace(string(here))), nil
}

func parseBranches(out, here string) []Branch {
	list := []Branch{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 4 || f[0] == "" {
			continue
		}
		b := Branch{Name: f[0], Current: f[1] == "*"}
		if f[2] != "" && !b.Current && !samePath(f[2], here) {
			b.Worktree = f[2]
		}
		if t, err := strconv.ParseInt(f[3], 10, 64); err == nil {
			b.UpdatedAt = t * 1000
		}
		list = append(list, b)
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Current != list[j].Current {
			return list[i].Current
		}
		return list[i].UpdatedAt > list[j].UpdatedAt
	})
	return list
}

func samePath(a, b string) bool {
	norm := func(p string) string { return strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/") }
	return strings.EqualFold(norm(a), norm(b))
}

// validBranch is a conservative subset of git's ref name rules.
func validBranch(name string) bool {
	if name == "" || len(name) > 200 || strings.HasPrefix(name, "-") || strings.HasPrefix(name, "/") ||
		strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, ".") ||
		strings.Contains(name, "..") || strings.Contains(name, "//") || strings.Contains(name, "@{") {
		return false
	}
	for _, c := range name {
		if c <= ' ' || strings.ContainsRune("~^:?*[\\\x7f", c) {
			return false
		}
	}
	return true
}

// Switch checks out an existing local branch. Git refuses when local changes would be lost.
func (r Repo) Switch(ctx context.Context, name string) error {
	if !validBranch(name) {
		return errors.New("invalid branch name")
	}
	_, err := r.run(ctx, writeTimeout, "switch", name)
	return err
}

// CreateBranch makes a branch from the current commit and switches to it, keeping local changes.
func (r Repo) CreateBranch(ctx context.Context, name string) error {
	if !validBranch(name) {
		return errors.New("invalid branch name: no spaces, and none of ~ ^ : ? * [ \\")
	}
	_, err := r.run(ctx, writeTimeout, "switch", "-c", name)
	return err
}

// Package gitx reads working-tree changes and commits/pushes using the git CLI.
// The CLI (rather than a Go git library) matches the user's config, hooks and credentials.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"harness/internal/platform"
)

const (
	readTimeout  = 15 * time.Second
	writeTimeout = 2 * time.Minute
	maxDiffBytes = 512 * 1024
)

// File is one changed path in the working tree.
type File struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"` // "M" modified, "A" added, "D" deleted, "R" renamed, "?" untracked
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Binary  bool   `json:"binary"`
}

// Status summarizes the repository state.
type Status struct {
	IsRepo   bool   `json:"isRepo"`
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Files    []File `json:"files"`
}

// Repo runs git in a working directory, natively or inside WSL.
type Repo struct {
	Dir string
	Env platform.Env
}

func (r Repo) run(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := platform.DirectCommand(ctx, r.Env, r.Dir, "git", append([]string{"-c", "core.quotepath=off"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				return stdout.Bytes(), errors.New(msg)
			}
		}
		return stdout.Bytes(), err
	}
	return stdout.Bytes(), nil
}

func (r Repo) Status(ctx context.Context) (Status, error) {
	st := Status{Files: []File{}}
	out, err := r.run(ctx, readTimeout, "status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all")
	if err != nil {
		if strings.Contains(err.Error(), "not a git repository") {
			return st, nil
		}
		return st, err
	}
	st.IsRepo = true
	files := parseStatus(out, &st)

	// Git reports paths from the repo root; the workspace may be a subfolder of it.
	prefixOut, _ := r.run(ctx, readTimeout, "rev-parse", "--show-prefix")
	prefix := strings.TrimSpace(string(prefixOut))

	counts := r.numstat(ctx)
	kept := make([]File, 0, len(files))
	for _, f := range files {
		c, hasCount := counts[f.Path]
		if !strings.HasPrefix(f.Path, prefix) {
			continue // outside this workspace
		}
		f.Path = strings.TrimPrefix(f.Path, prefix)
		f.OldPath = strings.TrimPrefix(f.OldPath, prefix)
		if hasCount {
			f.Added, f.Removed, f.Binary = c.Added, c.Removed, c.Binary
		} else if f.Status == "?" {
			f.Added, f.Binary = r.countLines(f.Path)
		}
		kept = append(kept, f)
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Path < kept[j].Path })
	st.Files = kept
	return st, nil
}

// parseStatus parses `git status --porcelain=v1 --branch -z`.
func parseStatus(out []byte, st *Status) []File {
	entries := strings.Split(string(out), "\x00")
	files := []File{}
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if strings.HasPrefix(e, "## ") {
			parseBranch(e[3:], st)
			continue
		}
		if len(e) < 4 {
			continue
		}
		x, y, path := e[0], e[1], e[3:]
		f := File{Path: path, Status: statusLetter(x, y)}
		if x == 'R' || x == 'C' {
			i++ // the next entry is the original path
			if i < len(entries) {
				f.OldPath = entries[i]
			}
		}
		files = append(files, f)
	}
	return files
}

func statusLetter(x, y byte) string {
	switch {
	case x == '?' && y == '?':
		return "?"
	case x == 'R' || y == 'R':
		return "R"
	case x == 'A' || y == 'A':
		return "A"
	case x == 'D' || y == 'D':
		return "D"
	default:
		return "M"
	}
}

// parseBranch parses "main...origin/main [ahead 1, behind 2]" or "No commits yet on main".
func parseBranch(s string, st *Status) {
	if rest, ok := strings.CutPrefix(s, "No commits yet on "); ok {
		st.Branch = rest
		return
	}
	head, tracking, _ := strings.Cut(s, " [")
	st.Branch, st.Upstream, _ = strings.Cut(head, "...")
	for _, part := range strings.Split(strings.TrimSuffix(tracking, "]"), ", ") {
		if n, ok := strings.CutPrefix(part, "ahead "); ok {
			st.Ahead, _ = strconv.Atoi(n)
		}
		if n, ok := strings.CutPrefix(part, "behind "); ok {
			st.Behind, _ = strconv.Atoi(n)
		}
	}
}

type count struct {
	Added, Removed int
	Binary         bool
}

// numstat returns line counts of staged+unstaged changes against HEAD.
func (r Repo) numstat(ctx context.Context) map[string]count {
	counts := map[string]count{}
	out, err := r.run(ctx, readTimeout, "diff", "HEAD", "--numstat", "-z", "-M")
	if err != nil {
		// No commits yet: compare the index against the empty tree instead.
		out, _ = r.run(ctx, readTimeout, "diff", "--cached", "--numstat", "-z")
	}
	parseNumstat(out, counts)
	return counts
}

// parseNumstat parses `--numstat -z`; renames are "a\tr\t\0old\0new\0".
func parseNumstat(out []byte, counts map[string]count) {
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		fields := strings.SplitN(entries[i], "\t", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		if path == "" && i+2 < len(entries) {
			path = entries[i+2]
			i += 2
		}
		c := count{Binary: fields[0] == "-"}
		c.Added, _ = strconv.Atoi(fields[0])
		c.Removed, _ = strconv.Atoi(fields[1])
		counts[path] = c
	}
}

// countLines counts lines of an untracked file (read from the Windows-side path).
func (r Repo) countLines(rel string) (int, bool) {
	data, err := os.ReadFile(filepath.Join(r.Dir, filepath.FromSlash(rel)))
	if err != nil || len(data) > maxDiffBytes {
		return 0, false
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return 0, true
	}
	n := bytes.Count(data, []byte{'\n'})
	if len(data) > 0 && data[len(data)-1] != '\n' {
		n++
	}
	return n, false
}

// Diff returns a unified diff of one file against HEAD (untracked files show as all-added).
func (r Repo) Diff(ctx context.Context, f File) (string, error) {
	if f.Status == "?" {
		data, err := os.ReadFile(filepath.Join(r.Dir, filepath.FromSlash(f.Path)))
		if err != nil {
			return "", err
		}
		if len(data) > maxDiffBytes || bytes.IndexByte(data, 0) >= 0 {
			return "", errors.New("file too large or binary")
		}
		lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
		var sb strings.Builder
		fmt.Fprintf(&sb, "@@ -0,0 +1,%d @@\n", len(lines))
		for _, l := range lines {
			sb.WriteString("+" + l + "\n")
		}
		return sb.String(), nil
	}
	args := []string{"diff", "HEAD", "-M", "--"}
	if f.OldPath != "" {
		args = append(args, f.OldPath)
	}
	out, err := r.run(ctx, readTimeout, append(args, f.Path)...)
	if err != nil {
		out, err = r.run(ctx, readTimeout, "diff", "--cached", "--", f.Path)
	}
	if len(out) > maxDiffBytes {
		out = append(out[:maxDiffBytes], []byte("\n… (truncated)")...)
	}
	return string(out), err
}

// CommitAll stages every change and commits it.
func (r Repo) CommitAll(ctx context.Context, message string) error {
	if strings.TrimSpace(message) == "" {
		return errors.New("commit message is required")
	}
	if _, err := r.run(ctx, writeTimeout, "add", "-A"); err != nil {
		return err
	}
	_, err := r.run(ctx, writeTimeout, "commit", "-m", message)
	return err
}

// Push pushes the current branch, setting the upstream on first push.
func (r Repo) Push(ctx context.Context, hasUpstream bool) error {
	args := []string{"push"}
	if !hasUpstream {
		args = append(args, "-u", "origin", "HEAD")
	}
	_, err := r.run(ctx, writeTimeout, args...)
	return err
}

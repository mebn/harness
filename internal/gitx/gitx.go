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

// File is one changed path, either in the index (Staged) or in the working tree. A path
// with both staged and unstaged edits appears twice, once each way.
type File struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"` // "M" modified, "A" added, "D" deleted, "R" renamed, "?" untracked, "!" conflicted
	Staged  bool   `json:"staged"`
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

	staged, unstaged := r.numstat(ctx)
	kept := make([]File, 0, len(files))
	for _, f := range files {
		counts := unstaged
		if f.Staged {
			counts = staged
		}
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
	sort.SliceStable(kept,func(i, j int) bool { return kept[i].Path < kept[j].Path })
	st.Files = kept
	return st, nil
}

// parseStatus parses `git status --porcelain=v1 --branch -z`. X is the index column and
// Y the working tree, so "MM" yields a staged and an unstaged entry for the same path.
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
		oldPath := ""
		if x == 'R' || x == 'C' {
			i++ // the next entry is the original path
			if i < len(entries) {
				oldPath = entries[i]
			}
		}
		switch {
		case x == '?' && y == '?':
			files = append(files, File{Path: path, Status: "?"})
		case conflicted(x, y):
			files = append(files, File{Path: path, Status: "!"})
		default:
			if x != ' ' {
				f := File{Path: path, Status: statusLetter(x), Staged: true}
				if x == 'R' {
					f.OldPath = oldPath
				}
				files = append(files, f)
			}
			if y != ' ' {
				files = append(files, File{Path: path, Status: statusLetter(y)})
			}
		}
	}
	return files
}

func conflicted(x, y byte) bool {
	return x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D')
}

func statusLetter(c byte) string {
	switch c {
	case 'R':
		return "R"
	case 'A', 'C':
		return "A"
	case 'D':
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

// numstat returns line counts of staged changes (index vs HEAD) and unstaged ones
// (working tree vs index).
func (r Repo) numstat(ctx context.Context) (staged, unstaged map[string]count) {
	staged, unstaged = map[string]count{}, map[string]count{}
	out, _ := r.run(ctx, readTimeout, "diff", "--cached", "--numstat", "-z", "-M")
	parseNumstat(out, staged)
	out, _ = r.run(ctx, readTimeout, "diff", "--numstat", "-z")
	parseNumstat(out, unstaged)
	return staged, unstaged
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

// Diff returns a unified diff of one entry: staged ones against HEAD, unstaged ones against
// the index (untracked files show as all-added).
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
	args := []string{"diff"}
	if f.Staged {
		args = append(args, "--cached", "-M")
	}
	args = append(args, "--")
	if f.OldPath != "" {
		args = append(args, f.OldPath)
	}
	out, err := r.run(ctx, readTimeout, append(args, f.Path)...)
	if len(out) > maxDiffBytes {
		out = append(out[:maxDiffBytes], []byte("\n… (truncated)")...)
	}
	return string(out), err
}

// Commit commits what is staged; with nothing staged it stages every change first.
func (r Repo) Commit(ctx context.Context, message string) error {
	if strings.TrimSpace(message) == "" {
		return errors.New("commit message is required")
	}
	if _, err := r.run(ctx, readTimeout, "diff", "--cached", "--quiet"); err == nil {
		// Exit 0 means nothing is staged.
		if _, err := r.run(ctx, writeTimeout, "add", "-A"); err != nil {
			return err
		}
	}
	_, err := r.run(ctx, writeTimeout, "commit", "-m", message)
	return err
}

// pathspec ends a git command with paths, relative to Dir like the ones Status reports.
// No paths means every change under Dir.
func pathspec(paths []string) []string {
	if len(paths) == 0 {
		return []string{"--", "."}
	}
	return append([]string{"--"}, paths...)
}

// Stage adds paths (new, modified or deleted) to the index.
func (r Repo) Stage(ctx context.Context, paths []string) error {
	_, err := r.run(ctx, writeTimeout, append([]string{"add", "-A"}, pathspec(paths)...)...)
	return err
}

// Unstage moves staged changes of paths back to the working tree, keeping the edits.
func (r Repo) Unstage(ctx context.Context, paths []string) error {
	if _, err := r.run(ctx, readTimeout, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		// No commits yet: there is no HEAD to restore from, so drop paths from the index.
		_, err := r.run(ctx, writeTimeout, append([]string{"rm", "-r", "-q", "--cached", "--ignore-unmatch"}, pathspec(paths)...)...)
		return err
	}
	_, err := r.run(ctx, writeTimeout, append([]string{"restore", "--staged"}, pathspec(paths)...)...)
	return err
}

// Discard throws away unstaged changes: tracked files go back to their staged (or committed)
// content and untracked files are deleted. Staged changes are kept.
func (r Repo) Discard(ctx context.Context, files []File) error {
	var tracked, untracked []string
	for _, f := range files {
		switch {
		case f.Staged:
		case f.Status == "?":
			untracked = append(untracked, f.Path)
		default:
			tracked = append(tracked, f.Path)
		}
	}
	if len(tracked) > 0 {
		if _, err := r.run(ctx, writeTimeout, append([]string{"restore"}, pathspec(tracked)...)...); err != nil {
			return err
		}
	}
	if len(untracked) > 0 {
		if _, err := r.run(ctx, writeTimeout, append([]string{"clean", "-f", "-q"}, pathspec(untracked)...)...); err != nil {
			return err
		}
	}
	return nil
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

// Files lists the files under Dir that git knows about or would add (tracked plus untracked,
// minus ignored), relative to Dir with forward slashes.
func (r Repo) Files(ctx context.Context) ([]string, error) {
	out, err := r.run(ctx, readTimeout, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	files := []string{}
	for _, p := range strings.Split(string(out), "\x00") {
		// A file with unmerged stages is listed once per stage.
		if p != "" && !seen[p] {
			seen[p] = true
			files = append(files, p)
		}
	}
	return files, nil
}

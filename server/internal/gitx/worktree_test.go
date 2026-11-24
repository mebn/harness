package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"harness/server/internal/platform"
)

func TestParseWorktrees(t *testing.T) {
	out := "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\n" +
		"worktree C:/repo/.claude/worktrees/feat-a\nHEAD def\nbranch refs/heads/worktree-feat-a\n\n" +
		"worktree /home/me/repo/.claude/worktrees/b\nHEAD 123\ndetached\n\n" +
		"worktree C:/repo/.claude/worktrees/gone\nHEAD 456\nbranch refs/heads/worktree-gone\nprunable gitdir file points to non-existent location\n\n" +
		"worktree C:/elsewhere\nHEAD 789\nbranch refs/heads/x\n"
	got := parseWorktrees(out)
	if len(got) != 2 || got[0] != (Worktree{Name: "feat-a", Branch: "worktree-feat-a"}) || got[1] != (Worktree{Name: "b"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestAddWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	r := Repo{Dir: dir, Env: platform.EnvNative}
	ctx := context.Background()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.email", "t@example.com"}, {"config", "user.name", "t"}} {
		if _, err := r.run(ctx, readTimeout, args...); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	if err := r.Commit(ctx, "init"); err != nil {
		t.Fatal(err)
	}
	w, err := r.AddWorktree(ctx, dir, "feat")
	if err != nil || w.Branch != "worktree-feat" {
		t.Fatalf("add: %+v %v", w, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".claude", "worktrees", "feat", "a.txt")); err != nil {
		t.Fatal(err)
	}
	list, err := r.Worktrees(ctx)
	if err != nil || len(list) != 1 || list[0] != w {
		t.Fatalf("list: %+v %v", list, err)
	}
	// The worktree folder is excluded locally, so the main checkout stays clean.
	st, _ := r.Status(ctx)
	if len(st.Files) != 0 {
		t.Fatalf("main checkout lists: %+v", st.Files)
	}
}

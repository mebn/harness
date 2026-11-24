package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"harness/server/internal/platform"
)

func TestParseStatus(t *testing.T) {
	var st Status
	out := "## main...origin/main [ahead 2, behind 1]\x00 M a.go\x00R  new.go\x00old.go\x00?? x.txt\x00MD b.go\x00UU c.go\x00"
	files := parseStatus([]byte(out), &st)
	if st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 {
		t.Fatalf("branch: %+v", st)
	}
	want := []File{
		{Path: "a.go", Status: "M"},
		{Path: "new.go", OldPath: "old.go", Status: "R", Staged: true},
		{Path: "x.txt", Status: "?"},
		{Path: "b.go", Status: "M", Staged: true},
		{Path: "b.go", Status: "D"},
		{Path: "c.go", Status: "!"},
	}
	if len(files) != len(want) {
		t.Fatalf("files: %+v", files)
	}
	for i := range want {
		if files[i] != want[i] {
			t.Fatalf("file %d: got %+v want %+v", i, files[i], want[i])
		}
	}
}

func TestParseNumstat(t *testing.T) {
	c := map[string]count{}
	parseNumstat([]byte("3\t1\ta.go\x00-\t-\timg.png\x002\t0\t\x00old.go\x00new.go\x00"), c)
	if c["a.go"].Added != 3 || c["a.go"].Removed != 1 || !c["img.png"].Binary || c["new.go"].Added != 2 {
		t.Fatalf("counts: %+v", c)
	}
}

func TestRepoRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("config", "user.email", "t@example.com")
	git("config", "user.name", "t")
	write := func(name, s string) { os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644) }

	r := Repo{Dir: dir, Env: platform.EnvNative}
	ctx := context.Background()
	write("a.txt", "one\ntwo\n")
	st, err := r.Status(ctx)
	if err != nil || !st.IsRepo || len(st.Files) != 1 || st.Files[0].Status != "?" || st.Files[0].Added != 2 {
		t.Fatalf("untracked: %+v %v", st, err)
	}
	// Unstaging before the first commit has no HEAD to restore from.
	if err := r.Stage(ctx, []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Unstage(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if st, _ = r.Status(ctx); len(st.Files) != 1 || st.Files[0].Staged {
		t.Fatalf("unstaged before first commit: %+v", st.Files)
	}
	// Nothing staged: commit takes everything.
	if err := r.Commit(ctx, "init"); err != nil {
		t.Fatal(err)
	}
	write("a.txt", "one\nTWO\nthree\n")
	st, _ = r.Status(ctx)
	if len(st.Files) != 1 || st.Files[0].Added != 2 || st.Files[0].Removed != 1 {
		t.Fatalf("modified: %+v", st.Files)
	}
	diff, err := r.Diff(ctx, st.Files[0])
	if err != nil || diff == "" {
		t.Fatalf("diff: %q %v", diff, err)
	}

	// Stage the edit, edit again: one staged and one unstaged entry.
	if err := r.Stage(ctx, []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	write("a.txt", "one\nTWO\nthree\nfour\n")
	write("b.txt", "new\n")
	st, _ = r.Status(ctx)
	if len(st.Files) != 3 || !st.Files[0].Staged || st.Files[0].Added != 2 || st.Files[1].Staged || st.Files[1].Added != 1 {
		t.Fatalf("staged+unstaged: %+v", st.Files)
	}
	if diff, err := r.Diff(ctx, st.Files[0]); err != nil || !strings.Contains(diff, "+three") || strings.Contains(diff, "+four") {
		t.Fatalf("staged diff: %q %v", diff, err)
	}

	// Discard drops the unstaged edit and the untracked file, keeping what is staged.
	if err := r.Discard(ctx, st.Files); err != nil {
		t.Fatal(err)
	}
	st, _ = r.Status(ctx)
	if len(st.Files) != 1 || !st.Files[0].Staged {
		t.Fatalf("after discard: %+v", st.Files)
	}
	if _, err := os.Stat(filepath.Join(dir, "b.txt")); !os.IsNotExist(err) {
		t.Fatal("untracked file not deleted")
	}

	// Commit takes only what is staged.
	if err := r.Unstage(ctx, []string{"a.txt"}); err != nil {
		t.Fatal(err)
	}
	if st, _ = r.Status(ctx); len(st.Files) != 1 || st.Files[0].Staged {
		t.Fatalf("after unstage: %+v", st.Files)
	}
	write("c.txt", "c\n")
	if err := r.Stage(ctx, []string{"c.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Commit(ctx, "c"); err != nil {
		t.Fatal(err)
	}
	if st, _ = r.Status(ctx); len(st.Files) != 1 || st.Files[0].Path != "a.txt" {
		t.Fatalf("after partial commit: %+v", st.Files)
	}
}

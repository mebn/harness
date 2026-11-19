package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"harness/internal/platform"
)

func TestParseStatus(t *testing.T) {
	var st Status
	out := "## main...origin/main [ahead 2, behind 1]\x00 M a.go\x00R  new.go\x00old.go\x00?? x.txt\x00"
	files := parseStatus([]byte(out), &st)
	if st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 {
		t.Fatalf("branch: %+v", st)
	}
	if len(files) != 3 || files[1].Status != "R" || files[1].OldPath != "old.go" || files[2].Status != "?" {
		t.Fatalf("files: %+v", files)
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
	if err := r.CommitAll(ctx, "init"); err != nil {
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
}

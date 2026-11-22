package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"harness/internal/platform"
)

func TestParseBranches(t *testing.T) {
	out := "main\t \t/repo\t100\nfeat\t*\t/repo/wt\t50\nold\t \t\t10\nnew\t \t\t200\nbusy\t \t/repo/.claude/worktrees/x\t300\n"
	got := parseBranches(out, "/repo/wt")
	names := []string{}
	for _, b := range got {
		names = append(names, b.Name)
	}
	if len(got) != 5 || got[0].Name != "feat" || !got[0].Current || got[0].Worktree != "" {
		t.Fatalf("current first: %+v", got)
	}
	if want := []string{"feat", "busy", "new", "main", "old"}; !equal(names, want) {
		t.Fatalf("order %v, want %v", names, want)
	}
	if got[1].Worktree != "/repo/.claude/worktrees/x" || got[3].Worktree != "/repo" {
		t.Fatalf("worktrees: %+v", got)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestValidBranch(t *testing.T) {
	for _, ok := range []string{"main", "feat/login", "fix-1.2", "user/x_y"} {
		if !validBranch(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "-x", "a b", "a..b", "a~1", "x.lock", "a:b", "/a", "a/", "a@{1}"} {
		if validBranch(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestSwitchAndCreateBranch(t *testing.T) {
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
	if err := r.CommitAll(ctx, "init"); err != nil {
		t.Fatal(err)
	}
	if err := r.CreateBranch(ctx, "feat/x"); err != nil {
		t.Fatal(err)
	}
	list, err := r.Branches(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "feat/x" || !list[0].Current {
		t.Fatalf("after create: %+v %v", list, err)
	}
	if err := r.Switch(ctx, "main"); err != nil {
		t.Fatal(err)
	}
	if list, _ := r.Branches(ctx); !list[0].Current || list[0].Name != "main" {
		t.Fatalf("after switch: %+v", list)
	}
}

package services

import (
	"encoding/base64"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"harness/internal/platform"
	"harness/internal/store"
)

func TestTerminalEcho(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var mu sync.Mutex
	var out strings.Builder
	emit := func(name string, data any) {
		if d, ok := data.(TermData); ok {
			b, _ := base64.StdEncoding.DecodeString(d.Data)
			mu.Lock()
			out.Write(b)
			mu.Unlock()
		}
	}
	svc := NewTerminalService(db, emit)
	defer svc.ServiceShutdown()

	id, err := svc.Start("", "", false, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Write(id, "echo harness-term-ok\r"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		// The echoed command plus its output means the marker appears twice.
		done := strings.Count(out.String(), "harness-term-ok") >= 2
		mu.Unlock()
		if done {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no echo output; got %q", out.String())
}

// A workspace stored inside WSL must get a Linux shell; a Windows folder a native one.
func TestTerminalFollowsWorkspaceEnv(t *testing.T) {
	if !platform.HasWSL() {
		t.Skip("WSL not available")
	}
	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	distro := firstDistro(t)
	wsl := store.Project{ID: "wsl", Name: "w", Path: `\\wsl.localhost\` + distro + `\tmp`, Env: "wsl"}
	win := store.Project{ID: "win", Name: "n", Path: t.TempDir(), Env: "native"}
	db.InsertProject(&wsl)
	db.InsertProject(&win)

	run := func(projectID, cmd string) string {
		var mu sync.Mutex
		var out strings.Builder
		svc := NewTerminalService(db, func(_ string, data any) {
			if d, ok := data.(TermData); ok {
				b, _ := base64.StdEncoding.DecodeString(d.Data)
				mu.Lock()
				out.Write(b)
				mu.Unlock()
			}
		})
		defer svc.ServiceShutdown()
		id, err := svc.Start(projectID, "", false, 120, 30)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Second) // let the shell print its prompt
		svc.Write(id, cmd+"\r")
		time.Sleep(3 * time.Second)
		mu.Lock()
		defer mu.Unlock()
		return out.String()
	}

	if got := run("wsl", "echo env=$(uname -s)"); !strings.Contains(got, "env=Linux") {
		t.Errorf("WSL workspace did not get a Linux shell: %q", got)
	}
	if got := run("win", "echo env=$env:OS"); !strings.Contains(got, "env=Windows_NT") {
		t.Errorf("Windows workspace did not get a Windows shell: %q", got)
	}
}

func firstDistro(t *testing.T) string {
	out, err := exec.Command("wsl.exe", "--list", "--quiet").Output()
	if err != nil {
		t.Skip("cannot list distros")
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(out), "\x00", ""), "\n") {
		if name := strings.TrimSpace(line); name != "" && !strings.HasPrefix(name, "docker-desktop") {
			return name
		}
	}
	t.Skip("no usable distro")
	return ""
}

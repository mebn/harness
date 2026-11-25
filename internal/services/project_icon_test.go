package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindIcon(t *testing.T) {
	dir := t.TempDir()
	if got := findIcon(dir); got != "" {
		t.Fatalf("empty folder: got %q", got)
	}

	write := func(rel string, size int) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("public/favicon.ico", 10)
	if got := findIcon(dir); !strings.HasPrefix(got, "data:image/x-icon;base64,") {
		t.Fatalf("favicon: got %q", got)
	}

	// An app icon wins over a favicon; one too large is skipped.
	write("build/appicon.png", maxIconBytes+1)
	if got := findIcon(dir); !strings.HasPrefix(got, "data:image/x-icon;") {
		t.Fatalf("oversized app icon should be skipped: got %.40q", got)
	}
	write("build/appicon.png", 20)
	if got := findIcon(dir); !strings.HasPrefix(got, "data:image/png;") {
		t.Fatalf("app icon: got %.40q", got)
	}

	// An empty favicon is passed over for an icon found deeper in the folder.
	other := t.TempDir()
	write2 := func(rel string, size int) {
		path := filepath.Join(other, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write2("frontend/public/favicon.ico", 0)
	write2("storage/uploads/some-logo.png", 10)
	write2("frontend/public/images/Logotype.svg", 10)
	write2("frontend/public/images/favicon.png", 10)
	got := findIcon(other)
	if !strings.HasPrefix(got, "data:image/png;") {
		t.Fatalf("searched icon: got %.40q", got)
	}
}

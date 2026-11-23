package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSearchFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.go")
	os.WriteFile(path, []byte("package main\n\tfunc Héllo() {}\n// Hello\nvar hello = 1\r\n"), 0o644)

	re, _ := searchPattern("hello", SearchOptions{})
	got := searchFile(path, re)
	if len(got) != 2 || got[0].Line != 3 || got[1].Line != 4 {
		t.Fatalf("case-insensitive: %+v", got)
	}
	// Leading whitespace is trimmed; offsets count UTF-16 units.
	if got[1].Text != "var hello = 1" || got[1].Start != 4 || got[1].End != 9 {
		t.Fatalf("offsets: %+v", got[1])
	}

	re, _ = searchPattern("Héllo", SearchOptions{CaseSensitive: true, WholeWord: true})
	if got := searchFile(path, re); len(got) != 1 || got[0].Text != "func Héllo() {}" || got[0].Start != 5 || got[0].End != 10 {
		t.Fatalf("whole word: %+v", got)
	}

	if _, err := searchPattern("(", SearchOptions{Regex: true}); err == nil {
		t.Fatal("bad regex accepted")
	}

	os.WriteFile(path, []byte("hello\x00"), 0o644)
	re, _ = searchPattern("hello", SearchOptions{})
	if got := searchFile(path, re); len(got) != 0 {
		t.Fatalf("binary searched: %+v", got)
	}
}

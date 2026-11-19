package services

import (
	"encoding/base64"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

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

	id, err := svc.Start("", 80, 24)
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

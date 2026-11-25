package provider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestCodexEndToEnd runs the Codex app server: a permission prompt, an allowed file write,
// and resuming the conversation in a new process. Run with HARNESS_E2E=1 (uses a cheap model).
func TestCodexEndToEnd(t *testing.T) {
	if os.Getenv("HARNESS_E2E") == "" {
		t.Skip("set HARNESS_E2E=1 to run against the real Codex CLI")
	}
	dir := t.TempDir()
	prov := NewCodex(t.TempDir())
	id := uuid.NewString()
	settings := Settings{Model: "gpt-5.6-luna", Effort: "low", Mode: ModeAsk}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	conn, err := prov.Open(ctx, OpenRequest{Dir: dir, SessionID: id, Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Send(Input{ID: uuid.NewString(), Prompt: "Create a file named note.txt containing exactly: ok. Use apply_patch. Reply with one word."}); err != nil {
		t.Fatal(err)
	}
	asked := false
	for e := range conn.Events() {
		switch e.Kind {
		case EventPermission:
			asked = true
			t.Logf("asked: %s %s", e.Permission.ToolName, e.Permission.Input)
			if err := conn.Respond(e.Permission.RequestID, map[string]any{"behavior": "allow"}); err != nil {
				t.Fatal(err)
			}
		case EventError:
			t.Fatalf("error: %s", e.Text)
		}
		if e.Kind == EventTurnEnd {
			break
		}
	}
	closeAndWait(conn)
	if !asked {
		t.Fatal("codex never asked for permission")
	}
	b, err := os.ReadFile(filepath.Join(dir, "note.txt"))
	if err != nil || !strings.Contains(string(b), "ok") {
		t.Fatalf("note.txt: %q %v", b, err)
	}

	// A new process picks the conversation up again.
	conn, err = prov.Open(ctx, OpenRequest{Dir: dir, SessionID: id, Settings: settings, Resume: true})
	if err != nil {
		t.Fatal(err)
	}
	defer closeAndWait(conn)
	if err := conn.Send(Input{ID: uuid.NewString(), Prompt: "What was the name of the file you created? Answer with the file name only."}); err != nil {
		t.Fatal(err)
	}
	var reply strings.Builder
	for e := range conn.Events() {
		if e.Kind == EventError {
			t.Fatalf("error: %s", e.Text)
		}
		if e.Kind == EventText {
			reply.WriteString(e.Text)
		}
		if e.Kind == EventTurnEnd {
			break
		}
	}
	if !strings.Contains(reply.String(), "note.txt") {
		t.Fatalf("resumed reply: %q", reply.String())
	}
}

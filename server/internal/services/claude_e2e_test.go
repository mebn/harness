package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"harness/server/internal/attach"
	"harness/server/internal/provider"
	"harness/server/internal/store"
)

// End-to-end against the real Claude Code CLI. Run with HARNESS_E2E=1 (uses Haiku).
func TestClaudeEndToEnd(t *testing.T) {
	if os.Getenv("HARNESS_E2E") == "" {
		t.Skip("set HARNESS_E2E=1 to run against the claude CLI")
	}
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	proj := store.Project{ID: "p", Name: "p", Path: dir}
	_ = db.InsertProject(&proj)
	sess := store.Session{ID: "s", ProjectID: "p", Title: "New session", Provider: "claude", Model: "claude-haiku-5-5",
		Effort: "low", Mode: provider.ModeAsk, ProviderSessionID: uuid.NewString()}
	_ = db.InsertSession(&sess)
	emit := func(string, any) {}
	c := NewChatService(db, provider.NewRegistry(provider.Claude{}), NewUsageService(db, emit), attach.Store{Dir: t.TempDir()}, emit)
	defer c.ServiceShutdown()

	wait := func(what string, d time.Duration, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(d)
		for !ok() {
			if time.Now().After(deadline) {
				msgs, _ := db.Messages("s")
				t.Fatalf("timed out waiting for %s; messages: %+v", what, msgs)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	idle := func() bool { return len(c.Running()) == 0 }
	pending := func() []PendingRequest {
		for _, p := range c.Pending() {
			return p.Items
		}
		return nil
	}

	// 1. Ask mode: a write needs permission.
	if _, err := c.Send("s", "Use the Write tool to create a.txt containing exactly: hello. Then reply with just: done", nil); err != nil {
		t.Fatal(err)
	}
	wait("permission prompt", 90*time.Second, func() bool { return len(pending()) > 0 })
	p := pending()[0]
	if p.ToolName != "Write" {
		t.Fatalf("asked for %s", p.ToolName)
	}
	if err := c.Respond("s", p.ID, PermissionAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	wait("turn end", 90*time.Second, idle)
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); !strings.Contains(string(b), "hello") {
		t.Fatalf("a.txt: %q", b)
	}
	msgs, _ := db.Messages("s")
	first := msgs[0]
	if first.CLIUUID == "" {
		t.Fatalf("first message has no CLI id: %+v", first)
	}

	// 2. Slash commands are listed.
	cmds, err := c.Commands("s")
	if err != nil || len(cmds) == 0 {
		t.Fatalf("commands: %d, %v", len(cmds), err)
	}

	// 3. A background task that ends after the turn starts a turn on its own.
	s, _ := db.Session("s")
	s.Mode = provider.ModeFull
	_ = db.UpdateSession(&s)
	c.settingsChanged(s)
	if _, err := c.Send("s", "Run `sleep 6; echo finished` with the Bash tool with run_in_background set to true, then reply 'started' and end your turn. When you are notified that it completed, reply 'bg done'.", nil); err != nil {
		t.Fatal(err)
	}
	wait("turn end", 90*time.Second, idle)
	wait("background turn", 90*time.Second, func() bool {
		msgs, _ := db.Messages("s")
		last := msgs[len(msgs)-1]
		return idle() && last.Role == "assistant" && strings.Contains(strings.ToLower(messageAllText(last)), "bg done")
	})

	all, _ := db.Messages("s")
	for _, m := range all {
		var parts []string
		for _, p := range m.Parts {
			parts = append(parts, p.Type+":"+p.ToolName+":"+strings.ReplaceAll(firstN(p.Text+p.ToolInput, 70), "\n", " "))
		}
		t.Logf("%s %s cli=%v %v", m.Role, time.UnixMilli(m.CreatedAt).Format("15:04:05.000"), m.CLIUUID != "", parts)
	}

	// 4. Rewind code and conversation to before the first message.
	res, err := c.Rewind("s", first.ID, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); !os.IsNotExist(err) || len(res.FilesChanged) == 0 {
		t.Fatalf("a.txt still there (%v), files %v", err, res.FilesChanged)
	}
	if msgs, _ := db.Messages("s"); len(msgs) != 0 {
		t.Fatalf("%d messages left", len(msgs))
	}
}

func messageAllText(m store.Message) string {
	var sb strings.Builder
	for _, p := range m.Parts {
		sb.WriteString(p.Text)
	}
	return sb.String()
}

func firstN(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

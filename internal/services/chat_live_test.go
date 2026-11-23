package services

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"

	"harness/internal/attach"
	"harness/internal/provider"
	"harness/internal/store"
)

// liveProvider hands out scriptConns the test drives by pushing events.
type liveProvider struct {
	mu    sync.Mutex
	conns []*scriptConn
	opens []provider.OpenRequest
}

func (p *liveProvider) Info() provider.Info {
	return provider.Info{ID: "live", Name: "Live", Steer: true, Interactive: true}
}

func (p *liveProvider) Open(_ context.Context, req provider.OpenRequest) (provider.Conn, error) {
	c := &scriptConn{events: make(chan provider.Event, 64)}
	p.mu.Lock()
	p.conns = append(p.conns, c)
	p.opens = append(p.opens, req)
	p.mu.Unlock()
	return c, nil
}

func (p *liveProvider) conn() *scriptConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conns[len(p.conns)-1]
}

type scriptConn struct {
	events chan provider.Event
	mu     sync.Mutex
	sent   []provider.Input
	resp   []map[string]any
	closed bool
}

func (c *scriptConn) Events() <-chan provider.Event { return c.events }
func (c *scriptConn) Send(in provider.Input) error {
	c.mu.Lock()
	c.sent = append(c.sent, in)
	c.mu.Unlock()
	return nil
}
func (c *scriptConn) Apply(provider.Settings) error { return nil }
func (c *scriptConn) Interrupt() error {
	c.events <- provider.Event{Kind: provider.EventTurnEnd}
	return nil
}
func (c *scriptConn) Respond(_ string, r map[string]any) error {
	c.mu.Lock()
	c.resp = append(c.resp, r)
	c.mu.Unlock()
	return nil
}
func (c *scriptConn) Control(context.Context, string, map[string]any) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}
func (c *scriptConn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.events)
	}
}
func (c *scriptConn) inputs() []provider.Input {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]provider.Input(nil), c.sent...)
}
func (c *scriptConn) responses() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]any(nil), c.resp...)
}

func newLiveTest(t *testing.T) (*ChatService, *liveProvider, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	proj := store.Project{ID: "p", Name: "p", Path: dir}
	if err := db.InsertProject(&proj); err != nil {
		t.Fatal(err)
	}
	sess := store.Session{ID: "s", ProjectID: "p", Title: "New session", Provider: "live", ProviderSessionID: "conv-1", Mode: "ask"}
	if err := db.InsertSession(&sess); err != nil {
		t.Fatal(err)
	}
	p := &liveProvider{}
	emit := func(string, any) {}
	c := NewChatService(db, provider.NewRegistry(p), NewUsageService(db, emit), attach.Store{Dir: filepath.Join(dir, "files")}, emit)
	t.Cleanup(func() { _ = c.ServiceShutdown() })
	return c, p, sess.ID
}

// turn sends a message and plays a reply that ends the turn.
func liveTurn(t *testing.T, c *ChatService, p *liveProvider, id, prompt, prev, last string) string {
	t.Helper()
	if _, err := c.Send(id, prompt, nil); err != nil {
		t.Fatal(err)
	}
	conn := p.conn()
	waitFor(t, "input", func() bool { return len(conn.inputs()) > 0 })
	in := conn.inputs()[len(conn.inputs())-1]
	conn.events <- provider.Event{Kind: provider.EventInputTaken, InputID: in.ID, PrevUUID: prev}
	conn.events <- provider.Event{Kind: provider.EventText, Text: "reply to " + prompt}
	conn.events <- provider.Event{Kind: provider.EventTurnEnd, LastUUID: last}
	waitFor(t, "turn end", func() bool { return len(c.Running()) == 0 })
	return in.ID
}

func TestPermissionRoundTrip(t *testing.T) {
	c, p, id := newLiveTest(t)
	if _, err := c.Send(id, "run tests", nil); err != nil {
		t.Fatal(err)
	}
	conn := p.conn()
	conn.events <- provider.Event{Kind: provider.EventPermission, Permission: &provider.Permission{
		RequestID: "r1", ToolName: "Bash", ToolID: "t1", Input: `{"command":"npm test"}`,
		Suggestions: json.RawMessage(`[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"localSettings"}]`),
		CanAlways:   true,
	}}
	waitFor(t, "pending", func() bool { return len(c.Pending()) == 1 })
	if err := c.Respond(id, "r1", PermissionAnswer{Allow: true, Always: true}); err != nil {
		t.Fatal(err)
	}
	r := conn.responses()
	if len(r) != 1 || r[0]["behavior"] != "allow" || r[0]["updatedPermissions"] == nil {
		t.Fatalf("responses: %+v", r)
	}
	if input := r[0]["updatedInput"].(map[string]any); input["command"] != "npm test" {
		t.Fatalf("input: %+v", input)
	}
	if len(c.Pending()) != 0 {
		t.Fatal("request still pending")
	}
	if err := c.Respond(id, "r1", PermissionAnswer{}); err == nil {
		t.Fatal("answered twice")
	}
}

func TestPlanApprovalSwitchesMode(t *testing.T) {
	c, p, id := newLiveTest(t)
	_, _ = c.Send(id, "plan it", nil)
	conn := p.conn()
	conn.events <- provider.Event{Kind: provider.EventPermission, Permission: &provider.Permission{
		RequestID: "r1", ToolName: "ExitPlanMode", Input: `{"plan":"do it"}`}}
	conn.events <- provider.Event{Kind: provider.EventPermission, Permission: &provider.Permission{
		RequestID: "r2", ToolName: "AskUserQuestion", Input: `{"questions":[]}`}}
	waitFor(t, "pending", func() bool { return len(c.Pending()) == 1 && len(c.Pending()[0].Items) == 2 })
	_ = c.Respond(id, "r2", PermissionAnswer{Allow: true, Answers: map[string]string{"Which?": "A"}})
	_ = c.Respond(id, "r1", PermissionAnswer{Allow: true, Mode: "edits"})
	r := conn.responses()
	if answers := r[0]["updatedInput"].(map[string]any)["answers"].(map[string]string); answers["Which?"] != "A" {
		t.Fatalf("answers: %+v", r[0])
	}
	updates, _ := r[1]["updatedPermissions"].([]any)
	if len(updates) != 1 || updates[0].(map[string]any)["mode"] != "acceptEdits" {
		t.Fatalf("plan response: %+v", r[1])
	}
	if s, _ := c.store.Session(id); s.Mode != "edits" {
		t.Fatalf("mode %q", s.Mode)
	}
}

func TestAgentStartsTurnOnItsOwn(t *testing.T) {
	c, p, id := newLiveTest(t)
	liveTurn(t, c, p, id, "start a background job", "", "a1")
	conn := p.conn()
	conn.events <- provider.Event{Kind: provider.EventTasks, Tasks: []provider.Task{{ID: "b1", Description: "sleep"}}}
	waitFor(t, "tasks", func() bool { return len(c.Tasks()) == 1 })
	// The task ends after the turn: the agent picks it up by itself.
	conn.events <- provider.Event{Kind: provider.EventTaskDone, Task: &provider.Task{ID: "b1", Status: "completed"}}
	conn.events <- provider.Event{Kind: provider.EventTasks, Tasks: []provider.Task{}}
	conn.events <- provider.Event{Kind: provider.EventText, Text: "the job is done"}
	waitFor(t, "running", func() bool { return len(c.Running()) == 1 })
	conn.events <- provider.Event{Kind: provider.EventTurnEnd, LastUUID: "a2"}
	waitFor(t, "idle", func() bool { return len(c.Running()) == 0 })

	msgs, _ := c.store.Messages(id)
	roles := ""
	for _, m := range msgs {
		roles += m.Role[:1]
	}
	if roles != "uaea" || msgs[2].Parts[0].Text != "sleep · finished" || msgs[3].Parts[0].Text != "the job is done" {
		t.Fatalf("messages %q: %+v", roles, msgs)
	}
	if s, _ := c.store.Session(id); s.LastUUID != "a2" || !s.Started {
		t.Fatalf("session: %+v", s)
	}
}

func TestRewindCutsConversation(t *testing.T) {
	c, p, id := newLiveTest(t)
	first := liveTurn(t, c, p, id, "one", "", "a1")
	second := liveTurn(t, c, p, id, "two", "a1", "a2")

	if m, _ := c.store.Message(second); m.CLIUUID != second || m.PrevUUID != "a1" {
		t.Fatalf("message ids: %+v", m)
	}
	res, err := c.Rewind(id, second, true, false)
	if err != nil || res.Text != "two" {
		t.Fatalf("rewind: %+v %v", res, err)
	}
	s, _ := c.store.Session(id)
	if s.ForkFrom != "conv-1" || s.ResumeAt != "a1" || s.Started || s.ProviderSessionID == "conv-1" {
		t.Fatalf("session after rewind: %+v", s)
	}
	if msgs, _ := c.store.Messages(id); len(msgs) != 2 {
		t.Fatalf("messages after rewind: %d", len(msgs))
	}
	// The next message forks the conversation at the cut.
	liveTurn(t, c, p, id, "two again", "a1", "a3")
	p.mu.Lock()
	open := p.opens[len(p.opens)-1]
	p.mu.Unlock()
	if open.ForkFrom != "conv-1" || open.ResumeAt != "a1" || open.SessionID != s.ProviderSessionID {
		t.Fatalf("open: %+v", open)
	}
	if s, _ := c.store.Session(id); s.ForkFrom != "" || !s.Started {
		t.Fatalf("session after fork ran: %+v", s)
	}

	// Rewinding to the first message starts the conversation over.
	if _, err := c.Rewind(id, first, true, false); err != nil {
		t.Fatal(err)
	}
	if s, _ := c.store.Session(id); s.ForkFrom != "" || s.Started {
		t.Fatalf("session after full rewind: %+v", s)
	}
}

func TestForkCopiesEarlierMessages(t *testing.T) {
	c, p, id := newLiveTest(t)
	liveTurn(t, c, p, id, "one", "", "a1")
	second := liveTurn(t, c, p, id, "two", "a1", "a2")
	res, err := c.Fork(id, second)
	if err != nil || res.Text != "two" {
		t.Fatal(res, err)
	}
	msgs, _ := c.store.Messages(res.Session.ID)
	if len(msgs) != 2 || res.Session.ForkFrom != "conv-1" || res.Session.ResumeAt != "a1" {
		t.Fatalf("fork: %+v, %d messages", res.Session, len(msgs))
	}
	if orig, _ := c.store.Messages(id); len(orig) != 4 {
		t.Fatal("original chat changed")
	}
}

func TestClearStartsFresh(t *testing.T) {
	c, p, id := newLiveTest(t)
	liveTurn(t, c, p, id, "one", "", "a1")
	if _, err := c.Send(id, "/clear", nil); err != nil {
		t.Fatal(err)
	}
	s, _ := c.store.Session(id)
	if s.ProviderSessionID == "conv-1" || s.Started {
		t.Fatalf("session: %+v", s)
	}
	liveTurn(t, c, p, id, "two", "", "b1")
	p.mu.Lock()
	n, last := len(p.opens), p.opens[len(p.opens)-1]
	p.mu.Unlock()
	if n != 2 || last.Resume || last.SessionID != s.ProviderSessionID {
		t.Fatalf("opens %d, last %+v", n, last)
	}
}

func TestSteeredMessageJoinsTurn(t *testing.T) {
	c, p, id := newLiveTest(t)
	_, _ = c.Send(id, "one", nil)
	conn := p.conn()
	waitFor(t, "input", func() bool { return len(conn.inputs()) == 1 })
	conn.events <- provider.Event{Kind: provider.EventInputTaken, InputID: conn.inputs()[0].ID}
	q, _ := c.Send(id, "also this", nil)
	if err := c.Steer(id, q); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "steered", func() bool { return len(conn.inputs()) == 2 })
	conn.events <- provider.Event{Kind: provider.EventText, Text: "first"}
	conn.events <- provider.Event{Kind: provider.EventInputTaken, InputID: q, PrevUUID: "x"}
	conn.events <- provider.Event{Kind: provider.EventText, Text: "second"}
	conn.events <- provider.Event{Kind: provider.EventTurnEnd}
	waitFor(t, "idle", func() bool { return len(c.Running()) == 0 })
	msgs, _ := c.store.Messages(id)
	if len(msgs) != 4 || msgs[2].ID != q || msgs[2].CLIUUID != q || msgs[3].Parts[0].Text != "second" {
		t.Fatalf("messages: %+v", msgs)
	}
}

package services

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"harness/internal/attach"
	"harness/internal/provider"
	"harness/internal/store"
)

// fakeProvider runs turns that last until the test ends them, recording each prompt.
type fakeProvider struct {
	mu      sync.Mutex
	prompts []string
	finish  chan struct{} // one receive ends the current turn
}

func (f *fakeProvider) Info() provider.Info { return provider.Info{ID: "fake", Name: "Fake"} }

func (f *fakeProvider) Open(ctx context.Context, req provider.OpenRequest) (provider.Conn, error) {
	return provider.OpenPerTurn(ctx, req, f.run), nil
}

func (f *fakeProvider) run(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	f.mu.Lock()
	f.prompts = append(f.prompts, req.Prompt)
	f.mu.Unlock()
	ch := make(chan provider.Event)
	go func() {
		defer close(ch)
		select {
		case <-f.finish:
			ch <- provider.Event{Kind: provider.EventText, Text: "ok"}
		case <-ctx.Done():
		}
	}()
	return ch, nil
}

func (f *fakeProvider) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.prompts...)
}

func newChatTest(t *testing.T) (*ChatService, *fakeProvider, string) {
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
	sess := store.Session{ID: "s", ProjectID: "p", Title: "New session", Provider: "fake", ProviderSessionID: "x"}
	if err := db.InsertSession(&sess); err != nil {
		t.Fatal(err)
	}
	fake := &fakeProvider{finish: make(chan struct{})}
	emit := func(string, any) {}
	c := NewChatService(db, provider.NewRegistry(fake), NewUsageService(db, emit), attach.Store{Dir: filepath.Join(dir, "files")}, emit)
	t.Cleanup(func() { _ = c.ServiceShutdown() })
	return c, fake, sess.ID
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (c *ChatService) queueLen(id string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queues[id])
}

func TestQueueRunsAfterTurn(t *testing.T) {
	c, fake, id := newChatTest(t)
	if q, err := c.Send(id, "one", nil); err != nil || q != "" {
		t.Fatalf("first send: %q %v", q, err)
	}
	q2, _ := c.Send(id, "two", nil)
	q3, _ := c.Send(id, "three", nil)
	if q2 == "" || q3 == "" || c.queueLen(id) != 2 {
		t.Fatal("messages sent while busy were not queued")
	}
	if err := c.RemoveQueued(id, q3); err != nil {
		t.Fatal(err)
	}
	fake.finish <- struct{}{}
	waitFor(t, "queued turn", func() bool { return len(fake.seen()) == 2 })
	if got := fake.seen(); got[1] != "two" || c.queueLen(id) != 0 {
		t.Fatalf("prompts %v, queue %d", got, c.queueLen(id))
	}
}

func TestStopKeepsQueue(t *testing.T) {
	c, fake, id := newChatTest(t)
	_, _ = c.Send(id, "one", nil)
	_, _ = c.Send(id, "two", nil)
	c.Stop(id)
	waitFor(t, "stop", func() bool { return len(c.Running()) == 0 })
	time.Sleep(50 * time.Millisecond)
	if len(fake.seen()) != 1 || c.queueLen(id) != 1 {
		t.Fatalf("prompts %v, queue %d", fake.seen(), c.queueLen(id))
	}
}

func TestSteerWithoutSteeringInterrupts(t *testing.T) {
	c, fake, id := newChatTest(t)
	_, _ = c.Send(id, "one", nil)
	_, _ = c.Send(id, "two", nil)
	q3, _ := c.Send(id, "three", nil)
	if err := c.Steer(id, q3); err != nil {
		t.Fatal(err)
	}
	// The fake can't take input mid-turn: the turn stops and the steered message goes next.
	waitFor(t, "steered turn", func() bool { return len(fake.seen()) == 2 })
	if got := fake.seen(); got[1] != "three" || c.queueLen(id) != 1 {
		t.Fatalf("prompts %v, queue %d", got, c.queueLen(id))
	}
}

func TestSteerWhenIdleSendsNow(t *testing.T) {
	c, fake, id := newChatTest(t)
	_, _ = c.Send(id, "one", nil)
	q2, _ := c.Send(id, "two", nil)
	c.Stop(id)
	waitFor(t, "stop", func() bool { return len(c.Running()) == 0 })
	if err := c.Steer(id, q2); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "sent turn", func() bool { return len(fake.seen()) == 2 })
}

func TestModelSwitchDivider(t *testing.T) {
	c, fake, id := newChatTest(t)
	setModel := func(m string) {
		s, _ := c.store.Session(id)
		s.Model = m
		_ = c.store.UpdateSession(&s)
	}
	turn := func(prompt string) {
		n := len(fake.seen())
		if _, err := c.Send(id, prompt, nil); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "turn start", func() bool { return len(fake.seen()) == n+1 })
		fake.finish <- struct{}{}
		waitFor(t, "turn end", func() bool { return len(c.Running()) == 0 })
	}
	setModel("opus")
	turn("one")
	turn("two") // same model: no divider
	setModel("sonnet")
	turn("three")

	msgs, _ := c.store.Messages(id)
	var events []string
	for _, m := range msgs {
		if m.Role == "event" {
			events = append(events, m.Parts[0].Text)
		}
	}
	if len(events) != 1 || events[0] != "opus → sonnet" {
		t.Fatalf("dividers: %v", events)
	}
}

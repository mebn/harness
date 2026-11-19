package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"harness/internal/platform"
	"harness/internal/provider"
	"harness/internal/store"
)

const flushInterval = 60 * time.Millisecond

// ChatService runs agent turns and streams the transcript to the frontend.
type ChatService struct {
	store     *store.Store
	providers *provider.Registry
	emit      Emitter

	mu   sync.Mutex
	runs map[string]context.CancelFunc // sessionID -> cancel
}

func NewChatService(s *store.Store, r *provider.Registry, emit Emitter) *ChatService {
	return &ChatService{store: s, providers: r, emit: emit, runs: map[string]context.CancelFunc{}}
}

func (c *ChatService) Providers() []provider.Info { return c.providers.Infos() }

func (c *ChatService) Messages(sessionID string) ([]store.Message, error) {
	return c.store.Messages(sessionID)
}

// SearchMessages finds message text matching query across all sessions.
func (c *ChatService) SearchMessages(query string) ([]store.MessageHit, error) {
	return c.store.SearchMessages(query, 30)
}

// Running returns the ids of sessions with an active turn.
func (c *ChatService) Running() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	ids := make([]string, 0, len(c.runs))
	for id := range c.runs {
		ids = append(ids, id)
	}
	return ids
}

func (c *ChatService) Stop(sessionID string) {
	c.mu.Lock()
	cancel := c.runs[sessionID]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// ServiceShutdown is a Wails lifecycle hook: stop running agents on exit.
func (c *ChatService) ServiceShutdown() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, cancel := range c.runs {
		cancel()
	}
	return nil
}

// Send starts a turn with the session's current provider settings.
func (c *ChatService) Send(sessionID, prompt string) error {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return errors.New("empty prompt")
	}
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return err
	}
	proj, err := c.store.Project(sess.ProjectID)
	if err != nil {
		return err
	}
	prov, ok := c.providers.Get(sess.Provider)
	if !ok {
		return errors.New("unknown provider: " + sess.Provider)
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	if _, busy := c.runs[sessionID]; busy {
		c.mu.Unlock()
		cancel()
		return errors.New("session is busy")
	}
	c.runs[sessionID] = cancel
	c.mu.Unlock()

	user := store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "user",
		Parts: []store.Part{{Type: "text", Text: prompt}}, CreatedAt: time.Now().UnixMilli()}
	_ = c.store.SaveMessage(user)
	c.emit(EventChatMessage, user)

	if sess.Title == "New session" {
		sess.Title = titleFrom(prompt)
	}
	_ = c.store.UpdateSession(&sess) // bumps updated_at, persists title
	c.emit(EventSessionUpdated, sess)
	c.emit(EventChatStatus, ChatStatus{SessionID: sessionID, Running: true})

	req := provider.Request{
		Prompt: prompt, Dir: proj.Path, Env: platform.EnvForPath(proj.Path),
		Model: sess.Model, Effort: sess.Effort, Mode: sess.Mode,
		SessionID: sess.ProviderSessionID, Resume: sess.Started,
	}
	go c.run(ctx, sess, prov, req)
	return nil
}

func (c *ChatService) run(ctx context.Context, sess store.Session, prov provider.Provider, req provider.Request) {
	t := &transcript{msg: store.Message{ID: uuid.NewString(), SessionID: sess.ID, Role: "assistant",
		Parts: []store.Part{}, CreatedAt: time.Now().UnixMilli()}}

	defer func() {
		c.mu.Lock()
		delete(c.runs, sess.ID)
		c.mu.Unlock()
		c.emit(EventChatStatus, ChatStatus{SessionID: sess.ID, Running: false})
	}()

	events, err := prov.Run(ctx, req)
	if err != nil {
		t.apply(provider.Event{Kind: provider.EventError, Text: err.Error()})
		c.flush(t, true)
		c.finishSession(sess.ID, req.SessionID, StatusError, false)
		return
	}

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	gotOutput := false
loop:
	for {
		select {
		case e, ok := <-events:
			if !ok {
				break loop
			}
			gotOutput = gotOutput || e.Kind != provider.EventError
			t.apply(e)
		case <-ticker.C:
			c.flush(t, false)
		}
	}
	if ctx.Err() != nil {
		t.apply(provider.Event{Kind: provider.EventError, Text: "Stopped"})
	}
	t.finish()
	c.flush(t, true)

	c.finishSession(sess.ID, req.SessionID, t.outcome(ctx.Err() != nil), gotOutput)
}

// finishSession records the turn outcome (and bumps updated_at for "time ago").
// Once the provider produced output its session exists, so later turns resume it.
func (c *ChatService) finishSession(id, providerSessionID, status string, gotOutput bool) {
	fresh, err := c.store.Session(id)
	if err != nil {
		return
	}
	fresh.LastStatus = status
	if gotOutput && fresh.ProviderSessionID == providerSessionID {
		fresh.Started = true
	}
	_ = c.store.UpdateSession(&fresh)
	c.emit(EventSessionUpdated, fresh)
}

// flush emits the transcript if it changed; persist also writes it to the store.
func (c *ChatService) flush(t *transcript, persist bool) {
	msg, changed := t.snapshot()
	if !changed && !persist {
		return
	}
	if len(msg.Parts) == 0 {
		return
	}
	c.emit(EventChatMessage, msg)
	if persist {
		_ = c.store.SaveMessage(msg)
	}
}

func titleFrom(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	if r := []rune(line); len(r) > 48 {
		return string(r[:48]) + "…"
	}
	return line
}

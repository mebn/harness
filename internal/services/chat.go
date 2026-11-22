package services

import (
	"cmp"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"harness/internal/attach"
	"harness/internal/provider"
	"harness/internal/store"
)

const flushInterval = 60 * time.Millisecond

// ChatService runs agent turns and streams the transcript to the frontend.
type ChatService struct {
	store     *store.Store
	providers *provider.Registry
	emit      Emitter
	usage     *UsageService
	files     attach.Store

	mu     sync.Mutex
	runs   map[string]*activeRun // sessionID -> running turn
	queues map[string][]*queued  // sessionID -> messages waiting for the turn to end
}

// activeRun is a turn in progress.
type activeRun struct {
	cancel   context.CancelFunc
	steering *provider.Steering
	canSteer bool // the provider takes messages mid-turn
	stopped  bool // the user pressed stop: queued messages wait
	// interrupted: stopped so a steered message can go next (providers without steering).
	interrupted bool
}

// queued is a message waiting in a session's queue.
type queued struct {
	QueuedMessage
	files []attach.Attachment
}

// QueuedMessage is a message sent while the agent was busy. It runs when the turn ends,
// or sooner when steered into the running turn.
type QueuedMessage struct {
	ID          string       `json:"id"`
	Text        string       `json:"text"`
	Attachments []store.Part `json:"attachments"`
	// Steering: sent into the running turn, waiting for the agent to take it in.
	Steering  bool  `json:"steering"`
	CreatedAt int64 `json:"createdAt"`
}

// ChatQueue is a session's queued messages, oldest first.
type ChatQueue struct {
	SessionID string          `json:"sessionId"`
	Items     []QueuedMessage `json:"items"`
}

func NewChatService(s *store.Store, r *provider.Registry, u *UsageService, files attach.Store, emit Emitter) *ChatService {
	return &ChatService{store: s, providers: r, usage: u, files: files, emit: emit,
		runs: map[string]*activeRun{}, queues: map[string][]*queued{}}
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

// Stop ends the running turn. Queued messages stay queued.
func (c *ChatService) Stop(sessionID string) {
	c.mu.Lock()
	run := c.runs[sessionID]
	if run != nil {
		run.stopped = true
	}
	c.mu.Unlock()
	if run != nil {
		run.cancel()
	}
}

// ServiceShutdown is a Wails lifecycle hook: stop running agents on exit.
func (c *ChatService) ServiceShutdown() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, run := range c.runs {
		run.stopped = true
		run.cancel()
	}
	return nil
}

// Queues returns every session's non-empty queue.
func (c *ChatService) Queues() []ChatQueue {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []ChatQueue{}
	for id := range c.queues {
		if q := c.queueLocked(id); len(q.Items) > 0 {
			out = append(out, q)
		}
	}
	return out
}

// RemoveQueued drops a queued message. One already steered into the turn can't be taken back.
func (c *ChatService) RemoveQueued(sessionID, id string) error {
	c.mu.Lock()
	i := c.queuedIndex(sessionID, id)
	if i < 0 {
		c.mu.Unlock()
		return nil
	}
	if c.queues[sessionID][i].Steering {
		c.mu.Unlock()
		return errors.New("already sent to the agent")
	}
	c.queues[sessionID] = append(c.queues[sessionID][:i:i], c.queues[sessionID][i+1:]...)
	c.mu.Unlock()
	c.emitQueue(sessionID)
	return nil
}

// Steer sends a queued message now. With a running turn it goes into that turn when the
// provider supports it; otherwise the turn is stopped and the message runs next. Without a
// running turn it simply starts one.
func (c *ChatService) Steer(sessionID, id string) error {
	c.mu.Lock()
	i := c.queuedIndex(sessionID, id)
	if i < 0 {
		c.mu.Unlock()
		return errors.New("message is no longer queued")
	}
	q := c.queues[sessionID][i]
	run := c.runs[sessionID]
	switch {
	case q.Steering:
		c.mu.Unlock()
		return nil
	case run == nil:
		c.queues[sessionID] = append(c.queues[sessionID][:i:i], c.queues[sessionID][i+1:]...)
		c.mu.Unlock()
		c.emitQueue(sessionID)
		if err := c.start(sessionID, q.Text, q.files); err != nil {
			c.requeue(sessionID, q)
			return err
		}
		return nil
	case !run.canSteer:
		c.moveToFront(sessionID, i)
		run.interrupted = true
		c.mu.Unlock()
		c.emitQueue(sessionID)
		run.cancel()
		return nil
	}
	q.Steering = true
	c.mu.Unlock()
	c.emitQueue(sessionID)

	if run.steering.Send(provider.Input{ID: q.ID, Prompt: steerPrompt(q), Attachments: providerAttachments(q.files)}) {
		return nil
	}
	// The turn just ended: the message goes next instead.
	c.mu.Lock()
	q.Steering = false
	if i := c.queuedIndex(sessionID, id); i >= 0 {
		c.moveToFront(sessionID, i)
	}
	c.mu.Unlock()
	c.emitQueue(sessionID)
	return nil
}

func (c *ChatService) queuedIndex(sessionID, id string) int {
	for i, q := range c.queues[sessionID] {
		if q.ID == id {
			return i
		}
	}
	return -1
}

func (c *ChatService) moveToFront(sessionID string, i int) {
	list := c.queues[sessionID]
	q := list[i]
	c.queues[sessionID] = append([]*queued{q}, append(list[:i:i], list[i+1:]...)...)
}

func (c *ChatService) requeue(sessionID string, q *queued) {
	c.mu.Lock()
	q.Steering = false
	c.queues[sessionID] = append([]*queued{q}, c.queues[sessionID]...)
	c.mu.Unlock()
	c.emitQueue(sessionID)
}

func (c *ChatService) queueLocked(sessionID string) ChatQueue {
	items := make([]QueuedMessage, 0, len(c.queues[sessionID]))
	for _, q := range c.queues[sessionID] {
		items = append(items, q.QueuedMessage)
	}
	return ChatQueue{SessionID: sessionID, Items: items}
}

func (c *ChatService) emitQueue(sessionID string) {
	c.mu.Lock()
	q := c.queueLocked(sessionID)
	if len(q.Items) == 0 {
		delete(c.queues, sessionID)
	}
	c.mu.Unlock()
	c.emit(EventChatQueue, q)
}

// AttachmentInput is a file sent from the UI (base64, since bindings are JSON).
type AttachmentInput struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"` // base64
}

// Send starts a turn with the session's current provider settings. While a turn is running
// the message is queued instead, and its id returned ("" when a turn started).
func (c *ChatService) Send(sessionID, prompt string, attachments []AttachmentInput) (string, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" && len(attachments) == 0 {
		return "", errors.New("empty prompt")
	}
	if _, err := c.store.Session(sessionID); err != nil {
		return "", err
	}
	saved, err := c.saveAttachments(sessionID, attachments)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	if _, busy := c.runs[sessionID]; busy {
		q := &queued{QueuedMessage: QueuedMessage{ID: uuid.NewString(), Text: prompt,
			Attachments: attachmentParts(saved), CreatedAt: time.Now().UnixMilli()}, files: saved}
		c.queues[sessionID] = append(c.queues[sessionID], q)
		c.mu.Unlock()
		c.emitQueue(sessionID)
		return q.ID, nil
	}
	c.mu.Unlock()
	return "", c.start(sessionID, prompt, saved)
}

// start begins a turn. Fails when the session already has one running.
func (c *ChatService) start(sessionID, prompt string, saved []attach.Attachment) error {
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return err
	}
	loc, err := locate(c.store, sess.ProjectID, sess.Worktree)
	if err != nil {
		return err
	}
	prov, ok := c.providers.Get(sess.Provider)
	if !ok {
		return errors.New("unknown provider: " + sess.Provider)
	}

	ctx, cancel := context.WithCancel(context.Background())
	run := &activeRun{cancel: cancel, steering: provider.NewSteering(), canSteer: prov.Info().Steer}
	c.mu.Lock()
	if _, busy := c.runs[sessionID]; busy {
		c.mu.Unlock()
		cancel()
		return errors.New("session is busy")
	}
	c.runs[sessionID] = run
	c.mu.Unlock()

	// A turn on a different model than the last one gets a divider (shown, never sent).
	if divider, ok := c.modelSwitch(sess); ok {
		_ = c.store.SaveMessage(divider)
		c.emit(EventChatMessage, divider)
	}
	sess.TurnProvider, sess.TurnModel = sess.Provider, sess.Model

	user := userMessage(sessionID, prompt, saved)
	_ = c.store.SaveMessage(user)
	c.emit(EventChatMessage, user)

	if sess.Title == "New session" {
		if prompt != "" {
			sess.Title = titleFrom(prompt)
		} else {
			sess.Title = titleFrom(saved[0].Name)
		}
	}
	if prompt == "" {
		prompt = "See the attached files."
	}
	_ = c.store.UpdateSession(&sess) // bumps updated_at, persists title
	c.emit(EventSessionUpdated, sess)
	c.emit(EventChatStatus, ChatStatus{SessionID: sessionID, Running: true})

	req := provider.Request{
		Prompt: prompt, Dir: loc.Dir, Env: loc.Env,
		Model: sess.Model, Effort: sess.Effort, Mode: sess.Mode, Fast: sess.Fast,
		SessionID: sess.ProviderSessionID, Resume: sess.Started,
		Attachments: providerAttachments(saved), Steering: run.steering,
	}
	go c.run(ctx, sess, prov, req)
	return nil
}

// modelSwitch returns a divider message when this turn runs on another provider or model
// than the session's previous turn.
func (c *ChatService) modelSwitch(sess store.Session) (store.Message, bool) {
	if sess.TurnProvider == "" || (sess.TurnProvider == sess.Provider && sess.TurnModel == sess.Model) {
		return store.Message{}, false
	}
	from := c.modelLabel(sess.TurnProvider, sess.TurnModel, sess.TurnProvider != sess.Provider)
	to := c.modelLabel(sess.Provider, sess.Model, sess.TurnProvider != sess.Provider)
	return store.Message{ID: uuid.NewString(), SessionID: sess.ID, Role: "event", CreatedAt: time.Now().UnixMilli(),
		Parts: []store.Part{{Type: "model-switch", Text: from + " → " + to}}}, true
}

// modelLabel names a model as the picker does, with its provider when that changed too.
func (c *ChatService) modelLabel(providerID, model string, withProvider bool) string {
	label, name := model, providerID
	if p, ok := c.providers.Get(providerID); ok {
		info := p.Info()
		name = info.Name
		for _, m := range info.Models {
			if m.ID == model {
				label = m.Label
			}
		}
	}
	if withProvider {
		return name + " · " + label
	}
	return label
}

func userMessage(sessionID, prompt string, saved []attach.Attachment) store.Message {
	parts := attachmentParts(saved)
	if prompt != "" {
		parts = append(parts, store.Part{Type: "text", Text: prompt})
	}
	return store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "user",
		Parts: parts, CreatedAt: time.Now().UnixMilli()}
}

func attachmentParts(saved []attach.Attachment) []store.Part {
	parts := []store.Part{}
	for _, a := range saved {
		parts = append(parts, store.Part{Type: "attachment", FileName: a.Name, FilePath: a.Path, MimeType: a.MimeType, URL: a.URL})
	}
	return parts
}

func providerAttachments(saved []attach.Attachment) []provider.Attachment {
	out := []provider.Attachment{}
	for _, a := range saved {
		out = append(out, provider.Attachment{Name: a.Name, MimeType: a.MimeType, Path: a.Path, IsImage: a.IsImage()})
	}
	return out
}

func steerPrompt(q *queued) string {
	if q.Text == "" {
		return "See the attached files."
	}
	return q.Text
}

func (c *ChatService) newTranscript(sessionID string) *transcript {
	return &transcript{msg: store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "assistant",
		Parts: []store.Part{}, CreatedAt: time.Now().UnixMilli()}}
}

func (c *ChatService) run(ctx context.Context, sess store.Session, prov provider.Provider, req provider.Request) {
	t := c.newTranscript(sess.ID)
	// Replies before a steered message: a subagent or tool started there can still report.
	var earlier []*transcript
	outcome := StatusError
	defer func() { c.endRun(sess.ID, outcome) }()

	events, err := prov.Run(ctx, req)
	if err != nil {
		t.apply(provider.Event{Kind: provider.EventError, Text: err.Error()})
		c.flush(t, true)
		c.finishSession(sess.ID, req.SessionID, StatusError, false, 0, 0)
		return
	}

	// owner is the reply holding a tool call (or the parent of a subagent's call).
	owner := func(toolID string) *transcript {
		if toolID == "" || t.hasTool(toolID) {
			return t
		}
		for _, e := range earlier {
			if e.hasTool(toolID) {
				return e
			}
		}
		return t
	}

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	gotOutput := false
	var ctxTokens, ctxWindow int64
loop:
	for {
		select {
		case e, ok := <-events:
			if !ok {
				break loop
			}
			switch e.Kind {
			case provider.EventUsage:
				c.usage.record(*e.Usage)
				continue
			case provider.EventContext:
				ctxTokens = cmp.Or(e.ContextTokens, ctxTokens)
				ctxWindow = cmp.Or(e.ContextWindow, ctxWindow)
				continue
			case provider.EventFast:
				c.recordFast(sess.ID, e.FastState, e.FastOffReason)
				continue
			case provider.EventSteered:
				// The agent took in a steered message: close this reply, show the message, and
				// continue in a new reply below it.
				if q := c.takeSteered(sess.ID, e.InputID); q != nil {
					c.flush(t, true)
					earlier = append(earlier, t)
					user := userMessage(sess.ID, q.Text, q.files)
					_ = c.store.SaveMessage(user)
					c.emit(EventChatMessage, user)
					t = c.newTranscript(sess.ID)
				}
				continue
			case provider.EventToolStart:
				gotOutput = true
				owner(e.ParentID).apply(e)
			case provider.EventToolEnd:
				gotOutput = true
				owner(e.ToolID).apply(e)
			default:
				gotOutput = gotOutput || e.Kind != provider.EventError
				t.apply(e)
			}
		case <-ticker.C:
			for _, e := range earlier {
				c.flush(e, false)
			}
			c.flush(t, false)
		}
	}
	if ctx.Err() != nil {
		t.apply(provider.Event{Kind: provider.EventError, Text: "Stopped"})
	}
	for _, e := range earlier {
		e.finish()
		c.flush(e, true)
	}
	t.finish()
	c.flush(t, true)

	outcome = t.outcome(ctx.Err() != nil)
	c.finishSession(sess.ID, req.SessionID, outcome, gotOutput, ctxTokens, ctxWindow)
	if sess.Provider == "copilot" {
		go c.usage.refreshCopilot()
	}
}

// recordFast stores the fast mode state the provider reported, when it changed.
func (c *ChatService) recordFast(sessionID, state, reason string) {
	fresh, err := c.store.Session(sessionID)
	if err != nil || (fresh.FastState == state && fresh.FastOffReason == reason) {
		return
	}
	fresh.FastState, fresh.FastOffReason = state, reason
	_ = c.store.UpdateSession(&fresh)
	c.emit(EventSessionUpdated, fresh)
}

// takeSteered removes a steered message from the queue once the agent has taken it in.
func (c *ChatService) takeSteered(sessionID, id string) *queued {
	c.mu.Lock()
	i := c.queuedIndex(sessionID, id)
	var q *queued
	if i >= 0 {
		q = c.queues[sessionID][i]
		c.queues[sessionID] = append(c.queues[sessionID][:i:i], c.queues[sessionID][i+1:]...)
	}
	c.mu.Unlock()
	if q != nil {
		c.emitQueue(sessionID)
	}
	return q
}

// endRun clears the running turn and starts the next queued message, unless the user
// stopped the turn or it failed.
func (c *ChatService) endRun(sessionID, outcome string) {
	c.mu.Lock()
	run := c.runs[sessionID]
	delete(c.runs, sessionID)
	for _, q := range c.queues[sessionID] {
		q.Steering = false // sent but never taken in: it waits like the rest
	}
	var next *queued
	if q := c.queues[sessionID]; len(q) > 0 && run != nil &&
		(run.interrupted || (!run.stopped && outcome != StatusError)) {
		next = q[0]
		c.queues[sessionID] = q[1:]
	}
	c.mu.Unlock()
	c.emit(EventChatStatus, ChatStatus{SessionID: sessionID, Running: false})
	c.emitQueue(sessionID)
	if next != nil {
		if err := c.start(sessionID, next.Text, next.files); err != nil {
			c.requeue(sessionID, next)
		}
	}
}

// finishSession records the turn outcome (and bumps updated_at for "time ago").
// Once the provider produced output its session exists, so later turns resume it.
// Context usage is kept from earlier turns when this one did not report it.
func (c *ChatService) finishSession(id, providerSessionID, status string, gotOutput bool, ctxTokens, ctxWindow int64) {
	fresh, err := c.store.Session(id)
	if err != nil {
		return
	}
	fresh.LastStatus = status
	fresh.ContextTokens = cmp.Or(ctxTokens, fresh.ContextTokens)
	fresh.ContextWindow = cmp.Or(ctxWindow, fresh.ContextWindow)
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

// saveAttachments decodes and stores uploaded files for a session.
func (c *ChatService) saveAttachments(sessionID string, in []AttachmentInput) ([]attach.Attachment, error) {
	out := make([]attach.Attachment, 0, len(in))
	for _, a := range in {
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			return nil, fmt.Errorf("%s: invalid data", a.Name)
		}
		saved, err := c.files.Save(sessionID, a.Name, a.MimeType, data)
		if err != nil {
			return nil, err
		}
		out = append(out, saved)
	}
	return out, nil
}

func titleFrom(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	if r := []rune(line); len(r) > 48 {
		return string(r[:48]) + "…"
	}
	return line
}

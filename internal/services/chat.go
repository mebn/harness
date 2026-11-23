package services

import (
	"cmp"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"harness/internal/attach"
	"harness/internal/provider"
	"harness/internal/store"
)

const (
	flushInterval = 60 * time.Millisecond
	// An idle conversation's process is closed after this long, unless background tasks run.
	idleTimeout = 2 * time.Hour
	// How long a stopped turn may take to wind down before its process is killed.
	stopGrace = 8 * time.Second
)

var errBusy = errors.New("the agent is busy in this chat")

// ChatService runs agent conversations and streams the transcript to the frontend.
//
// Each chat that has been used keeps a live conversation (for Claude, one CLI process), so
// messages can be steered into a running turn, the agent can ask for permission, and a
// background task that finishes later can start a turn on its own.
type ChatService struct {
	store     *store.Store
	providers *provider.Registry
	emit      Emitter
	usage     *UsageService
	files     attach.Store

	openMu sync.Mutex // serializes opening conversations

	mu       sync.Mutex
	live     map[string]*liveSession       // sessionID -> open conversation
	queues   map[string][]*queued          // sessionID -> messages waiting for the turn to end
	commands map[string][]provider.Command // folder -> slash commands last seen there
}

// liveSession is a chat's open conversation with its provider.
type liveSession struct {
	sessionID         string
	providerID        string
	providerSessionID string
	dir               string
	conn              provider.Conn
	canSteer          bool
	interactive       bool
	settings          provider.Settings
	closing           bool // closed on purpose: the process ending is not an error
	dead              bool // the conversation has ended

	turn        *turn                           // nil while idle
	permissions map[string]*provider.Permission // waiting for an answer, by request id
	order       []string                        // request ids, oldest first
	asked       map[string]int64                // when each request came in
	tasks       []provider.Task
	commands    []provider.Command
	idle        *time.Timer
}

// turn is the agent working: from a message (or a background task ending) to its result.
type turn struct {
	t *transcript
	// Replies before a steered message: a subagent or tool started there can still report.
	earlier     []*transcript
	opening     *store.Message // the user message that started it, if any
	stopped     bool           // the user pressed stop: queued messages wait
	interrupted bool           // stopped so a steered message can go next (providers without steering)
	gotOutput   bool
	ctxTokens   int64
	ctxWindow   int64
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
		live: map[string]*liveSession{}, queues: map[string][]*queued{}, commands: map[string][]provider.Command{}}
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
	ids := []string{}
	for id, ls := range c.live {
		if ls.turn != nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// activity counts conversations that would be lost if the server stopped now: a turn
// running, or background tasks still going.
func (c *ChatService) activity() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, ls := range c.live {
		if ls.turn != nil || len(ls.tasks) > 0 {
			n++
		}
	}
	return n
}

// Stop ends the running turn. Queued messages stay queued, background tasks keep running.
func (c *ChatService) Stop(sessionID string) {
	c.mu.Lock()
	ls := c.live[sessionID]
	if ls == nil || ls.turn == nil {
		c.mu.Unlock()
		return
	}
	tr := ls.turn
	tr.stopped = true
	// Messages sent into the turn but not taken in yet go back to waiting.
	var unsent []string
	for _, q := range c.queues[sessionID] {
		if q.Steering {
			q.Steering = false
			unsent = append(unsent, q.ID)
		}
	}
	hadPending := c.clearPermissionsLocked(ls)
	c.mu.Unlock()
	c.emitQueue(sessionID)
	if hadPending {
		c.emitPending(ls)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, id := range unsent {
			_, _ = ls.conn.Control(ctx, "cancel_async_message", map[string]any{"message_uuid": id})
		}
		_ = ls.conn.Interrupt()
		time.Sleep(stopGrace)
		c.mu.Lock()
		stuck := ls.turn == tr
		c.mu.Unlock()
		if stuck {
			c.closeLive(ls)
		}
	}()
}

// ServiceShutdown is a Wails lifecycle hook: end every conversation on exit.
func (c *ChatService) ServiceShutdown() error {
	c.mu.Lock()
	list := make([]*liveSession, 0, len(c.live))
	for _, ls := range c.live {
		if ls.turn != nil {
			ls.turn.stopped = true
		}
		list = append(list, ls)
	}
	c.mu.Unlock()
	for _, ls := range list {
		c.closeLive(ls)
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
	ls := c.live[sessionID]
	switch {
	case q.Steering:
		c.mu.Unlock()
		return nil
	case ls == nil || ls.turn == nil:
		c.queues[sessionID] = append(c.queues[sessionID][:i:i], c.queues[sessionID][i+1:]...)
		c.mu.Unlock()
		c.emitQueue(sessionID)
		if err := c.start(sessionID, q.ID, q.Text, q.files); err != nil {
			c.requeue(sessionID, q)
			return err
		}
		return nil
	case !ls.canSteer:
		c.moveToFront(sessionID, i)
		ls.turn.interrupted = true
		c.mu.Unlock()
		c.emitQueue(sessionID)
		go func() { _ = ls.conn.Interrupt() }()
		return nil
	}
	q.Steering = true
	c.mu.Unlock()
	c.emitQueue(sessionID)

	err := ls.conn.Send(provider.Input{ID: q.ID, Prompt: promptText(q.Text), Attachments: providerAttachments(q.files)})
	if err == nil {
		return nil
	}
	// The conversation just ended: the message goes next instead.
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
// "/clear" starts a fresh provider conversation in the same chat.
func (c *ChatService) Send(sessionID, prompt string, attachments []AttachmentInput) (string, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" && len(attachments) == 0 {
		return "", errors.New("empty prompt")
	}
	if _, err := c.store.Session(sessionID); err != nil {
		return "", err
	}
	if isClearCommand(prompt) && len(attachments) == 0 {
		return "", c.Clear(sessionID)
	}
	saved, err := c.saveAttachments(sessionID, attachments)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	if ls := c.live[sessionID]; ls != nil && ls.turn != nil {
		q := &queued{QueuedMessage: QueuedMessage{ID: uuid.NewString(), Text: prompt,
			Attachments: attachmentParts(saved), CreatedAt: time.Now().UnixMilli()}, files: saved}
		c.queues[sessionID] = append(c.queues[sessionID], q)
		c.mu.Unlock()
		c.emitQueue(sessionID)
		return q.ID, nil
	}
	c.mu.Unlock()
	return "", c.start(sessionID, uuid.NewString(), prompt, saved)
}

func isClearCommand(prompt string) bool {
	switch strings.ToLower(prompt) {
	case "/clear", "/new", "/reset":
		return true
	}
	return false
}

// start begins a turn with a user message. Fails when the session already has one running.
func (c *ChatService) start(sessionID, msgID, prompt string, saved []attach.Attachment) error {
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return err
	}
	ls, err := c.ensureLive(sess)
	if err != nil {
		return err
	}
	tr := c.newTurn(sessionID)
	c.mu.Lock()
	if ls.dead || ls.turn != nil {
		c.mu.Unlock()
		return errBusy
	}
	ls.turn = tr
	c.mu.Unlock()

	// A turn on a different model than the last one gets a divider (shown, never sent).
	if divider, ok := c.modelSwitch(sess); ok {
		_ = c.store.SaveMessage(divider)
		c.emit(EventChatMessage, divider)
	}
	sess.TurnProvider, sess.TurnModel = sess.Provider, sess.Model

	user := userMessage(sessionID, msgID, prompt, saved)
	tr.opening = &user
	_ = c.store.SaveMessage(user)
	c.emit(EventChatMessage, user)
	// The reply sorts after the message.
	c.mu.Lock()
	tr.t = c.newTranscript(sessionID)
	c.mu.Unlock()

	if sess.Title == "New session" {
		if prompt != "" {
			sess.Title = titleFrom(prompt)
		} else {
			sess.Title = titleFrom(saved[0].Name)
		}
	}
	_ = c.store.UpdateSession(&sess) // bumps updated_at, persists title
	c.emit(EventSessionUpdated, sess)
	c.emit(EventChatStatus, ChatStatus{SessionID: sessionID, Running: true})

	if err := ls.conn.Send(provider.Input{ID: msgID, Prompt: promptText(prompt), Attachments: providerAttachments(saved)}); err != nil {
		c.mu.Lock()
		if ls.turn == tr {
			ls.turn = nil
		}
		c.mu.Unlock()
		tr.t.apply(provider.Event{Kind: provider.EventError, Text: err.Error()})
		c.finishTurn(ls, tr, "")
	}
	return nil
}

// ensureLive returns the session's open conversation, opening one when needed, with the
// session's current settings applied.
func (c *ChatService) ensureLive(sess store.Session) (*liveSession, error) {
	c.openMu.Lock()
	defer c.openMu.Unlock()
	settings := provider.Settings{Model: sess.Model, Effort: sess.Effort, Mode: sess.Mode, Fast: sess.Fast}

	c.mu.Lock()
	ls := c.live[sess.ID]
	if ls != nil && (ls.providerID != sess.Provider || ls.providerSessionID != sess.ProviderSessionID) {
		if ls.turn != nil {
			c.mu.Unlock()
			return nil, errBusy
		}
		c.closeLiveLocked(ls)
		ls = nil
	}
	if ls != nil {
		changed := ls.settings != settings
		ls.settings = settings
		c.mu.Unlock()
		if changed {
			if err := ls.conn.Apply(settings); err != nil {
				log.Printf("chat %s: applying settings: %v", sess.ID, err)
			}
		}
		c.touch(ls)
		return ls, nil
	}
	c.mu.Unlock()

	loc, err := locate(c.store, sess.ProjectID, sess.Worktree)
	if err != nil {
		return nil, err
	}
	prov, ok := c.providers.Get(sess.Provider)
	if !ok {
		return nil, errors.New("unknown provider: " + sess.Provider)
	}
	conn, err := prov.Open(context.Background(), provider.OpenRequest{
		Dir: loc.Dir, Env: loc.Env, Settings: settings, SessionID: sess.ProviderSessionID,
		Resume: sess.Started && sess.ForkFrom == "", ForkFrom: sess.ForkFrom, ResumeAt: sess.ResumeAt, LastUUID: sess.LastUUID,
	})
	if err != nil {
		return nil, err
	}
	info := prov.Info()
	ls = &liveSession{sessionID: sess.ID, providerID: sess.Provider, providerSessionID: sess.ProviderSessionID,
		dir: loc.Dir, conn: conn, canSteer: info.Steer, interactive: info.Interactive, settings: settings,
		permissions: map[string]*provider.Permission{}, asked: map[string]int64{}}
	c.mu.Lock()
	c.live[sess.ID] = ls
	c.mu.Unlock()
	c.touch(ls)
	go c.read(ls)
	return ls, nil
}

// settingsChanged applies a session's new settings to its open conversation right away
// (a mode switch matters mid-turn). A changed provider ends the conversation once idle.
func (c *ChatService) settingsChanged(sess store.Session) {
	c.mu.Lock()
	ls := c.live[sess.ID]
	if ls == nil {
		c.mu.Unlock()
		return
	}
	if ls.providerID != sess.Provider || ls.providerSessionID != sess.ProviderSessionID {
		if ls.turn == nil {
			c.closeLiveLocked(ls)
		}
		c.mu.Unlock()
		return
	}
	settings := provider.Settings{Model: sess.Model, Effort: sess.Effort, Mode: sess.Mode, Fast: sess.Fast}
	changed := ls.settings != settings
	ls.settings = settings
	c.mu.Unlock()
	if changed {
		go func() {
			if err := ls.conn.Apply(settings); err != nil {
				log.Printf("chat %s: applying settings: %v", sess.ID, err)
			}
		}()
	}
}

// touch restarts the idle timer.
func (c *ChatService) touch(ls *liveSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ls.dead {
		return
	}
	if ls.idle != nil {
		ls.idle.Stop()
	}
	ls.idle = time.AfterFunc(idleTimeout, func() {
		c.mu.Lock()
		busy := ls.turn != nil || len(ls.tasks) > 0 || len(ls.permissions) > 0
		c.mu.Unlock()
		if busy {
			c.touch(ls)
			return
		}
		c.closeLive(ls)
	})
}

func (c *ChatService) closeLive(ls *liveSession) {
	c.mu.Lock()
	c.closeLiveLocked(ls)
	c.mu.Unlock()
}

// closeLiveLocked ends a conversation on purpose; read finishes the cleanup.
func (c *ChatService) closeLiveLocked(ls *liveSession) {
	ls.closing = true
	if c.live[ls.sessionID] == ls {
		delete(c.live, ls.sessionID)
	}
	if ls.idle != nil {
		ls.idle.Stop()
	}
	go ls.conn.Close()
}

func (c *ChatService) newTurn(sessionID string) *turn {
	return &turn{t: c.newTranscript(sessionID)}
}

func (c *ChatService) newTranscript(sessionID string) *transcript {
	return &transcript{msg: store.Message{ID: uuid.NewString(), SessionID: sessionID, Role: "assistant",
		Parts: []store.Part{}, CreatedAt: stamp()}}
}

// read handles a conversation's events until it ends.
func (c *ChatService) read(ls *liveSession) {
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	events := ls.conn.Events()
	for {
		select {
		case e, ok := <-events:
			if !ok {
				c.connClosed(ls)
				return
			}
			c.handle(ls, e)
		case <-ticker.C:
			c.mu.Lock()
			tr := ls.turn
			c.mu.Unlock()
			if tr != nil {
				for _, e := range tr.earlier {
					c.flush(e, false)
				}
				c.flush(tr.t, false)
			}
		}
	}
}

func (c *ChatService) handle(ls *liveSession, e provider.Event) {
	id := ls.sessionID
	switch e.Kind {
	case provider.EventUsage:
		c.usage.record(*e.Usage)
	case provider.EventFast:
		c.recordFast(id, e.FastState, e.FastOffReason)
	case provider.EventMode:
		c.recordMode(ls, e.Mode)
	case provider.EventContext:
		c.mu.Lock()
		if tr := ls.turn; tr != nil {
			tr.ctxTokens = cmp.Or(e.ContextTokens, tr.ctxTokens)
			tr.ctxWindow = cmp.Or(e.ContextWindow, tr.ctxWindow)
		}
		c.mu.Unlock()
	case provider.EventCommands:
		c.mu.Lock()
		ls.commands = e.Commands
		c.commands[ls.dir] = e.Commands
		c.mu.Unlock()
		c.emit(EventChatCommands, ChatCommands{SessionID: id, Commands: e.Commands})
	case provider.EventTasks:
		c.mu.Lock()
		ls.tasks = e.Tasks
		c.mu.Unlock()
		c.emit(EventChatTasks, ChatTasks{SessionID: id, Tasks: e.Tasks})
	case provider.EventTaskDone:
		if t := e.Task; t != nil {
			c.addEvent(ls, "task", taskLine(c.taskDescription(ls, t), t))
		}
	case provider.EventCompact:
		text := "Conversation compacted"
		if e.Text == "auto" {
			text = "Conversation compacted automatically"
		}
		c.addEvent(ls, "compact", text)
	case provider.EventPermission:
		c.ensureTurn(ls)
		p := e.Permission
		c.mu.Lock()
		ls.permissions[p.RequestID] = p
		ls.order = append(ls.order, p.RequestID)
		ls.asked[p.RequestID] = time.Now().UnixMilli()
		c.mu.Unlock()
		c.emitPending(ls)
	case provider.EventPermissionCancel:
		c.mu.Lock()
		_, ok := ls.permissions[e.RequestID]
		c.dropPermissionLocked(ls, e.RequestID)
		c.mu.Unlock()
		if ok {
			c.emitPending(ls)
		}
	case provider.EventInputTaken:
		c.inputTaken(ls, e)
	case provider.EventTurnEnd:
		c.turnEnded(ls, e.LastUUID)
	default: // text, thinking, tool calls, errors
		tr := c.ensureTurn(ls)
		ev := event{Event: e}
		for i, img := range e.Images {
			if a, err := c.files.Save(id, fmt.Sprintf("tool-image-%d%s", i+1, imageExt(img.MimeType)), img.MimeType, img.Data); err == nil {
				ev.ImageURLs = append(ev.ImageURLs, a.URL)
			}
		}
		c.mu.Lock()
		if e.Kind != provider.EventError {
			tr.gotOutput = true
		}
		owner := tr.t
		switch e.Kind {
		case provider.EventToolStart:
			owner = tr.owner(e.ParentID)
		case provider.EventToolEnd:
			owner = tr.owner(e.ToolID)
		}
		c.mu.Unlock()
		owner.applyEvent(ev)
	}
}

// owner is the reply holding a tool call (or the parent of a subagent's call).
func (tr *turn) owner(toolID string) *transcript {
	if toolID == "" || tr.t.hasTool(toolID) {
		return tr.t
	}
	for _, e := range tr.earlier {
		if e.hasTool(toolID) {
			return e
		}
	}
	return tr.t
}

// ensureTurn returns the running turn, starting one when the agent begins working on its
// own (after a background task ended, or on a message it took in after the last turn).
func (c *ChatService) ensureTurn(ls *liveSession) *turn {
	c.mu.Lock()
	tr := ls.turn
	started := tr == nil
	if started {
		tr = c.newTurn(ls.sessionID)
		ls.turn = tr
	}
	c.mu.Unlock()
	if started {
		c.emit(EventChatStatus, ChatStatus{SessionID: ls.sessionID, Running: true})
	}
	return tr
}

// inputTaken handles the agent taking in a message: a steered one shows up in the chat now,
// and each one records where a rewind to it would cut the conversation.
func (c *ChatService) inputTaken(ls *liveSession, e provider.Event) {
	tr := c.ensureTurn(ls)
	cli, prev := "", ""
	if ls.interactive {
		cli, prev = e.InputID, e.PrevUUID
	}
	if q := c.takeSteered(ls.sessionID, e.InputID); q != nil {
		// Close this reply, show the message, and continue in a new reply below it.
		c.flush(tr.t, true)
		user := userMessage(ls.sessionID, q.ID, q.Text, q.files)
		user.CLIUUID, user.PrevUUID = cli, prev
		_ = c.store.SaveMessage(user)
		c.emit(EventChatMessage, user)
		c.mu.Lock()
		tr.earlier = append(tr.earlier, tr.t)
		tr.t = c.newTranscript(ls.sessionID)
		c.mu.Unlock()
		return
	}
	if cli == "" {
		return
	}
	_ = c.store.SetMessageUUIDs(e.InputID, cli, prev)
	if m, err := c.store.Message(e.InputID); err == nil {
		c.emit(EventChatMessage, m)
	}
}

// turnEnded closes the turn: the reply is saved and the next queued message starts.
func (c *ChatService) turnEnded(ls *liveSession, lastUUID string) {
	c.mu.Lock()
	tr := ls.turn
	if tr == nil {
		c.mu.Unlock()
		c.recordLastUUID(ls, lastUUID)
		return
	}
	// A message sent into the turn that the agent hasn't taken in yet starts another round
	// right away: keep working, in a new reply.
	waiting := false
	if ls.canSteer && !tr.stopped {
		for _, q := range c.queues[ls.sessionID] {
			waiting = waiting || q.Steering
		}
	}
	if waiting {
		done := append(tr.earlier, tr.t)
		tr.earlier, tr.t = nil, c.newTranscript(ls.sessionID)
		c.mu.Unlock()
		for _, t := range done {
			t.finish()
			c.flush(t, true)
		}
		c.recordLastUUID(ls, lastUUID)
		return
	}
	ls.turn = nil
	hadPending := c.clearPermissionsLocked(ls)
	c.mu.Unlock()
	if hadPending {
		c.emitPending(ls)
	}
	c.finishTurn(ls, tr, lastUUID)
}

// finishTurn saves a finished turn's replies, records its outcome and starts the next
// queued message, unless the user stopped the turn or it failed.
func (c *ChatService) finishTurn(ls *liveSession, tr *turn, lastUUID string) {
	id := ls.sessionID
	if tr.stopped || tr.interrupted {
		tr.t.apply(provider.Event{Kind: provider.EventError, Text: "Stopped"})
	}
	for _, e := range tr.earlier {
		e.finish()
		c.flush(e, true)
	}
	tr.t.finish()
	c.flush(tr.t, true)
	outcome := tr.t.outcome(tr.stopped)
	c.finishSession(id, ls.providerSessionID, outcome, tr.gotOutput, tr.ctxTokens, tr.ctxWindow, lastUUID)
	c.emit(EventChatStatus, ChatStatus{SessionID: id, Running: false})

	c.mu.Lock()
	var next *queued
	if q := c.queues[id]; len(q) > 0 && (tr.interrupted || (!tr.stopped && outcome != StatusError)) && !q[0].Steering {
		next = q[0]
		c.queues[id] = q[1:]
	}
	c.mu.Unlock()
	c.emitQueue(id)
	if next != nil {
		if err := c.start(id, next.ID, next.Text, next.files); err != nil {
			c.requeue(id, next)
		}
	}
	if ls.providerID == "copilot" {
		go c.usage.refreshCopilot()
	}
	c.touch(ls)
}

// connClosed cleans up after a conversation ended (its process exited or was closed).
func (c *ChatService) connClosed(ls *liveSession) {
	c.mu.Lock()
	ls.dead = true
	if c.live[ls.sessionID] == ls {
		delete(c.live, ls.sessionID)
	}
	if ls.idle != nil {
		ls.idle.Stop()
	}
	tr := ls.turn
	ls.turn = nil
	hadPending := c.clearPermissionsLocked(ls)
	hadTasks := len(ls.tasks) > 0
	ls.tasks = nil
	c.mu.Unlock()
	if hadPending {
		c.emitPending(ls)
	}
	if hadTasks {
		c.emit(EventChatTasks, ChatTasks{SessionID: ls.sessionID, Tasks: []provider.Task{}})
	}
	if tr != nil {
		c.finishTurn(ls, tr, "")
	}
}

// addEvent shows a line in the chat between replies (a compaction, a finished task).
func (c *ChatService) addEvent(ls *liveSession, kind, text string) {
	c.mu.Lock()
	tr := ls.turn
	c.mu.Unlock()
	if tr != nil {
		c.flush(tr.t, true)
	}
	msg := store.Message{ID: uuid.NewString(), SessionID: ls.sessionID, Role: "event", CreatedAt: stamp(),
		Parts: []store.Part{{Type: kind, Text: text}}}
	_ = c.store.SaveMessage(msg)
	c.emit(EventChatMessage, msg)
	if tr != nil {
		c.mu.Lock()
		tr.earlier = append(tr.earlier, tr.t)
		tr.t = c.newTranscript(ls.sessionID)
		c.mu.Unlock()
	}
}

func (c *ChatService) taskDescription(ls *liveSession, t *provider.Task) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, x := range ls.tasks {
		if x.ID == t.ID {
			return x.Description
		}
	}
	return ""
}

func taskLine(desc string, t *provider.Task) string {
	verb := "finished"
	switch t.Status {
	case "failed":
		verb = "failed"
	case "stopped":
		verb = "stopped"
	}
	name := cmp.Or(desc, t.Summary, "Background task")
	return fmt.Sprintf("%s · %s", name, verb)
}

func imageExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ".png"
}

// StopTask stops one background task.
func (c *ChatService) StopTask(sessionID, taskID string) error {
	c.mu.Lock()
	ls := c.live[sessionID]
	c.mu.Unlock()
	if ls == nil {
		return errors.New("no running conversation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := ls.conn.Control(ctx, "stop_task", map[string]any{"task_id": taskID})
	return err
}

// ChatTasks is a session's running background tasks.
type ChatTasks struct {
	SessionID string          `json:"sessionId"`
	Tasks     []provider.Task `json:"tasks"`
}

// Tasks returns every session's running background tasks.
func (c *ChatService) Tasks() []ChatTasks {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []ChatTasks{}
	for id, ls := range c.live {
		if len(ls.tasks) > 0 {
			out = append(out, ChatTasks{SessionID: id, Tasks: slices.Clone(ls.tasks)})
		}
	}
	return out
}

// recordMode stores a permission mode the provider switched to on its own (leaving plan
// mode after a plan is approved).
func (c *ChatService) recordMode(ls *liveSession, mode string) {
	c.mu.Lock()
	ls.settings.Mode = mode
	c.mu.Unlock()
	fresh, err := c.store.Session(ls.sessionID)
	if err != nil || fresh.Mode == mode || fresh.ProviderSessionID != ls.providerSessionID {
		return
	}
	fresh.Mode = mode
	_ = c.store.UpdateSession(&fresh)
	c.emit(EventSessionUpdated, fresh)
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

func (c *ChatService) recordLastUUID(ls *liveSession, lastUUID string) {
	if lastUUID == "" {
		return
	}
	fresh, err := c.store.Session(ls.sessionID)
	if err != nil || fresh.ProviderSessionID != ls.providerSessionID || fresh.LastUUID == lastUUID {
		return
	}
	fresh.LastUUID = lastUUID
	_ = c.store.UpdateSession(&fresh)
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

// finishSession records the turn outcome (and bumps updated_at for "time ago").
// Once the provider produced output its session exists, so later turns resume it.
// Context usage is kept from earlier turns when this one did not report it.
func (c *ChatService) finishSession(id, providerSessionID, status string, gotOutput bool, ctxTokens, ctxWindow int64, lastUUID string) {
	fresh, err := c.store.Session(id)
	if err != nil {
		return
	}
	fresh.LastStatus = status
	fresh.ContextTokens = cmp.Or(ctxTokens, fresh.ContextTokens)
	fresh.ContextWindow = cmp.Or(ctxWindow, fresh.ContextWindow)
	if fresh.ProviderSessionID == providerSessionID {
		if gotOutput {
			fresh.Started = true
			fresh.ForkFrom, fresh.ResumeAt = "", ""
		} else if fresh.ForkFrom != "" && fresh.ResumeAt != "" && status == StatusError {
			// The conversation couldn't be cut at that point (it was compacted since): the
			// next message forks the whole conversation instead.
			fresh.ResumeAt = ""
		}
		if lastUUID != "" {
			fresh.LastUUID = lastUUID
		}
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

// modelSwitch returns a divider message when this turn runs on another provider or model
// than the session's previous turn.
func (c *ChatService) modelSwitch(sess store.Session) (store.Message, bool) {
	if sess.TurnProvider == "" || (sess.TurnProvider == sess.Provider && sess.TurnModel == sess.Model) {
		return store.Message{}, false
	}
	from := c.modelLabel(sess.TurnProvider, sess.TurnModel, sess.TurnProvider != sess.Provider)
	to := c.modelLabel(sess.Provider, sess.Model, sess.TurnProvider != sess.Provider)
	return store.Message{ID: uuid.NewString(), SessionID: sess.ID, Role: "event", CreatedAt: stamp(),
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

func userMessage(sessionID, id, prompt string, saved []attach.Attachment) store.Message {
	parts := attachmentParts(saved)
	if prompt != "" {
		parts = append(parts, store.Part{Type: "text", Text: prompt})
	}
	return store.Message{ID: id, SessionID: sessionID, Role: "user", Parts: parts, CreatedAt: stamp()}
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

func promptText(text string) string {
	if text == "" {
		return "See the attached files."
	}
	return text
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

var clock struct {
	sync.Mutex
	last int64
}

// stamp is the current time in ms, strictly increasing: messages sort in the order made.
func stamp() int64 {
	clock.Lock()
	defer clock.Unlock()
	clock.last = max(clock.last+1, time.Now().UnixMilli())
	return clock.last
}

func titleFrom(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	if r := []rune(line); len(r) > 48 {
		return string(r[:48]) + "…"
	}
	return line
}

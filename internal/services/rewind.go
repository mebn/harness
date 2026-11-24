package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"harness/internal/store"
)

// Clear starts a fresh provider conversation in the chat (/clear) and empties the chat.
func (c *ChatService) Clear(sessionID string) error {
	if err := c.closeIdle(sessionID); err != nil {
		return err
	}
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return err
	}
	sess.ProviderSessionID = uuid.NewString()
	sess.Started = false
	sess.ForkFrom, sess.ResumeAt, sess.LastUUID = "", "", ""
	sess.ContextTokens = 0
	if err := c.store.UpdateSession(&sess); err != nil {
		return err
	}
	if err := c.store.DeleteMessages(sessionID); err != nil {
		return err
	}
	c.emit(EventSessionUpdated, sess)
	c.emit(EventChatReload, ChatStatus{SessionID: sessionID})
	return nil
}

// closeIdle ends a session's open conversation; fails while a turn runs.
func (c *ChatService) closeIdle(sessionID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	ls := c.live[sessionID]
	if ls == nil {
		return nil
	}
	if ls.turn != nil {
		return errBusy
	}
	c.closeLiveLocked(ls)
	return nil
}

// sessionDeleted ends a deleted chat's conversation and drops its queue.
func (c *ChatService) sessionDeleted(sessionID string) {
	c.mu.Lock()
	if ls := c.live[sessionID]; ls != nil {
		if ls.turn != nil {
			ls.turn.stopped = true
		}
		c.closeLiveLocked(ls)
	}
	delete(c.queues, sessionID)
	c.mu.Unlock()
}

// rewindTarget loads a user message the conversation can be rewound to.
func (c *ChatService) rewindTarget(sessionID, messageID string) (store.Session, store.Message, error) {
	sess, err := c.store.Session(sessionID)
	if err != nil {
		return sess, store.Message{}, err
	}
	m, err := c.store.Message(messageID)
	if err != nil || m.SessionID != sessionID || m.Role != "user" {
		return sess, m, errors.New("message not found")
	}
	if m.CLIUUID == "" {
		return sess, m, errors.New("this message can't be rewound to (it was sent before rewinding was supported, or by another provider)")
	}
	return sess, m, nil
}

// cutAt points a session at its provider conversation cut just before message m: the next
// turn forks the conversation there (or starts fresh when m opened it).
func cutAt(sess *store.Session, m store.Message) {
	source := sess.ProviderSessionID
	if !sess.Started && sess.ForkFrom != "" {
		source = sess.ForkFrom // an earlier rewind that hasn't run yet
	}
	started := sess.Started || sess.ForkFrom != ""
	sess.ProviderSessionID = uuid.NewString()
	sess.Started = false
	sess.ContextTokens = 0
	if m.PrevUUID == "" || !started {
		sess.ForkFrom, sess.ResumeAt, sess.LastUUID = "", "", ""
		return
	}
	sess.ForkFrom, sess.ResumeAt, sess.LastUUID = source, m.PrevUUID, m.PrevUUID
}

// RewindResult is what a rewind changed.
type RewindResult struct {
	// Text of the message rewound to, to edit and send again.
	Text string `json:"text"`
	// FilesChanged lists files restored to how they were before the message.
	FilesChanged []string `json:"filesChanged"`
}

// Rewind goes back to just before a user message. With conversation, the message and
// everything after it leave the chat and the agent's context; with files, the agent's file
// changes since then are undone.
func (c *ChatService) Rewind(sessionID, messageID string, conversation, files bool) (RewindResult, error) {
	var res RewindResult
	sess, m, err := c.rewindTarget(sessionID, messageID)
	if err != nil {
		return res, err
	}
	c.mu.Lock()
	busy := c.live[sessionID] != nil && c.live[sessionID].turn != nil
	c.mu.Unlock()
	if busy {
		return res, errBusy
	}
	res.Text = messageText(m)

	if files {
		changed, err := c.rewindFiles(sess, m)
		if err != nil {
			return res, err
		}
		res.FilesChanged = changed
	}
	if !conversation {
		return res, nil
	}
	if err := c.closeIdle(sessionID); err != nil {
		return res, err
	}
	cutAt(&sess, m)
	if err := c.store.UpdateSession(&sess); err != nil {
		return res, err
	}
	if err := c.store.DeleteMessagesFrom(sessionID, m); err != nil {
		return res, err
	}
	c.emit(EventSessionUpdated, sess)
	c.emit(EventChatReload, ChatStatus{SessionID: sessionID})
	return res, nil
}

// rewindFiles undoes the agent's file changes made since message m.
func (c *ChatService) rewindFiles(sess store.Session, m store.Message) ([]string, error) {
	ls, err := c.ensureLive(sess)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	raw, err := ls.conn.Control(ctx, "rewind_files", map[string]any{"user_message_id": m.CLIUUID, "dry_run": true})
	if err != nil {
		return nil, err
	}
	var preview struct {
		CanRewind    bool     `json:"canRewind"`
		Error        string   `json:"error"`
		FilesChanged []string `json:"filesChanged"`
	}
	_ = json.Unmarshal(raw, &preview)
	if !preview.CanRewind {
		return nil, errors.New(cmpOr(preview.Error, "Claude Code has no file checkpoint for this message"))
	}
	raw, err = ls.conn.Control(ctx, "rewind_files", map[string]any{"user_message_id": m.CLIUUID})
	if err != nil {
		return nil, err
	}
	var done struct {
		CanRewind bool   `json:"canRewind"`
		Error     string `json:"error"`
	}
	_ = json.Unmarshal(raw, &done)
	if !done.CanRewind {
		return nil, errors.New(cmpOr(done.Error, "couldn't restore the files"))
	}
	return preview.FilesChanged, nil
}

// RewindPreview lists the files a rewind to the message would restore.
func (c *ChatService) RewindPreview(sessionID, messageID string) ([]string, error) {
	sess, m, err := c.rewindTarget(sessionID, messageID)
	if err != nil {
		return nil, err
	}
	ls, err := c.ensureLive(sess)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := ls.conn.Control(ctx, "rewind_files", map[string]any{"user_message_id": m.CLIUUID, "dry_run": true})
	if err != nil {
		return nil, err
	}
	var r struct {
		CanRewind    bool     `json:"canRewind"`
		FilesChanged []string `json:"filesChanged"`
	}
	_ = json.Unmarshal(raw, &r)
	if !r.CanRewind || r.FilesChanged == nil {
		return []string{}, nil
	}
	return r.FilesChanged, nil
}

// ForkResult is a chat forked from another.
type ForkResult struct {
	Session store.Session `json:"session"`
	// Text of the message forked at, to edit and send in the new chat.
	Text string `json:"text"`
}

// Fork starts a new chat with the conversation up to just before a user message. The
// original chat is left as it is.
func (c *ChatService) Fork(sessionID, messageID string) (ForkResult, error) {
	var res ForkResult
	sess, m, err := c.rewindTarget(sessionID, messageID)
	if err != nil {
		return res, err
	}
	all, err := c.store.Messages(sessionID)
	if err != nil {
		return res, err
	}
	fork := sess
	fork.ID = uuid.NewString()
	fork.Title = "Fork of " + strings.TrimPrefix(sess.Title, "Fork of ")
	fork.LastStatus = ""
	cutAt(&fork, m)
	if err := c.store.InsertSession(&fork); err != nil {
		return res, err
	}
	for _, x := range all {
		if x.ID == m.ID || x.CreatedAt > m.CreatedAt {
			break
		}
		x.ID = uuid.NewString()
		x.SessionID = fork.ID
		// Ids in the copied conversation aren't known: earlier messages can't be rewound to.
		x.CLIUUID, x.PrevUUID = "", ""
		_ = c.store.SaveMessage(x)
	}
	c.emit(EventTreeChanged, nil)
	return ForkResult{Session: fork, Text: messageText(m)}, nil
}

func messageText(m store.Message) string {
	var parts []string
	for _, p := range m.Parts {
		if p.Type == "text" {
			parts = append(parts, p.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

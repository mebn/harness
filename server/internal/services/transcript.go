package services

import (
	"strings"
	"sync"
	"time"

	"harness/server/internal/provider"
	"harness/server/internal/store"
)

// transcript accumulates provider events into an assistant message.
type transcript struct {
	mu    sync.Mutex
	msg   store.Message
	dirty bool
}

// event is a provider event plus what the chat service adds to it.
type event struct {
	provider.Event
	ImageURLs []string // saved copies of e.Images
}

func (t *transcript) apply(pe provider.Event) { t.applyEvent(event{Event: pe}) }

func (t *transcript) applyEvent(e event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dirty = true
	parts := t.msg.Parts
	switch e.Kind {
	case provider.EventText, provider.EventThinking:
		typ := "text"
		if e.Kind == provider.EventThinking {
			typ = "thinking"
		}
		if n := len(parts); n > 0 && parts[n-1].Type == typ && !parts[n-1].Done {
			parts[n-1].Text += e.Text
		} else {
			// A new block ends the thinking before it.
			if n := len(parts); n > 0 && parts[n-1].Type == "thinking" {
				parts[n-1].Done = true
			}
			parts = append(parts, store.Part{Type: typ, Text: e.Text, StartedAt: time.Now().UnixMilli()})
		}
	case provider.EventToolStart:
		if n := len(parts); n > 0 && parts[n-1].Type == "thinking" {
			parts[n-1].Done = true
		}
		parts = append(parts, store.Part{Type: "tool", ToolID: e.ToolID, ToolName: e.ToolName, ToolInput: e.ToolInput,
			ToolArgs: e.ToolArgs, ParentID: e.ParentID, Subagent: e.Subagent, StartedAt: time.Now().UnixMilli()})
	case provider.EventToolEnd:
		for i := len(parts) - 1; i >= 0; i-- {
			if parts[i].Type == "tool" && parts[i].ToolID == e.ToolID {
				p := &parts[i]
				p.ToolOutput, p.IsError, p.Done, p.EndedAt = e.ToolOutput, e.IsError, true, time.Now().UnixMilli()
				p.Images = e.ImageURLs
				if s := e.AgentStats; s != nil {
					p.AgentToolUses, p.AgentTokens = s.ToolUses, s.Tokens
					if s.DurationMs > 0 {
						p.EndedAt = p.StartedAt + s.DurationMs
					}
				}
				break
			}
		}
	case provider.EventError:
		parts = append(parts, store.Part{Type: "error", Text: e.Text, IsError: true})
	}
	t.msg.Parts = parts
}

// hasTool reports whether the message holds the tool call with this id.
func (t *transcript) hasTool(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, p := range t.msg.Parts {
		if p.Type == "tool" && p.ToolID == id {
			return true
		}
	}
	return false
}

// finish marks any still-open tool calls as done.
func (t *transcript) finish() {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().UnixMilli()
	for i := range t.msg.Parts {
		p := &t.msg.Parts[i]
		if p.Type == "tool" && !p.Done {
			p.EndedAt = now
		}
		p.Done = true
	}
	t.dirty = true
}

// snapshot returns a copy of the message and whether it changed since last call.
func (t *transcript) snapshot() (store.Message, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	m := t.msg
	m.Parts = append([]store.Part(nil), t.msg.Parts...)
	changed := t.dirty
	t.dirty = false
	return m, changed
}

// Turn outcomes stored on the session (shown as sidebar indicators).
const (
	StatusDone    = "done"
	StatusWaiting = "waiting" // the agent ended its turn with a question
	StatusError   = "error"
)

// outcome classifies a finished turn. A user stop counts as done.
func (t *transcript) outcome(stopped bool) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if stopped {
		return StatusDone
	}
	lastText := ""
	for _, p := range t.msg.Parts {
		switch p.Type {
		case "error":
			return StatusError
		case "text":
			lastText = p.Text
		}
	}
	if strings.HasSuffix(strings.TrimSpace(lastText), "?") {
		return StatusWaiting
	}
	return StatusDone
}

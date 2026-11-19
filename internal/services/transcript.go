package services

import (
	"strings"
	"sync"

	"harness/internal/provider"
	"harness/internal/store"
)

// transcript accumulates provider events into an assistant message.
type transcript struct {
	mu    sync.Mutex
	msg   store.Message
	dirty bool
}

func (t *transcript) apply(e provider.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dirty = true
	parts := t.msg.Parts
	switch e.Kind {
	case provider.EventText:
		if n := len(parts); n > 0 && parts[n-1].Type == "text" {
			parts[n-1].Text += e.Text
		} else {
			parts = append(parts, store.Part{Type: "text", Text: e.Text})
		}
	case provider.EventToolStart:
		parts = append(parts, store.Part{Type: "tool", ToolID: e.ToolID, ToolName: e.ToolName, ToolInput: e.ToolInput})
	case provider.EventToolEnd:
		for i := len(parts) - 1; i >= 0; i-- {
			if parts[i].Type == "tool" && parts[i].ToolID == e.ToolID {
				parts[i].ToolOutput, parts[i].IsError, parts[i].Done = e.ToolOutput, e.IsError, true
				break
			}
		}
	case provider.EventError:
		parts = append(parts, store.Part{Type: "error", Text: e.Text, IsError: true})
	}
	t.msg.Parts = parts
}

// finish marks any still-open tool calls as done.
func (t *transcript) finish() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.msg.Parts {
		t.msg.Parts[i].Done = true
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

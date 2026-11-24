package provider

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"

	"github.com/google/uuid"

	"harness/server/internal/platform"
)

// claudeConn is one Claude Code process holding a conversation.
type claudeConn struct {
	ctx    context.Context
	cancel context.CancelFunc
	env    platform.Env
	events chan Event
	writes chan []byte // stdin lines, written in order by one goroutine
	done   chan struct{}

	mu       sync.Mutex
	settings Settings
	// inputs holds ids of messages written to stdin that the CLI hasn't echoed back yet.
	inputs map[string]bool
	// lastUUID is the conversation's latest entry: where a rewind to the next message cuts.
	lastUUID string
	// controls are our control requests waiting for their response.
	controls map[string]chan controlReply
	closed   bool
}

type controlReply struct {
	raw json.RawMessage
	err error
}

func newClaudeConn(ctx context.Context, cancel context.CancelFunc, req OpenRequest) *claudeConn {
	last := req.LastUUID
	if req.ForkFrom != "" {
		last = req.ResumeAt
	}
	return &claudeConn{ctx: ctx, cancel: cancel, env: req.Env, events: make(chan Event, 256),
		writes: make(chan []byte, 64), done: make(chan struct{}), settings: req.Settings,
		inputs: map[string]bool{}, lastUUID: last, controls: map[string]chan controlReply{}}
}

func (c *claudeConn) start(cmd *exec.Cmd) error {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr tailBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start claude: %w", err)
	}

	// Writer: messages go out in order without blocking callers (a large image can fill
	// the pipe before the CLI reads it).
	go func() {
		for {
			select {
			case b := <-c.writes:
				if _, err := stdin.Write(b); err != nil {
					c.cancel()
					return
				}
			case <-c.ctx.Done():
				_ = stdin.Close()
				return
			}
		}
	}()

	go func() {
		defer close(c.events)
		defer close(c.done)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
		for sc.Scan() {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) > 0 && line[0] == '{' {
				c.handle(line)
			}
		}
		_, _ = io.Copy(io.Discard, stdout)
		err := cmd.Wait()
		c.mu.Lock()
		closed := c.closed
		c.closed = true
		for id, ch := range c.controls {
			ch <- controlReply{err: errors.New("claude exited")}
			delete(c.controls, id)
		}
		c.mu.Unlock()
		c.cancel()
		if err != nil && !closed {
			msg := strings.TrimSpace(stderr.String())
			var exitErr *exec.ExitError
			if msg == "" || !errors.As(err, &exitErr) {
				msg = strings.TrimSpace(err.Error() + "\n" + msg)
			}
			c.events <- Event{Kind: EventError, Text: msg}
		}
	}()
	return nil
}

func (c *claudeConn) Events() <-chan Event { return c.events }

// emit sends an event; dropped once the process is gone and nobody reads.
func (c *claudeConn) emit(e Event) {
	select {
	case c.events <- e:
	case <-c.done:
	}
}

func (c *claudeConn) write(line string) error {
	select {
	case c.writes <- []byte(line):
		return nil
	case <-c.ctx.Done():
		return errors.New("claude is not running")
	}
}

func (c *claudeConn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.write(string(b) + "\n")
}

// Control sends a control request and waits for the CLI's response.
func (c *claudeConn) Control(ctx context.Context, subtype string, fields map[string]any) (json.RawMessage, error) {
	id := uuid.NewString()
	req := map[string]any{"subtype": subtype}
	for k, v := range fields {
		req[k] = v
	}
	ch := make(chan controlReply, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("claude is not running")
	}
	c.controls[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.controls, id)
		c.mu.Unlock()
	}()
	if err := c.writeJSON(map[string]any{"type": "control_request", "request_id": id, "request": req}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.raw, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *claudeConn) Close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.cancel()
}

// handle processes one stdout line.
func (c *claudeConn) handle(line []byte) {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	switch l.Type {
	case "control_response":
		c.handleControlResponse(l.Response)
		return
	case "control_request":
		c.handleControlRequest(l.RequestID, l.Request)
		return
	case "control_cancel_request":
		c.emit(Event{Kind: EventPermissionCancel, RequestID: l.RequestID})
		return
	case "user":
		if l.IsReplay {
			c.mu.Lock()
			mine := c.inputs[l.UUID]
			delete(c.inputs, l.UUID)
			prev := c.lastUUID
			if mine {
				c.lastUUID = l.UUID
			}
			c.mu.Unlock()
			if mine {
				c.emit(Event{Kind: EventInputTaken, InputID: l.UUID, PrevUUID: prev})
			}
			return
		}
		c.track(l)
	case "assistant":
		c.track(l)
	case "system":
		if l.Subtype == "compact_boundary" {
			c.track(l)
		}
	}
	parseClaude(&l, c.emit)
	if l.Type == "result" {
		c.mu.Lock()
		last := c.lastUUID
		c.mu.Unlock()
		c.emit(Event{Kind: EventTurnEnd, LastUUID: last})
	}
}

// track records an entry of the main conversation (not a subagent's).
func (c *claudeConn) track(l claudeLine) {
	if l.UUID == "" || l.ParentToolUseID != nil {
		return
	}
	c.mu.Lock()
	c.lastUUID = l.UUID
	c.mu.Unlock()
}

func (c *claudeConn) handleControlResponse(raw json.RawMessage) {
	var r struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response"`
		Error     string          `json:"error"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	c.mu.Lock()
	ch := c.controls[r.RequestID]
	delete(c.controls, r.RequestID)
	c.mu.Unlock()
	if ch == nil {
		return
	}
	if r.Subtype == "error" {
		ch <- controlReply{err: errors.New(r.Error)}
	} else {
		ch <- controlReply{raw: r.Response}
	}
}

// handleControlRequest answers requests the CLI sends us. Permission prompts and MCP
// elicitations go to the user; anything else we can't serve is refused so the CLI doesn't wait.
func (c *claudeConn) handleControlRequest(id string, raw json.RawMessage) {
	var r struct {
		Subtype                 string          `json:"subtype"`
		ToolName                string          `json:"tool_name"`
		DisplayName             string          `json:"display_name"`
		Input                   json.RawMessage `json:"input"`
		Suggestions             json.RawMessage `json:"permission_suggestions"`
		BlockedPath             string          `json:"blocked_path"`
		DecisionReason          string          `json:"decision_reason"`
		Title                   string          `json:"title"`
		Description             string          `json:"description"`
		ToolUseID               string          `json:"tool_use_id"`
		AgentID                 string          `json:"agent_id"`
		SuppressAlwaysAllowRule bool            `json:"suppress_always_allow_rule"`
		// elicitation
		MCPServerName   string          `json:"mcp_server_name"`
		Message         string          `json:"message"`
		Mode            string          `json:"mode"`
		URL             string          `json:"url"`
		RequestedSchema json.RawMessage `json:"requested_schema"`
		PropertyOrder   []string        `json:"property_order"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	if r.Subtype == "elicitation" {
		mode := r.Mode
		if mode == "" {
			mode = "form"
		}
		c.emit(Event{Kind: EventPermission, Permission: &Permission{RequestID: id, ToolName: "MCP input",
			Title: r.Title, Description: r.Description, Elicitation: &Elicitation{
				Server: cmp.Or(r.DisplayName, r.MCPServerName), Message: r.Message, Mode: mode, URL: r.URL,
				Schema: string(r.RequestedSchema), Order: r.PropertyOrder,
			}}})
		return
	}
	if r.Subtype != "can_use_tool" {
		_ = c.writeJSON(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": id, "error": "not supported by this client: " + r.Subtype,
		}})
		return
	}
	p := &Permission{RequestID: id, ToolName: r.ToolName, ToolID: r.ToolUseID, Input: string(r.Input),
		Title: r.Title, Description: r.Description, Reason: stripANSI(r.DecisionReason), BlockedPath: r.BlockedPath,
		Suggestions: r.Suggestions, AgentID: r.AgentID, Feedback: true}
	if label := suggestionLabel(r.Suggestions); label != "" && !r.SuppressAlwaysAllowRule {
		p.CanAlways, p.AlwaysLabel = true, label
	}
	c.emit(Event{Kind: EventPermission, Permission: p})
}

// suggestionLabel describes the rules "allow always" would add, e.g. "Bash(npm test:*)".
func suggestionLabel(raw json.RawMessage) string {
	var list []struct {
		Type  string `json:"type"`
		Mode  string `json:"mode"`
		Rules []struct {
			ToolName    string `json:"toolName"`
			RuleContent string `json:"ruleContent"`
		} `json:"rules"`
		Directories []string `json:"directories"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return ""
	}
	var bits []string
	for _, s := range list {
		switch s.Type {
		case "addRules":
			for _, r := range s.Rules {
				if r.RuleContent != "" {
					bits = append(bits, r.ToolName+"("+r.RuleContent+")")
				} else {
					bits = append(bits, r.ToolName)
				}
			}
		case "setMode":
			if m := harnessMode(s.Mode); m == ModeEdits {
				bits = append(bits, "all edits this session")
			}
		case "addDirectories":
			for _, d := range s.Directories {
				bits = append(bits, "access to "+d)
			}
		}
	}
	return strings.Join(bits, ", ")
}

// stripANSI removes terminal escape sequences from text shown in the UI.
func stripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && (s[j] < 0x40 || s[j] > 0x7e) {
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

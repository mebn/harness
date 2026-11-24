package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"harness/server/internal/platform"
)

// copilotConn is one `copilot --acp` process holding a conversation. It speaks the Agent
// Client Protocol (JSON-RPC 2.0 over stdio), which, unlike prompt mode, lets Copilot ask
// before using tools.
type copilotConn struct {
	ctx    context.Context
	cancel context.CancelFunc
	env    platform.Env
	ids    *copilotSessions
	events chan Event
	writes chan []byte
	done   chan struct{}
	// ready closes once the session is open (readyErr says whether that failed).
	ready    chan struct{}
	readyErr error

	mu        sync.Mutex
	sessionID string // Copilot's id for the conversation
	nextID    int
	calls     map[string]chan rpcReply
	// loading is true while session/load replays the history (not shown again).
	loading  bool
	settings Settings
	// options holds each config option's current value and the values it takes.
	options map[string]*acpOption
	running bool // a prompt is in flight
	// applying counts settings being applied: mode updates then are our own doing.
	applying int
	perms    map[string]*acpPermission
	tools    map[string]*acpToolCall
	closed   bool
}

type rpcReply struct {
	raw json.RawMessage
	err error
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type acpOption struct {
	current string
	values  map[string]bool
}

type acpPermission struct {
	rawID   json.RawMessage
	options []acpPermissionOption
}

type acpPermissionOption struct {
	OptionID string `json:"optionId"`
	Kind     string `json:"kind"` // allow_once | allow_always | reject_once | reject_always
	Name     string `json:"name"`
}

// acpToolCall is a tool call as the agent last described it (updates carry only changes).
type acpToolCall struct {
	ID       string           `json:"toolCallId"`
	Title    string           `json:"title"`
	Kind     string           `json:"kind"`
	Status   string           `json:"status"`
	RawInput json.RawMessage  `json:"rawInput"`
	Content  []acpToolContent `json:"content"`
	Output   json.RawMessage  `json:"rawOutput"`
	started  bool
	ended    bool
}

type acpToolContent struct {
	Type    string `json:"type"` // content | diff | terminal
	Path    string `json:"path"`
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
	Content *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// Copilot's session modes, as config option values.
const (
	acpModeAgent = "https://agentclientprotocol.com/protocol/session-modes#agent"
	acpModePlan  = "https://agentclientprotocol.com/protocol/session-modes#plan"
)

func openCopilotConn(parent context.Context, req OpenRequest, ids *copilotSessions) (*copilotConn, error) {
	ctx, cancel := context.WithCancel(parent)
	c := &copilotConn{ctx: ctx, cancel: cancel, env: req.Env, ids: ids, events: make(chan Event, 256),
		writes: make(chan []byte, 64), done: make(chan struct{}), ready: make(chan struct{}),
		settings: req.Settings, calls: map[string]chan rpcReply{}, options: map[string]*acpOption{},
		perms: map[string]*acpPermission{}, tools: map[string]*acpToolCall{}}
	cmd, err := platform.AgentCommand(ctx, req.Env, req.Dir, req.Admin, "copilot", "--acp")
	if err != nil {
		cancel()
		return nil, err
	}
	if err := c.start(cmd); err != nil {
		cancel()
		return nil, err
	}
	// Opening the session takes a few seconds; turns wait for it.
	go func() {
		c.readyErr = c.handshake(req)
		close(c.ready)
	}()
	return c, nil
}

func (c *copilotConn) start(cmd *exec.Cmd) error {
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
		return fmt.Errorf("start copilot: %w", err)
	}
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
		for id, ch := range c.calls {
			ch <- rpcReply{err: errors.New("copilot exited")}
			delete(c.calls, id)
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

// handshake initializes the agent and opens (or resumes) the session with our settings.
func (c *copilotConn) handshake(req OpenRequest) error {
	ctx, cancel := context.WithTimeout(c.ctx, 2*time.Minute)
	defer cancel()
	_, err := c.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{
		"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false,
	}})
	if err != nil {
		return fmt.Errorf("start copilot: %w", err)
	}
	cwd := platform.PathFor(req.Env, req.Dir)
	var raw json.RawMessage
	if req.Resume {
		// Sessions from before ACP were created with our id; newer ones have Copilot's own.
		id := c.ids.get(req.SessionID)
		if id == "" {
			id = req.SessionID
		}
		c.mu.Lock()
		c.sessionID, c.loading = id, true
		c.mu.Unlock()
		raw, err = c.call(ctx, "session/load", map[string]any{"sessionId": id, "cwd": cwd, "mcpServers": []any{}})
		c.mu.Lock()
		c.loading = false
		c.tools = map[string]*acpToolCall{}
		c.mu.Unlock()
		if err != nil {
			return fmt.Errorf("resume the Copilot conversation: %w", err)
		}
	} else {
		raw, err = c.call(ctx, "session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}})
		if err != nil {
			return fmt.Errorf("start a Copilot conversation: %w", err)
		}
		var r struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(raw, &r) != nil || r.SessionID == "" {
			return errors.New("copilot didn't return a session id")
		}
		c.mu.Lock()
		c.sessionID = r.SessionID
		c.mu.Unlock()
		c.ids.set(req.SessionID, r.SessionID)
	}
	c.recordOptions(raw)
	c.mu.Lock()
	s := c.settings
	c.mu.Unlock()
	return c.applySettings(ctx, s)
}

// recordOptions keeps the config options a response or update reports.
func (c *copilotConn) recordOptions(raw json.RawMessage) {
	var r struct {
		ConfigOptions []struct {
			ID           string `json:"id"`
			CurrentValue string `json:"currentValue"`
			Options      []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"configOptions"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, o := range r.ConfigOptions {
		opt := &acpOption{current: o.CurrentValue, values: map[string]bool{}}
		for _, v := range o.Options {
			opt.values[v.Value] = true
		}
		c.options[o.ID] = opt
	}
}

// copilotModelIDs maps model ids Harness used to list for Copilot to Copilot's own.
var copilotModelIDs = map[string]string{"claude-opus-5-5": "claude-opus-5.5", "claude-sonnet-5-5": "claude-sonnet-5.5"}

// applySettings sets the config options the settings map to, where they differ.
func (c *copilotConn) applySettings(ctx context.Context, s Settings) error {
	model := s.Model
	if m, ok := copilotModelIDs[model]; ok {
		model = m
	}
	mode, allowAll := acpModeAgent, "off"
	switch s.Mode {
	case ModePlan:
		mode = acpModePlan
	case ModeFull:
		allowAll = "on"
	}
	want := [][2]string{{"model", model}}
	// "auto" picks the model per request and has no effort setting.
	if s.Effort != "" && model != "auto" {
		want = append(want, [2]string{"reasoning_effort", s.Effort})
	}
	want = append(want, [2]string{"mode", mode}, [2]string{"allow_all", allowAll})

	c.mu.Lock()
	c.applying++
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.applying--
		c.mu.Unlock()
	}()
	var errs []error
	for _, w := range want {
		id, value := w[0], w[1]
		c.mu.Lock()
		opt := c.options[id]
		skip := value == "" || opt == nil || opt.current == value
		known := opt != nil && opt.values[value]
		sid := c.sessionID
		c.mu.Unlock()
		if skip {
			continue
		}
		if !known {
			errs = append(errs, fmt.Errorf("copilot doesn't offer %s %q", strings.ReplaceAll(id, "_", " "), value))
			continue
		}
		raw, err := c.call(ctx, "session/set_config_option", map[string]any{"sessionId": sid, "configId": id, "value": value})
		if err != nil {
			errs = append(errs, fmt.Errorf("set copilot %s: %w", id, err))
			continue
		}
		c.recordOptions(raw)
	}
	return errors.Join(errs...)
}

func (c *copilotConn) Events() <-chan Event { return c.events }

func (c *copilotConn) emit(e Event) {
	select {
	case c.events <- e:
	case <-c.done:
	}
}

func (c *copilotConn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	select {
	case c.writes <- append(b, '\n'):
		return nil
	case <-c.ctx.Done():
		return errors.New("copilot is not running")
	}
}

// call sends a request and waits for its response.
func (c *copilotConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	ch := make(chan rpcReply, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("copilot is not running")
	}
	c.nextID++
	id := c.nextID
	c.calls[strconv.Itoa(id)] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.calls, strconv.Itoa(id))
		c.mu.Unlock()
	}()
	if err := c.writeJSON(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.raw, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *copilotConn) notify(method string, params any) error {
	return c.writeJSON(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *copilotConn) reply(id json.RawMessage, result any) {
	_ = c.writeJSON(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// handle processes one stdout line.
func (c *copilotConn) handle(line []byte) {
	var m rpcMessage
	if json.Unmarshal(line, &m) != nil {
		return
	}
	switch {
	case m.Method != "" && len(m.ID) > 0:
		c.handleRequest(m)
	case m.Method == "session/update":
		c.handleUpdate(m.Params)
	case m.Method == "" && len(m.ID) > 0:
		c.mu.Lock()
		ch := c.calls[string(m.ID)]
		delete(c.calls, string(m.ID))
		c.mu.Unlock()
		if ch == nil {
			return
		}
		if m.Error != nil {
			ch <- rpcReply{err: errors.New(m.Error.Message)}
		} else {
			ch <- rpcReply{raw: m.Result}
		}
	}
}

// handleRequest answers requests the agent sends us. Permission prompts go to the user;
// we declared no file system or terminal access, so anything else is refused.
func (c *copilotConn) handleRequest(m rpcMessage) {
	if m.Method != "session/request_permission" {
		_ = c.writeJSON(map[string]any{"jsonrpc": "2.0", "id": m.ID,
			"error": rpcError{Code: -32601, Message: "method not supported: " + m.Method}})
		return
	}
	var p struct {
		ToolCall acpToolCall           `json:"toolCall"`
		Options  []acpPermissionOption `json:"options"`
	}
	if json.Unmarshal(m.Params, &p) != nil {
		c.reply(m.ID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
		return
	}
	perm := &acpPermission{rawID: m.ID, options: p.Options}
	c.mu.Lock()
	tool := c.mergeTool(&p.ToolCall)
	editsOK := c.settings.Mode == ModeEdits && tool.Kind == "edit"
	c.mu.Unlock()
	if editsOK {
		if opt := perm.pick("allow_once", "allow_always"); opt != "" {
			c.reply(m.ID, selected(opt))
			return
		}
	}
	key := "acp-" + string(m.ID)
	c.mu.Lock()
	c.perms[key] = perm
	c.mu.Unlock()
	name, args := toolView(tool)
	input, _ := json.Marshal(args)
	desc := tool.Title
	if p.ToolCall.Title != "" {
		desc = p.ToolCall.Title
	}
	ev := &Permission{RequestID: key, ToolName: name, ToolID: tool.ID, Input: string(input), Description: desc}
	if perm.pick("allow_always") != "" {
		// Respond sees these in updatedPermissions when the user picks "always".
		ev.CanAlways, ev.Suggestions = true, json.RawMessage(`[{"type":"acp","kind":"allow_always"}]`)
	}
	c.emit(Event{Kind: EventPermission, Permission: ev})
}

// pick returns the id of the first option of one of these kinds.
func (p *acpPermission) pick(kinds ...string) string {
	for _, k := range kinds {
		for _, o := range p.options {
			if o.Kind == k {
				return o.OptionID
			}
		}
	}
	return ""
}

func selected(optionID string) map[string]any {
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}
}

// mergeTool folds a tool call (or an update to one) into what we know; c.mu held.
func (c *copilotConn) mergeTool(u *acpToolCall) *acpToolCall {
	t := c.tools[u.ID]
	if t == nil {
		t = &acpToolCall{ID: u.ID}
		c.tools[u.ID] = t
	}
	if u.Title != "" {
		t.Title = u.Title
	}
	if u.Kind != "" {
		t.Kind = u.Kind
	}
	if u.Status != "" {
		t.Status = u.Status
	}
	if len(u.RawInput) > 0 && t.RawInput == nil {
		t.RawInput = u.RawInput
	}
	if len(u.Content) > 0 {
		t.Content = u.Content
	}
	if len(u.Output) > 0 {
		t.Output = u.Output
	}
	return t
}

func (c *copilotConn) handleUpdate(raw json.RawMessage) {
	var p struct {
		Update json.RawMessage `json:"update"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	// content is a text chunk for messages but a list for tool calls: decode it per kind.
	var u struct {
		Kind    string          `json:"sessionUpdate"`
		Content json.RawMessage `json:"content"`
		Used    int64           `json:"used"`
		Size    int64           `json:"size"`
	}
	if json.Unmarshal(p.Update, &u) != nil {
		return
	}
	c.mu.Lock()
	loading := c.loading
	c.mu.Unlock()
	switch u.Kind {
	case "config_option_update":
		c.recordOptions(p.Update)
		c.modeFromOptions()
		return
	case "usage_update":
		c.emit(Event{Kind: EventContext, ContextTokens: u.Used, ContextWindow: u.Size})
		return
	}
	if loading { // history being replayed
		return
	}
	switch u.Kind {
	case "agent_message_chunk", "agent_thought_chunk":
		var chunk struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(u.Content, &chunk) != nil || chunk.Type != "text" {
			return
		}
		kind := EventText
		if u.Kind == "agent_thought_chunk" {
			kind = EventThinking
		}
		c.emit(Event{Kind: kind, Text: chunk.Text})
	case "tool_call", "tool_call_update":
		var tc acpToolCall
		if json.Unmarshal(p.Update, &tc) != nil || tc.ID == "" {
			return
		}
		c.mu.Lock()
		t := c.mergeTool(&tc)
		start := !t.started
		end := !t.ended && (t.Status == "completed" || t.Status == "failed")
		t.started = true
		t.ended = t.ended || end
		snapshot := *t
		c.mu.Unlock()
		if start {
			name, args := toolView(&snapshot)
			b, _ := json.Marshal(args)
			c.emit(Event{Kind: EventToolStart, ToolID: snapshot.ID, ToolName: name,
				ToolInput: cmpString(snapshot.Title, summarizeInput(args)), ToolArgs: string(b)})
		}
		if end {
			c.emit(Event{Kind: EventToolEnd, ToolID: snapshot.ID, ToolOutput: toolOutput(&snapshot),
				IsError: snapshot.Status == "failed"})
		}
	}
}

// modeFromOptions reports a mode the agent switched to itself (e.g. leaving plan mode).
func (c *copilotConn) modeFromOptions() {
	c.mu.Lock()
	if c.applying > 0 || c.loading {
		c.mu.Unlock()
		return
	}
	mode, all := "", ""
	if o := c.options["mode"]; o != nil {
		mode = o.current
	}
	if o := c.options["allow_all"]; o != nil {
		all = o.current
	}
	cur := c.settings.Mode
	next := cur
	switch {
	case mode == "":
	case mode == acpModePlan:
		next = ModePlan
	case all == "on" || mode != acpModeAgent: // autopilot runs with everything allowed
		next = ModeFull
	case cur == ModePlan || cur == ModeFull:
		next = ModeAsk
	}
	changed := next != cur
	c.settings.Mode = next
	c.mu.Unlock()
	if changed {
		c.emit(Event{Kind: EventMode, Mode: next})
	}
}

func cmpString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// toolView names a tool call and shapes its input the way the transcript shows Claude's
// tools: shell commands as commands, edits as diffs.
func toolView(t *acpToolCall) (string, map[string]any) {
	args := map[string]any{}
	_ = json.Unmarshal(t.RawInput, &args)
	switch t.Kind {
	case "execute":
		return "Shell", args
	case "edit", "delete", "move":
		for _, ct := range t.Content {
			if ct.Type != "diff" {
				continue
			}
			if ct.OldText == "" {
				return "Write", map[string]any{"file_path": ct.Path, "content": ct.NewText}
			}
			return "Edit", map[string]any{"file_path": ct.Path, "old_string": ct.OldText, "new_string": ct.NewText}
		}
		return "Edit", args
	case "read":
		return "Read", args
	case "search":
		return "Search", args
	case "fetch":
		return "WebFetch", args
	case "think":
		return "Think", args
	}
	if t.Title != "" {
		return t.Title, args
	}
	return "Tool", args
}

// toolOutput is a finished tool call's result as text.
func toolOutput(t *acpToolCall) string {
	var out struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(t.Output, &out) == nil && out.Content != "" {
		return truncate(out.Content, maxToolOutput)
	}
	var sb strings.Builder
	for _, ct := range t.Content {
		if ct.Type == "content" && ct.Content != nil && ct.Content.Type == "text" {
			sb.WriteString(ct.Content.Text)
		}
	}
	return truncate(sb.String(), maxToolOutput)
}

func (c *copilotConn) Send(in Input) error {
	c.mu.Lock()
	switch {
	case c.closed:
		c.mu.Unlock()
		return errors.New("conversation closed")
	case c.running:
		c.mu.Unlock()
		return errors.New("a turn is already running")
	}
	c.running = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.cancelPermissions()
			c.mu.Lock()
			c.running = false
			c.mu.Unlock()
			c.emit(Event{Kind: EventTurnEnd})
		}()
		c.emit(Event{Kind: EventInputTaken, InputID: in.ID})
		select {
		case <-c.ready:
		case <-c.ctx.Done():
			return
		}
		if c.readyErr != nil {
			c.emit(Event{Kind: EventError, Text: c.readyErr.Error()})
			return
		}
		blocks, err := c.promptBlocks(in)
		if err != nil {
			c.emit(Event{Kind: EventError, Text: err.Error()})
			return
		}
		c.mu.Lock()
		sid := c.sessionID
		c.mu.Unlock()
		raw, err := c.call(c.ctx, "session/prompt", map[string]any{"sessionId": sid, "prompt": blocks})
		if err != nil {
			if c.ctx.Err() == nil {
				c.emit(Event{Kind: EventError, Text: err.Error()})
			}
			return
		}
		var r struct {
			StopReason string `json:"stopReason"`
		}
		_ = json.Unmarshal(raw, &r)
		switch r.StopReason {
		case "refusal":
			c.emit(Event{Kind: EventError, Text: "Copilot refused to continue."})
		case "max_tokens":
			c.emit(Event{Kind: EventError, Text: "Copilot hit its output limit."})
		case "max_turn_requests":
			c.emit(Event{Kind: EventError, Text: "Copilot hit its limit of requests for one turn."})
		}
	}()
	return nil
}

// promptBlocks is a message as ACP content: the text, images inline, other files as links.
func (c *copilotConn) promptBlocks(in Input) ([]any, error) {
	blocks := []any{map[string]any{"type": "text", "text": in.Prompt}}
	for _, a := range in.Attachments {
		if a.IsImage {
			data, err := os.ReadFile(a.Path)
			if err != nil {
				return nil, fmt.Errorf("read attachment %s: %w", a.Name, err)
			}
			blocks = append(blocks, map[string]any{"type": "image", "mimeType": a.MimeType,
				"data": base64.StdEncoding.EncodeToString(data)})
			continue
		}
		p := filepath.ToSlash(platform.PathFor(c.env, a.Path))
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		link := map[string]any{"type": "resource_link", "uri": (&url.URL{Scheme: "file", Path: p}).String(), "name": a.Name}
		if a.MimeType != "" {
			link["mimeType"] = a.MimeType
		}
		blocks = append(blocks, link)
	}
	return blocks, nil
}

func (c *copilotConn) Apply(s Settings) error {
	c.mu.Lock()
	c.settings = s
	c.mu.Unlock()
	select {
	case <-c.ready:
	default:
		return nil // the handshake applies the latest settings
	}
	if c.readyErr != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	return c.applySettings(ctx, s)
}

func (c *copilotConn) Interrupt() error {
	c.mu.Lock()
	sid, running := c.sessionID, c.running
	c.mu.Unlock()
	c.cancelPermissions()
	if !running || sid == "" {
		return nil
	}
	return c.notify("session/cancel", map[string]any{"sessionId": sid})
}

// cancelPermissions withdraws open permission requests (the turn is over or stopping).
func (c *copilotConn) cancelPermissions() {
	c.mu.Lock()
	perms := c.perms
	c.perms = map[string]*acpPermission{}
	c.mu.Unlock()
	for key, p := range perms {
		c.reply(p.rawID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
		c.emit(Event{Kind: EventPermissionCancel, RequestID: key})
	}
}

// Respond answers a permission request. result is shaped like Claude Code's answer:
// {behavior: "allow"|"deny", updatedPermissions (when "always"), interrupt}.
func (c *copilotConn) Respond(requestID string, result map[string]any) error {
	c.mu.Lock()
	p := c.perms[requestID]
	delete(c.perms, requestID)
	c.mu.Unlock()
	if p == nil {
		return errors.New("this request is no longer open")
	}
	var opt string
	if result["behavior"] == "allow" {
		if _, always := result["updatedPermissions"]; always {
			opt = p.pick("allow_always", "allow_once")
		} else {
			opt = p.pick("allow_once", "allow_always")
		}
	} else {
		opt = p.pick("reject_once", "reject_always")
	}
	if opt == "" {
		c.reply(p.rawID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
	} else {
		c.reply(p.rawID, selected(opt))
	}
	if result["interrupt"] == true {
		return c.Interrupt()
	}
	return nil
}

func (c *copilotConn) Control(context.Context, string, map[string]any) (json.RawMessage, error) {
	return nil, ErrUnsupported
}

func (c *copilotConn) Close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.cancel()
}

// copilotSessions maps Harness's provider session ids to Copilot's: ACP picks the id of a
// new session itself. It's kept in a JSON file so conversations resume after a restart.
type copilotSessions struct {
	path string // "" keeps the map in memory only
	mu   sync.Mutex
	m    map[string]string
}

func newCopilotSessions(path string) *copilotSessions {
	s := &copilotSessions{path: path, m: map[string]string{}}
	if path != "" {
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &s.m)
		}
	}
	return s
}

func (s *copilotSessions) get(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[id]
}

func (s *copilotSessions) set(id, copilotID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[id] = copilotID
	if s.path == "" {
		return
	}
	b, _ := json.MarshalIndent(s.m, "", "  ")
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

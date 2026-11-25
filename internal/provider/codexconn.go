package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"harness/internal/platform"
	"harness/internal/usage"
)

// codexConn is one `codex app-server` process holding a conversation (a Codex thread). It
// speaks the app server's JSON-RPC protocol over stdio: turns start with turn/start, run as
// item notifications, and end with turn/completed; Codex asks before running commands or
// changing files through requests we answer.
type codexConn struct {
	ctx    context.Context
	cancel context.CancelFunc
	env    platform.Env
	ids    *copilotSessions
	events chan Event
	writes chan []byte
	done   chan struct{}
	// ready closes once the thread is open (readyErr says whether that failed).
	ready    chan struct{}
	readyErr error

	mu       sync.Mutex
	threadID string
	model    string // the thread's model, as Codex reported it
	nextID   int
	calls    map[string]chan rpcReply
	settings Settings
	running  bool
	turnID   string        // the running turn, once Codex reported it
	turnDone chan struct{} // closes when the running turn completes
	planMode bool          // the last turn ran in Codex's plan mode
	perms    map[string]*codexRequest
	items    map[string]*codexItem // tool items started this turn
	streamed map[string]bool       // items whose text arrived as deltas
	lastText bool                  // the last thing shown was reply text
	sep      bool                  // the next text starts a new message
	plans    int
	closed   bool
}

// codexRequest is a request from Codex waiting for the user's answer.
type codexRequest struct {
	rawID     json.RawMessage
	kind      string // command | file | input | elicitation
	questions []codexQuestion
}

type codexQuestion struct {
	ID       string `json:"id"`
	Header   string `json:"header"`
	Question string `json:"question"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}

// codexItem is a thread item (ThreadItem in the protocol); fields by type.
type codexItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	// agentMessage, plan
	Text string `json:"text"`
	// reasoning
	Summary []string `json:"summary"`
	// commandExecution
	Command          string `json:"command"`
	AggregatedOutput string `json:"aggregatedOutput"`
	ExitCode         *int   `json:"exitCode"`
	Status           string `json:"status"`
	// fileChange
	Changes []codexChange `json:"changes"`
	// mcpToolCall, dynamicToolCall
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Result    *struct {
		Content []json.RawMessage `json:"content"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	ContentItems []json.RawMessage `json:"contentItems"`
	Success      *bool             `json:"success"`
	// webSearch
	Query string `json:"query"`
	// imageView
	Path string `json:"path"`

	started bool
}

type codexChange struct {
	Path string `json:"path"`
	Kind struct {
		Type     string `json:"type"` // add | delete | update
		MovePath string `json:"move_path"`
	} `json:"kind"`
	Diff string `json:"diff"`
}

type codexRateLimits struct {
	Primary   *codexRateWindow `json:"primary"`
	Secondary *codexRateWindow `json:"secondary"`
}

type codexRateWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins *int64  `json:"windowDurationMins"`
	ResetsAt           *int64  `json:"resetsAt"` // unix seconds
}

func openCodexConn(parent context.Context, req OpenRequest, ids *copilotSessions) (*codexConn, error) {
	ctx, cancel := context.WithCancel(parent)
	c := &codexConn{ctx: ctx, cancel: cancel, env: req.Env, ids: ids, events: make(chan Event, 256),
		writes: make(chan []byte, 64), done: make(chan struct{}), ready: make(chan struct{}),
		settings: req.Settings, calls: map[string]chan rpcReply{}, perms: map[string]*codexRequest{},
		items: map[string]*codexItem{}, streamed: map[string]bool{}}
	cmd, err := platform.AgentCommand(ctx, req.Env, req.Dir, req.Admin, "codex", "app-server")
	if err != nil {
		cancel()
		return nil, err
	}
	if err := c.start(cmd); err != nil {
		cancel()
		return nil, err
	}
	go func() {
		c.readyErr = c.handshake(req)
		close(c.ready)
	}()
	return c, nil
}

func (c *codexConn) start(cmd *exec.Cmd) error {
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
		return fmt.Errorf("start codex: %w", err)
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
			ch <- rpcReply{err: errors.New("codex exited")}
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

// handshake initializes the app server and starts (or resumes) the thread.
func (c *codexConn) handshake(req OpenRequest) error {
	ctx, cancel := context.WithTimeout(c.ctx, 2*time.Minute)
	defer cancel()
	// experimentalApi gives turn/start its collaborationMode (plan mode).
	_, err := c.call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "harness", "title": "Harness", "version": "1.0.0"},
		"capabilities": map[string]any{"experimentalApi": true, "requestAttestation": false},
	})
	if err != nil {
		return fmt.Errorf("start codex: %w", err)
	}
	if err := c.notify("initialized", nil); err != nil {
		return err
	}
	c.mu.Lock()
	s := c.settings
	c.mu.Unlock()
	params := map[string]any{"cwd": platform.PathFor(req.Env, req.Dir), "approvalPolicy": codexApproval(s.Mode),
		"sandbox": codexSandboxMode(s.Mode)}
	if s.Model != "" {
		params["model"] = s.Model
	}
	var raw json.RawMessage
	if id := c.ids.get(req.SessionID); req.Resume && id != "" {
		params["threadId"] = id
		params["excludeTurns"] = true
		if raw, err = c.call(ctx, "thread/resume", params); err != nil {
			return fmt.Errorf("resume the Codex conversation: %w", err)
		}
	} else if raw, err = c.call(ctx, "thread/start", params); err != nil {
		return fmt.Errorf("start a Codex conversation: %w", err)
	}
	var r struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Model string `json:"model"`
	}
	if json.Unmarshal(raw, &r) != nil || r.Thread.ID == "" {
		return errors.New("codex didn't return a thread id")
	}
	c.mu.Lock()
	c.threadID, c.model = r.Thread.ID, r.Model
	c.mu.Unlock()
	c.ids.set(req.SessionID, r.Thread.ID)

	// Plan usage, for the usage indicator; Codex sends updates after each turn.
	if raw, err := c.call(ctx, "account/rateLimits/read", nil); err == nil {
		var rl struct {
			RateLimits codexRateLimits `json:"rateLimits"`
		}
		if json.Unmarshal(raw, &rl) == nil {
			c.emitUsage(rl.RateLimits)
		}
	}
	return nil
}

// Permission modes as Codex approval policies and sandboxes. Ask runs read-only, so every
// edit and every command that writes asks; Accept edits lets Codex write in the workspace.
func codexApproval(mode string) string {
	if mode == ModeFull {
		return "never"
	}
	return "on-request"
}

func codexSandboxMode(mode string) string {
	switch mode {
	case ModeFull:
		return "danger-full-access"
	case ModeEdits:
		return "workspace-write"
	}
	return "read-only"
}

func codexSandboxPolicy(mode string) map[string]any {
	switch mode {
	case ModeFull:
		return map[string]any{"type": "dangerFullAccess"}
	case ModeEdits:
		return map[string]any{"type": "workspaceWrite", "writableRoots": []string{}, "networkAccess": false,
			"excludeTmpdirEnvVar": false, "excludeSlashTmp": false}
	}
	return map[string]any{"type": "readOnly", "networkAccess": false}
}

func (c *codexConn) Events() <-chan Event { return c.events }

func (c *codexConn) emit(e Event) {
	select {
	case c.events <- e:
	case <-c.done:
	}
}

func (c *codexConn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	select {
	case c.writes <- append(b, '\n'):
		return nil
	case <-c.ctx.Done():
		return errors.New("codex is not running")
	}
}

// call sends a request and waits for its response.
func (c *codexConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	ch := make(chan rpcReply, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("codex is not running")
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
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.writeJSON(msg); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.raw, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *codexConn) notify(method string, params any) error {
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	return c.writeJSON(msg)
}

func (c *codexConn) reply(id json.RawMessage, result any) {
	_ = c.writeJSON(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// handle processes one stdout line.
func (c *codexConn) handle(line []byte) {
	var m rpcMessage
	if json.Unmarshal(line, &m) != nil {
		return
	}
	switch {
	case m.Method != "" && len(m.ID) > 0:
		c.handleRequest(m)
	case m.Method != "":
		c.handleNotification(m.Method, m.Params)
	case len(m.ID) > 0:
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

func (c *codexConn) handleNotification(method string, raw json.RawMessage) {
	var p struct {
		TurnID string    `json:"turnId"`
		ItemID string    `json:"itemId"`
		Delta  string    `json:"delta"`
		Item   codexItem `json:"item"`
		Turn   struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message           string `json:"message"`
				AdditionalDetails string `json:"additionalDetails"`
			} `json:"error"`
		} `json:"turn"`
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
		TokenUsage struct {
			Last struct {
				TotalTokens int64 `json:"totalTokens"`
			} `json:"last"`
			ModelContextWindow int64 `json:"modelContextWindow"`
		} `json:"tokenUsage"`
		RateLimits codexRateLimits `json:"rateLimits"`
		RequestID  json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	switch method {
	case "turn/started":
		c.mu.Lock()
		if c.running && c.turnID == "" {
			c.turnID = p.Turn.ID
		}
		c.mu.Unlock()
	case "turn/completed":
		if p.Turn.Status == "failed" && p.Turn.Error != nil {
			msg := p.Turn.Error.Message
			if d := p.Turn.Error.AdditionalDetails; d != "" {
				msg += "\n" + d
			}
			c.emit(Event{Kind: EventError, Text: msg})
		}
		c.mu.Lock()
		if c.turnDone != nil && (c.turnID == "" || c.turnID == p.Turn.ID) {
			close(c.turnDone)
			c.turnDone = nil
		}
		c.mu.Unlock()
	case "item/started":
		c.itemStarted(&p.Item)
	case "item/completed":
		c.itemCompleted(&p.Item)
	case "item/agentMessage/delta", "item/plan/delta":
		c.mu.Lock()
		c.streamed[p.ItemID] = true
		c.mu.Unlock()
		c.emitText(p.Delta)
	case "item/reasoning/summaryTextDelta":
		c.mu.Lock()
		c.streamed[p.ItemID] = true
		c.mu.Unlock()
		c.emit(Event{Kind: EventThinking, Text: p.Delta})
	case "turn/plan/updated":
		todos := make([]any, 0, len(p.Plan))
		for _, s := range p.Plan {
			status := map[string]string{"inProgress": "in_progress"}[s.Status]
			if status == "" {
				status = s.Status
			}
			todos = append(todos, map[string]any{"content": s.Step, "activeForm": s.Step, "status": status})
		}
		args := map[string]any{"todos": todos}
		b, _ := json.Marshal(args)
		c.mu.Lock()
		c.plans++
		id := fmt.Sprintf("plan-%s-%d", p.TurnID, c.plans)
		c.lastText = false
		c.mu.Unlock()
		c.emit(Event{Kind: EventToolStart, ToolID: id, ToolName: "TodoWrite", ToolInput: summarizeInput(args), ToolArgs: string(b)})
		c.emit(Event{Kind: EventToolEnd, ToolID: id})
	case "thread/tokenUsage/updated":
		c.emit(Event{Kind: EventContext, ContextTokens: p.TokenUsage.Last.TotalTokens, ContextWindow: p.TokenUsage.ModelContextWindow})
	case "account/rateLimits/updated":
		c.emitUsage(p.RateLimits)
	case "serverRequest/resolved":
		// Codex settled a request itself (e.g. the turn was interrupted).
		key := "codex-" + string(p.RequestID)
		c.mu.Lock()
		_, open := c.perms[key]
		delete(c.perms, key)
		c.mu.Unlock()
		if open {
			c.emit(Event{Kind: EventPermissionCancel, RequestID: key})
		}
	}
}

// emitText shows reply text, starting a new paragraph for a new message.
func (c *codexConn) emitText(s string) {
	if s == "" {
		return
	}
	c.mu.Lock()
	if c.sep {
		s, c.sep = "\n\n"+s, false
	}
	c.lastText = true
	c.mu.Unlock()
	c.emit(Event{Kind: EventText, Text: s})
}

func (c *codexConn) itemStarted(it *codexItem) {
	switch it.Type {
	case "agentMessage", "plan":
		c.mu.Lock()
		c.sep = c.sep || c.lastText
		c.mu.Unlock()
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall":
		c.toolStart(it)
	}
}

func (c *codexConn) itemCompleted(it *codexItem) {
	c.mu.Lock()
	streamed := c.streamed[it.ID]
	delete(c.streamed, it.ID)
	c.mu.Unlock()
	switch it.Type {
	case "agentMessage", "plan":
		if !streamed {
			c.emitText(it.Text)
		}
	case "reasoning":
		if !streamed && len(it.Summary) > 0 {
			c.emit(Event{Kind: EventThinking, Text: strings.Join(it.Summary, "\n\n")})
		}
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView":
		c.toolStart(it) // no-op when it already started
		c.toolEnd(it)
	case "contextCompaction":
		c.emit(Event{Kind: EventCompact, Text: "auto"})
	}
}

// toolStart shows a tool item starting (file changes as one call per file).
func (c *codexConn) toolStart(it *codexItem) {
	c.mu.Lock()
	known := c.items[it.ID]
	if known != nil && known.started {
		c.mu.Unlock()
		return
	}
	cp := *it
	cp.started = true
	c.items[it.ID] = &cp
	c.lastText = false
	c.mu.Unlock()
	for _, v := range codexToolViews(it) {
		b, _ := json.Marshal(v.args)
		c.emit(Event{Kind: EventToolStart, ToolID: v.id, ToolName: v.name, ToolInput: summarizeInput(v.args), ToolArgs: string(b)})
	}
}

func (c *codexConn) toolEnd(it *codexItem) {
	c.mu.Lock()
	delete(c.items, it.ID)
	c.mu.Unlock()
	failed := it.Status == "failed" || it.Status == "declined"
	out := ""
	switch it.Type {
	case "commandExecution":
		out = it.AggregatedOutput
		failed = failed || (it.ExitCode != nil && *it.ExitCode != 0)
	case "mcpToolCall":
		if it.Error != nil {
			out, failed = it.Error.Message, true
		} else if it.Result != nil {
			out = codexContentText(it.Result.Content)
		}
	case "dynamicToolCall":
		out = codexContentText(it.ContentItems)
		failed = failed || (it.Success != nil && !*it.Success)
	}
	if it.Status == "declined" && out == "" {
		out = "Declined."
	}
	for _, v := range codexToolViews(it) {
		c.emit(Event{Kind: EventToolEnd, ToolID: v.id, ToolOutput: truncate(out, maxToolOutput), IsError: failed})
	}
}

type codexToolView struct {
	id   string
	name string
	args map[string]any
}

// codexToolViews names a tool item and shapes its input the way the transcript shows
// Claude's tools: commands as Shell, file changes as Write/Edit.
func codexToolViews(it *codexItem) []codexToolView {
	switch it.Type {
	case "commandExecution":
		return []codexToolView{{it.ID, "Shell", map[string]any{"command": it.Command}}}
	case "fileChange":
		views := make([]codexToolView, 0, len(it.Changes))
		for i, ch := range it.Changes {
			id := it.ID
			if i > 0 {
				id = fmt.Sprintf("%s#%d", it.ID, i)
			}
			name, args := codexChangeView(ch)
			views = append(views, codexToolView{id, name, args})
		}
		return views
	case "mcpToolCall":
		args := map[string]any{}
		_ = json.Unmarshal(it.Arguments, &args)
		return []codexToolView{{it.ID, "mcp__" + it.Server + "__" + it.Tool, args}}
	case "dynamicToolCall":
		args := map[string]any{}
		_ = json.Unmarshal(it.Arguments, &args)
		return []codexToolView{{it.ID, it.Tool, args}}
	case "webSearch":
		return []codexToolView{{it.ID, "WebSearch", map[string]any{"query": it.Query}}}
	case "imageView":
		return []codexToolView{{it.ID, "Read", map[string]any{"file_path": it.Path}}}
	}
	return nil
}

// codexChangeView is one file change as a Write (new file) or Edit (the diff's old and new lines).
func codexChangeView(ch codexChange) (string, map[string]any) {
	switch ch.Kind.Type {
	case "add":
		return "Write", map[string]any{"file_path": ch.Path, "content": ch.Diff}
	case "delete":
		return "Delete", map[string]any{"file_path": ch.Path}
	}
	oldText, newText := splitUnifiedDiff(ch.Diff)
	args := map[string]any{"file_path": ch.Path, "old_string": oldText, "new_string": newText}
	if ch.Kind.MovePath != "" {
		args["move_to"] = ch.Kind.MovePath
	}
	return "Edit", args
}

// splitUnifiedDiff turns a unified diff into the text before and after it (context lines in both).
func splitUnifiedDiff(diff string) (string, string) {
	var oldB, newB strings.Builder
	for _, l := range strings.SplitAfter(diff, "\n") {
		switch {
		case l == "", strings.HasPrefix(l, "@@"), strings.HasPrefix(l, "---"), strings.HasPrefix(l, "+++"),
			strings.HasPrefix(l, "diff "), strings.HasPrefix(l, "index "), strings.HasPrefix(l, `\`):
		case l[0] == '-':
			oldB.WriteString(l[1:])
		case l[0] == '+':
			newB.WriteString(l[1:])
		case l[0] == ' ':
			oldB.WriteString(l[1:])
			newB.WriteString(l[1:])
		default:
			oldB.WriteString(l)
			newB.WriteString(l)
		}
	}
	return oldB.String(), newB.String()
}

// codexContentText joins the text parts of MCP-style content.
func codexContentText(parts []json.RawMessage) string {
	var sb strings.Builder
	for _, raw := range parts {
		var p struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &p) == nil && p.Text != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

func (c *codexConn) emitUsage(rl codexRateLimits) {
	snap := usage.Snapshot{Provider: "codex", UpdatedAt: time.Now().UnixMilli()}
	for _, w := range []*codexRateWindow{rl.Primary, rl.Secondary} {
		if w == nil {
			continue
		}
		var mins int64
		if w.WindowDurationMins != nil {
			mins = *w.WindowDurationMins
		}
		id, label := codexWindowName(mins)
		win := usage.Window{ID: id, Label: label, Used: w.UsedPercent / 100}
		if w.ResetsAt != nil {
			win.ResetsAt = *w.ResetsAt * 1000
		}
		snap.Windows = append(snap.Windows, win)
	}
	if len(snap.Windows) > 0 {
		c.emit(Event{Kind: EventUsage, Usage: &snap})
	}
}

// codexWindowName names a rate-limit window by its length, like Claude's windows.
func codexWindowName(mins int64) (string, string) {
	switch {
	case mins == 300:
		return "five_hour", "5h"
	case mins == 7*24*60:
		return "seven_day", "Week"
	case mins >= 28*24*60 && mins <= 31*24*60:
		return "month", "Month"
	case mins > 0 && mins%(24*60) == 0:
		return fmt.Sprintf("%dd", mins/(24*60)), fmt.Sprintf("%dd", mins/(24*60))
	case mins > 0 && mins%60 == 0:
		return fmt.Sprintf("%dh", mins/60), fmt.Sprintf("%dh", mins/60)
	}
	return "limit", "Limit"
}

// handleRequest turns Codex's requests into permission prompts, questions and MCP forms;
// anything else is refused.
func (c *codexConn) handleRequest(m rpcMessage) {
	key := "codex-" + string(m.ID)
	switch m.Method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		var p struct {
			ItemID  string `json:"itemId"`
			Command string `json:"command"`
			Reason  string `json:"reason"`
		}
		_ = json.Unmarshal(m.Params, &p)
		file := m.Method == "item/fileChange/requestApproval"
		c.mu.Lock()
		editsOK := file && c.settings.Mode == ModeEdits
		it := c.items[p.ItemID]
		c.mu.Unlock()
		if editsOK {
			c.reply(m.ID, map[string]any{"decision": "accept"})
			return
		}
		name, args := "Shell", map[string]any{"command": p.Command}
		if file {
			name, args = "Edit", map[string]any{}
			if it != nil {
				if views := codexToolViews(it); len(views) > 0 {
					name, args = views[0].name, views[0].args
				}
			}
		} else if p.Command == "" && it != nil {
			args["command"] = it.Command
		}
		input, _ := json.Marshal(args)
		kind := "command"
		if file {
			kind = "file"
		}
		c.mu.Lock()
		c.perms[key] = &codexRequest{rawID: m.ID, kind: kind}
		c.mu.Unlock()
		c.emit(Event{Kind: EventPermission, Permission: &Permission{RequestID: key, ToolName: name, ToolID: p.ItemID,
			Input: string(input), Description: p.Reason, CanAlways: true, AlwaysLabel: "for the rest of this conversation",
			Suggestions: json.RawMessage(`[{"type":"codex","decision":"acceptForSession"}]`)}})
	case "item/tool/requestUserInput":
		var p struct {
			ItemID    string          `json:"itemId"`
			Questions []codexQuestion `json:"questions"`
		}
		_ = json.Unmarshal(m.Params, &p)
		qs := make([]any, 0, len(p.Questions))
		for _, q := range p.Questions {
			opts := make([]any, 0, len(q.Options))
			for _, o := range q.Options {
				opts = append(opts, map[string]any{"label": o.Label, "description": o.Description})
			}
			qs = append(qs, map[string]any{"question": q.Question, "header": q.Header, "options": opts, "multiSelect": false})
		}
		input, _ := json.Marshal(map[string]any{"questions": qs})
		c.mu.Lock()
		c.perms[key] = &codexRequest{rawID: m.ID, kind: "input", questions: p.Questions}
		c.mu.Unlock()
		c.emit(Event{Kind: EventPermission, Permission: &Permission{RequestID: key, ToolName: "AskUserQuestion",
			ToolID: p.ItemID, Input: string(input)}})
	case "mcpServer/elicitation/request":
		var p struct {
			ServerName      string          `json:"serverName"`
			Mode            string          `json:"mode"`
			Message         string          `json:"message"`
			URL             string          `json:"url"`
			RequestedSchema json.RawMessage `json:"requestedSchema"`
		}
		_ = json.Unmarshal(m.Params, &p)
		el := &Elicitation{Server: p.ServerName, Message: p.Message, Mode: "form"}
		if p.Mode == "url" {
			el.Mode, el.URL = "url", p.URL
		} else {
			el.Schema, el.Order = string(p.RequestedSchema), schemaOrder(p.RequestedSchema)
		}
		c.mu.Lock()
		c.perms[key] = &codexRequest{rawID: m.ID, kind: "elicitation"}
		c.mu.Unlock()
		c.emit(Event{Kind: EventPermission, Permission: &Permission{RequestID: key, ToolName: "Elicitation", Elicitation: el}})
	case "item/permissions/requestApproval":
		// Extra sandbox permissions: grant none; Codex then asks per command instead.
		c.reply(m.ID, map[string]any{"permissions": map[string]any{}, "scope": "turn"})
	default:
		_ = c.writeJSON(map[string]any{"jsonrpc": "2.0", "id": m.ID,
			"error": rpcError{Code: -32601, Message: "method not supported: " + m.Method}})
	}
}

// schemaOrder lists a JSON Schema's top-level properties in the order they appear.
func schemaOrder(schema json.RawMessage) []string {
	var s struct {
		Properties json.RawMessage `json:"properties"`
	}
	if json.Unmarshal(schema, &s) != nil || len(s.Properties) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(s.Properties))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	var order []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return order
		}
		k, _ := t.(string)
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return order
		}
		order = append(order, k)
	}
	return order
}

func (c *codexConn) Send(in Input) error {
	c.mu.Lock()
	switch {
	case c.closed:
		c.mu.Unlock()
		return errors.New("conversation closed")
	case c.running:
		tid, turn := c.threadID, c.turnID
		c.mu.Unlock()
		if turn == "" {
			return errors.New("a turn is starting")
		}
		return c.steer(in, tid, turn)
	}
	c.running = true
	c.turnID = ""
	done := make(chan struct{})
	c.turnDone = done
	c.lastText, c.sep = false, false
	c.mu.Unlock()
	go func() {
		defer func() {
			c.cancelPermissions()
			c.mu.Lock()
			c.running, c.turnID, c.turnDone = false, "", nil
			c.items = map[string]*codexItem{}
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
		raw, err := c.call(c.ctx, "turn/start", c.turnParams(in))
		if err != nil {
			if c.ctx.Err() == nil {
				c.emit(Event{Kind: EventError, Text: err.Error()})
			}
			return
		}
		var r struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(raw, &r) == nil && r.Turn.ID != "" {
			c.mu.Lock()
			if c.turnID == "" {
				c.turnID = r.Turn.ID
			}
			c.mu.Unlock()
		}
		select {
		case <-done:
		case <-c.done:
		}
	}()
	return nil
}

// steer sends a message into the running turn.
func (c *codexConn) steer(in Input, threadID, turnID string) error {
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	_, err := c.call(ctx, "turn/steer", map[string]any{"threadId": threadID, "expectedTurnId": turnID,
		"clientUserMessageId": in.ID, "input": c.userInput(in)})
	if err != nil {
		return err
	}
	c.emit(Event{Kind: EventInputTaken, InputID: in.ID})
	return nil
}

// turnParams starts a turn with the current settings (they apply to later turns too).
func (c *codexConn) turnParams(in Input) map[string]any {
	c.mu.Lock()
	s, tid, model, wasPlan := c.settings, c.threadID, c.model, c.planMode
	c.planMode = s.Mode == ModePlan
	c.mu.Unlock()
	p := map[string]any{"threadId": tid, "clientUserMessageId": in.ID, "input": c.userInput(in),
		"approvalPolicy": codexApproval(s.Mode), "sandboxPolicy": codexSandboxPolicy(s.Mode)}
	if s.Model != "" {
		p["model"], model = s.Model, s.Model
	}
	if s.Effort != "" {
		p["effort"] = s.Effort
	}
	// Plan mode is a collaboration mode; switch back to the default one when leaving it.
	if s.Mode == ModePlan || wasPlan {
		mode := "default"
		if s.Mode == ModePlan {
			mode = "plan"
		}
		var effort any
		if s.Effort != "" {
			effort = s.Effort
		}
		p["collaborationMode"] = map[string]any{"mode": mode,
			"settings": map[string]any{"model": model, "reasoning_effort": effort, "developer_instructions": nil}}
	}
	return p
}

// userInput is a message as Codex input: the text, images by path, other files named in the text.
func (c *codexConn) userInput(in Input) []any {
	text := in.Prompt
	var images []any
	var files []string
	for _, a := range in.Attachments {
		p := platform.PathFor(c.env, a.Path)
		if a.IsImage {
			images = append(images, map[string]any{"type": "localImage", "path": p})
		} else {
			files = append(files, "- "+p)
		}
	}
	if len(files) > 0 {
		text = strings.TrimSpace(text + "\n\nAttached files:\n" + strings.Join(files, "\n"))
	}
	return append([]any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}}, images...)
}

// Apply records settings for the turns that follow; Codex takes them with each turn/start.
func (c *codexConn) Apply(s Settings) error {
	c.mu.Lock()
	c.settings = s
	c.mu.Unlock()
	return nil
}

func (c *codexConn) Interrupt() error {
	c.mu.Lock()
	tid, turn, running := c.threadID, c.turnID, c.running
	c.mu.Unlock()
	c.cancelPermissions()
	if !running || turn == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	_, err := c.call(ctx, "turn/interrupt", map[string]any{"threadId": tid, "turnId": turn})
	return err
}

// cancelPermissions withdraws open requests (the turn is over or stopping).
func (c *codexConn) cancelPermissions() {
	c.mu.Lock()
	perms := c.perms
	c.perms = map[string]*codexRequest{}
	c.mu.Unlock()
	for key, p := range perms {
		c.reply(p.rawID, codexCancel(p.kind))
		c.emit(Event{Kind: EventPermissionCancel, RequestID: key})
	}
}

func codexCancel(kind string) map[string]any {
	switch kind {
	case "input":
		return map[string]any{"answers": map[string]any{}}
	case "elicitation":
		return map[string]any{"action": "cancel", "content": nil, "_meta": nil}
	}
	return map[string]any{"decision": "cancel"}
}

// Respond answers a request. result is shaped like Claude Code's answer:
// {behavior: "allow"|"deny", updatedInput, updatedPermissions (when "always"), interrupt},
// or {action, content} for an MCP form.
func (c *codexConn) Respond(requestID string, result map[string]any) error {
	c.mu.Lock()
	p := c.perms[requestID]
	delete(c.perms, requestID)
	c.mu.Unlock()
	if p == nil {
		return errors.New("this request is no longer open")
	}
	allow := result["behavior"] == "allow"
	switch p.kind {
	case "elicitation":
		action, _ := result["action"].(string)
		if action == "" {
			action = "decline"
		}
		c.reply(p.rawID, map[string]any{"action": action, "content": result["content"], "_meta": nil})
	case "input":
		answers := map[string]any{}
		if allow {
			input, _ := result["updatedInput"].(map[string]any)
			given, _ := input["answers"].(map[string]any)
			if given == nil {
				if m, ok := input["answers"].(map[string]string); ok {
					given = map[string]any{}
					for k, v := range m {
						given[k] = v
					}
				}
			}
			for _, q := range p.questions {
				s, _ := given[q.Question].(string)
				if s == "" {
					continue
				}
				var list []string
				for _, part := range strings.Split(s, ", ") {
					if part = strings.TrimSpace(part); part != "" {
						list = append(list, part)
					}
				}
				answers[q.ID] = map[string]any{"answers": list}
			}
		}
		c.reply(p.rawID, map[string]any{"answers": answers})
	default:
		decision := "decline"
		switch {
		case allow:
			decision = "accept"
			if _, always := result["updatedPermissions"]; always {
				decision = "acceptForSession"
			}
		case result["interrupt"] == true:
			decision = "cancel"
		}
		c.reply(p.rawID, map[string]any{"decision": decision})
	}
	if result["interrupt"] == true {
		return c.Interrupt()
	}
	return nil
}

func (c *codexConn) Control(context.Context, string, map[string]any) (json.RawMessage, error) {
	return nil, ErrUnsupported
}

func (c *codexConn) Close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.cancel()
}

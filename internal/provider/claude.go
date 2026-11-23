package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/google/uuid"

	"harness/internal/platform"
	"harness/internal/usage"
)

// Claude drives the Claude Code CLI over its stream-json protocol, the one the Agent SDK
// uses: one process per conversation, with permission prompts and control requests on
// stdin/stdout. No system prompt or instructions are injected: Claude Code uses its own config.
type Claude struct{}

var claudeModes = []Option{
	{ID: ModeAsk, Label: "Ask permissions"},
	{ID: ModeEdits, Label: "Accept edits"},
	{ID: ModePlan, Label: "Plan"},
	{ID: ModeFull, Label: "Full access"},
}

func (Claude) Info() Info {
	_, err := exec.LookPath("claude")
	return Info{
		ID:        "claude",
		Name:      "Claude Code",
		Available: err == nil || platform.HasWSL(),
		Models: []Option{
			{ID: "default", Label: "Default"},
			{ID: "claude-fable-5-2", Label: "Fable 5.2"},
			{ID: "claude-opus-5-5", Label: "Opus 5.5"},
			{ID: "claude-sonnet-5-5", Label: "Sonnet 5.5"},
			{ID: "claude-haiku-5-5", Label: "Haiku 5.5"},
		},
		Efforts: []Option{
			{ID: "low", Label: "Low"},
			{ID: "medium", Label: "Medium"},
			{ID: "high", Label: "High"},
			{ID: "xhigh", Label: "Extra high"},
			{ID: "max", Label: "Max"},
		},
		Modes:         claudeModes,
		DefaultModel:  "default",
		DefaultEffort: "high",
		Steer:         true,
		Fast:          true,
		Interactive:   true,
	}
}

func (Claude) Open(ctx context.Context, req OpenRequest) (Conn, error) {
	args := []string{"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
		"--include-partial-messages", "--replay-user-messages",
		// Permission prompts come to us as control requests on stdout.
		"--permission-prompt-tool", "stdio",
		// Lets the session switch into Full access later, not only start in it.
		"--allow-dangerously-skip-permissions",
		// Thinking arrives as text (summarized) instead of being left out.
		"--thinking-display", "summarized",
	}
	switch {
	case req.ForkFrom != "":
		args = append(args, "--resume", req.ForkFrom, "--fork-session", "--session-id", req.SessionID)
		if req.ResumeAt != "" {
			args = append(args, "--resume-session-at", req.ResumeAt)
		}
	case req.Resume:
		args = append(args, "--resume", req.SessionID)
	default:
		args = append(args, "--session-id", req.SessionID)
	}
	if req.Model != "" && req.Model != "default" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	args = append(args, "--permission-mode", claudeMode(req.Mode))
	if req.Fast {
		// Headless runs need an explicit opt-in; flag settings layer over the user's own.
		args = append(args, "--settings", `{"fastMode":true}`)
	}

	ctx, cancel := context.WithCancel(ctx)
	cmd := platform.Command(ctx, req.Env, req.Dir, "claude", args...)
	// File checkpoints make rewind_files work (the SDK sets this for enableFileCheckpointing).
	cmd.Env = append(os.Environ(), "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true")
	if req.Env.Normalize() == platform.EnvWSL {
		cmd.Env = append(cmd.Env, "WSLENV=CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING/u")
	}
	c := newClaudeConn(ctx, cancel, req)
	if err := c.start(cmd); err != nil {
		cancel()
		return nil, err
	}
	// Ask for the slash commands; declare a per-task stop control so interrupting a turn
	// spares background tasks (they're stopped one by one instead).
	go func() {
		raw, err := c.Control(ctx, "initialize", map[string]any{"perTaskStopAffordance": true})
		if err != nil {
			return
		}
		var r struct {
			Commands []claudeCommand `json:"commands"`
		}
		if json.Unmarshal(raw, &r) == nil && r.Commands != nil {
			c.emit(Event{Kind: EventCommands, Commands: convertCommands(r.Commands)})
		}
	}()
	return c, nil
}

func claudeMode(mode string) string {
	switch mode {
	case ModePlan:
		return "plan"
	case ModeEdits:
		return "acceptEdits"
	case ModeAsk:
		return "default"
	default:
		return "bypassPermissions"
	}
}

// ClaudePermissionMode is Claude Code's name for one of our permission modes.
func ClaudePermissionMode(mode string) string { return claudeMode(mode) }

// harnessMode maps a Claude Code permission mode back to ours ("" when there is none).
func harnessMode(mode string) string {
	switch mode {
	case "plan":
		return ModePlan
	case "acceptEdits":
		return ModeEdits
	case "default":
		return ModeAsk
	case "bypassPermissions":
		return ModeFull
	}
	return ""
}

func (c *claudeConn) Send(in Input) error {
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	msg, err := claudeInput(c.env, in)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.inputs[in.ID] = true
	c.mu.Unlock()
	return c.write(msg)
}

func (c *claudeConn) Apply(s Settings) error {
	c.mu.Lock()
	old := c.settings
	c.settings = s
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	var errs []error
	if s.Model != old.Model {
		model := any(s.Model)
		if s.Model == "" || s.Model == "default" {
			model = nil
		}
		_, err := c.Control(ctx, "set_model", map[string]any{"model": model})
		errs = append(errs, err)
	}
	if s.Mode != old.Mode {
		_, err := c.Control(ctx, "set_permission_mode", map[string]any{"mode": claudeMode(s.Mode)})
		errs = append(errs, err)
	}
	if s.Effort != old.Effort || s.Fast != old.Fast {
		settings := map[string]any{"fastMode": s.Fast}
		if s.Effort != "" {
			settings["effortLevel"] = s.Effort
		}
		_, err := c.Control(ctx, "apply_flag_settings", map[string]any{"settings": settings})
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (c *claudeConn) Interrupt() error {
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	_, err := c.Control(ctx, "interrupt", nil)
	return err
}

func (c *claudeConn) Respond(requestID string, result map[string]any) error {
	return c.writeJSON(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": requestID, "response": result,
	}})
}

type claudeCommand struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	ArgumentHint string   `json:"argumentHint"`
	Aliases      []string `json:"aliases"`
	Builtin      bool     `json:"builtin"`
}

func convertCommands(in []claudeCommand) []Command {
	out := make([]Command, 0, len(in))
	for _, x := range in {
		if strings.HasPrefix(x.Name, "__") { // internal
			continue
		}
		out = append(out, Command(x))
	}
	return out
}

type claudeLine struct {
	Type          string `json:"type"`
	UUID          string `json:"uuid"`
	RateLimitInfo *struct {
		UnifiedWindows map[string]struct {
			Utilization float64 `json:"utilization"`
			ResetsAt    int64   `json:"resetsAt"`
		} `json:"unifiedWindows"`
	} `json:"rate_limit_info"`
	IsError bool `json:"is_error"`
	// Set on user messages the CLI echoes back from stdin (--replay-user-messages).
	IsReplay bool   `json:"isReplay"`
	Subtype  string `json:"subtype"`
	// On the init and result lines: whether fast mode is in effect, and why not.
	FastModeState          string   `json:"fast_mode_state"`
	FastModeDisabledReason string   `json:"fast_mode_disabled_reason"`
	Result                 string   `json:"result"`
	Errors                 []string `json:"errors"`
	// Set on messages from subagents: the id of the Agent tool call that runs them.
	ParentToolUseID *string `json:"parent_tool_use_id"`
	// On a user message carrying an Agent tool's result: the subagent's totals.
	ToolUseResult json.RawMessage `json:"tool_use_result"`
	ModelUsage    map[string]struct {
		ContextWindow int64 `json:"contextWindow"`
	} `json:"modelUsage"`
	Event *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
	} `json:"event"`
	Message *struct {
		Usage   *claudeTokens `json:"usage"`
		Content claudeBlocks  `json:"content"`
	} `json:"message"`

	// system lines
	PermissionMode  string `json:"permissionMode"`
	CompactMetadata *struct {
		Trigger string `json:"trigger"`
	} `json:"compact_metadata"`
	Commands []claudeCommand `json:"commands"`
	Tasks    []struct {
		TaskID      string `json:"task_id"`
		TaskType    string `json:"task_type"`
		Description string `json:"description"`
		Ambient     bool   `json:"ambient"`
	} `json:"tasks"`
	TaskID    string `json:"task_id"`
	ToolUseID string `json:"tool_use_id"`
	Status    any    `json:"status"`
	Summary   string `json:"summary"`
	Content   string `json:"content"` // local_command_output

	// control protocol
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  json.RawMessage `json:"response"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     map[string]any  `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	Text      string          `json:"text"`
}

// claudeBlocks is a message's content: a list of blocks, or a plain string (as a text block).
type claudeBlocks []claudeBlock

func (b *claudeBlocks) UnmarshalJSON(data []byte) error {
	var s string
	if json.Unmarshal(data, &s) == nil {
		*b = claudeBlocks{{Type: "text", Text: s}}
		return nil
	}
	var list []claudeBlock
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	*b = list
	return nil
}

type claudeTokens struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
}

// parseClaudeLine turns one stdout line into events. Lines that need the connection's
// state (control messages, replays, the conversation's latest entry) are handled by
// claudeConn.handle before this.
func parseClaudeLine(line []byte, emit func(Event)) {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	parseClaude(&l, emit)
}

func parseClaude(l *claudeLine, emit func(Event)) {
	if l.FastModeState != "" && (l.Type == "result" || l.Subtype == "init") {
		emit(Event{Kind: EventFast, FastState: l.FastModeState, FastOffReason: l.FastModeDisabledReason})
	}
	switch l.Type {
	case "stream_event":
		// Text streams token by token; everything else comes from full messages. A subagent's
		// own text is not shown (Claude Code shows only its tool calls and final report).
		if l.ParentToolUseID != nil || l.Event == nil || l.Event.Type != "content_block_delta" || l.Event.Delta == nil {
			return
		}
		switch d := l.Event.Delta; d.Type {
		case "text_delta":
			emit(Event{Kind: EventText, Text: d.Text})
		case "thinking_delta":
			emit(Event{Kind: EventThinking, Text: d.Thinking})
		}
	case "assistant":
		if l.Message == nil {
			return
		}
		// Each request's prompt is the whole conversation so far, so it is what fills the context.
		if u := l.Message.Usage; u != nil && l.ParentToolUseID == nil {
			if n := u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens + u.OutputTokens; n > 0 {
				emit(Event{Kind: EventContext, ContextTokens: n})
			}
		}
		parent := ""
		if l.ParentToolUseID != nil {
			parent = *l.ParentToolUseID
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_use" {
				e := Event{Kind: EventToolStart, ToolID: c.ID, ToolName: c.Name, ToolInput: summarizeInput(c.Input),
					ToolArgs: toolArgs(c.Input), ParentID: parent}
				if IsAgentTool(c.Name) {
					e.Subagent, _ = c.Input["subagent_type"].(string)
				}
				emit(e)
			}
		}
	case "user":
		if l.Message == nil || l.IsReplay {
			return
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_result" {
				emit(Event{Kind: EventToolEnd, ToolID: c.ToolUseID, ToolOutput: flattenContent(c.Content), IsError: c.IsError,
					Images: contentImages(c.Content), AgentStats: agentStats(l.ToolUseResult)})
			}
		}
	case "rate_limit_event":
		if s := claudeUsage(*l); s != nil {
			emit(Event{Kind: EventUsage, Usage: s})
		}
	case "system":
		parseClaudeSystem(l, emit)
	case "result":
		if l.IsError {
			msg := l.Result
			if msg == "" {
				msg = strings.Join(l.Errors, "\n")
			}
			// An interrupted turn ends as an error without a message: that's not a failure.
			if msg != "" {
				emit(Event{Kind: EventError, Text: msg})
			}
		}
		// The largest window among the models used (the main model; helpers are smaller).
		var window int64
		for _, m := range l.ModelUsage {
			window = max(window, m.ContextWindow)
		}
		if window > 0 {
			emit(Event{Kind: EventContext, ContextWindow: window})
		}
	}
}

func parseClaudeSystem(l *claudeLine, emit func(Event)) {
	switch l.Subtype {
	case "status":
		if m := harnessMode(l.PermissionMode); m != "" {
			emit(Event{Kind: EventMode, Mode: m})
		}
	case "compact_boundary":
		trigger := "auto"
		if l.CompactMetadata != nil && l.CompactMetadata.Trigger != "" {
			trigger = l.CompactMetadata.Trigger
		}
		emit(Event{Kind: EventCompact, Text: trigger})
	case "commands_changed":
		emit(Event{Kind: EventCommands, Commands: convertCommands(l.Commands)})
	case "background_tasks_changed":
		tasks := []Task{}
		for _, t := range l.Tasks {
			if !t.Ambient {
				tasks = append(tasks, Task{ID: t.TaskID, Type: t.TaskType, Description: t.Description})
			}
		}
		emit(Event{Kind: EventTasks, Tasks: tasks})
	case "task_notification":
		status, _ := l.Status.(string)
		emit(Event{Kind: EventTaskDone, Task: &Task{ID: l.TaskID, ToolID: l.ToolUseID, Status: status, Summary: l.Summary}})
	case "local_command_output":
		if l.Content != "" {
			emit(Event{Kind: EventText, Text: l.Content})
		}
	}
}

// toolArgs is a tool's full input as JSON, for rich display. Very large inputs (a big
// Write) are cut down to keep the transcript small.
func toolArgs(input map[string]any) string {
	if len(input) == 0 {
		return ""
	}
	const maxField = 64 << 10
	trimmed := make(map[string]any, len(input))
	for k, v := range input {
		if s, ok := v.(string); ok && len(s) > maxField {
			v = s[:maxField] + "\n…"
		}
		trimmed[k] = v
	}
	b, err := json.Marshal(trimmed)
	if err != nil || len(b) > 512<<10 {
		return ""
	}
	return string(b)
}

// contentImages returns the images in a tool result's content blocks.
func contentImages(raw json.RawMessage) []Image {
	var blocks []struct {
		Type   string `json:"type"`
		Source *struct {
			Type      string `json:"type"`
			MediaType string `json:"media_type"`
			Data      string `json:"data"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return nil
	}
	var out []Image
	for _, b := range blocks {
		if b.Type != "image" || b.Source == nil || b.Source.Type != "base64" {
			continue
		}
		if data, err := base64.StdEncoding.DecodeString(b.Source.Data); err == nil {
			out = append(out, Image{MimeType: b.Source.MediaType, Data: data})
		}
	}
	return out
}

// agentStats reads a subagent's totals from a tool result's metadata, if it has them.
func agentStats(raw json.RawMessage) *AgentStats {
	var r struct {
		TotalToolUseCount *int  `json:"totalToolUseCount"`
		TotalTokens       int64 `json:"totalTokens"`
		TotalDurationMs   int64 `json:"totalDurationMs"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &r) != nil || r.TotalToolUseCount == nil {
		return nil
	}
	return &AgentStats{ToolUses: *r.TotalToolUseCount, Tokens: r.TotalTokens, DurationMs: r.TotalDurationMs}
}

var claudeWindows = []struct{ id, label string }{{"five_hour", "5h"}, {"seven_day", "Week"}}

// claudeUsage converts a rate_limit_event into a usage snapshot.
func claudeUsage(l claudeLine) *usage.Snapshot {
	if l.RateLimitInfo == nil {
		return nil
	}
	s := &usage.Snapshot{Provider: "claude", UpdatedAt: time.Now().UnixMilli()}
	for _, w := range claudeWindows {
		if info, ok := l.RateLimitInfo.UnifiedWindows[w.id]; ok {
			s.Windows = append(s.Windows, usage.Window{
				ID: w.id, Label: w.label, Used: info.Utilization, ResetsAt: info.ResetsAt * 1000,
			})
		}
	}
	if len(s.Windows) == 0 {
		return nil
	}
	return s
}

// Images larger than this are passed as a path instead (API image size limit).
const maxInlineImage = 5 << 20

// claudeInput builds one stream-json user message with text, images and file paths.
// The message keeps in.ID as its uuid, so it can be found again to rewind to it.
func claudeInput(env platform.Env, in Input) (string, error) {
	type source struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	}
	type block struct {
		Type   string  `json:"type"`
		Text   string  `json:"text,omitempty"`
		Source *source `json:"source,omitempty"`
	}
	blocks := []block{}
	var files []string
	for _, a := range in.Attachments {
		if a.IsImage {
			if data, err := os.ReadFile(a.Path); err == nil && len(data) <= maxInlineImage {
				blocks = append(blocks, block{Type: "image", Source: &source{
					Type: "base64", MediaType: a.MimeType, Data: base64.StdEncoding.EncodeToString(data),
				}})
				continue
			}
		}
		files = append(files, platform.PathFor(env, a.Path))
	}
	text := withFileList(in.Prompt, files)
	var content any = blocks
	if len(blocks) == 0 {
		// Plain text, so slash commands are recognized.
		content = text
	} else {
		blocks = append(blocks, block{Type: "text", Text: text})
		content = blocks
	}
	msg := map[string]any{
		"type":               "user",
		"uuid":               in.ID,
		"parent_tool_use_id": nil,
		"message":            map[string]any{"role": "user", "content": content},
	}
	b, err := json.Marshal(msg)
	return string(b) + "\n", err
}

// withFileList appends attached file paths so the agent can open them with its tools.
func withFileList(prompt string, paths []string) string {
	if len(paths) == 0 {
		return prompt
	}
	var sb strings.Builder
	sb.WriteString(prompt)
	sb.WriteString("\n\nAttached files:")
	for _, p := range paths {
		sb.WriteString("\n- " + p)
	}
	return sb.String()
}

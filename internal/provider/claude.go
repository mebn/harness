package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"

	"harness/internal/platform"
	"harness/internal/usage"
)

// Claude drives the Claude Code CLI in headless stream-json mode.
// No system prompt or instructions are injected: Claude Code uses its own config.
type Claude struct{}

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
		Modes:         commonModes,
		DefaultModel:  "default",
		DefaultEffort: "high",
	}
}

func (Claude) Run(ctx context.Context, req Request) (<-chan Event, error) {
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
	if req.Resume {
		args = append(args, "--resume", req.SessionID)
	} else {
		args = append(args, "--session-id", req.SessionID)
	}
	if req.Model != "" && req.Model != "default" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	args = append(args, "--permission-mode", claudeMode(req.Mode))

	stdin := req.Prompt
	if len(req.Attachments) > 0 {
		// Attachments need structured input: images go in as native image blocks.
		input, err := claudeInput(req)
		if err != nil {
			return nil, err
		}
		args = append(args, "--input-format", "stream-json")
		stdin = input
	}

	cmd := platform.Command(ctx, req.Env, req.Dir, "claude", args...)
	// The prompt goes over stdin to avoid any shell/argv quoting issues.
	return runJSONL(ctx, cmd, stdin, parseClaudeLine)
}

func claudeMode(mode string) string {
	switch mode {
	case ModePlan:
		return "plan"
	case ModeEdits:
		return "acceptEdits"
	default:
		return "bypassPermissions"
	}
}

type claudeLine struct {
	Type          string `json:"type"`
	RateLimitInfo *struct {
		UnifiedWindows map[string]struct {
			Utilization float64 `json:"utilization"`
			ResetsAt    int64   `json:"resetsAt"`
		} `json:"unifiedWindows"`
	} `json:"rate_limit_info"`
	IsError bool   `json:"is_error"`
	Result  string `json:"result"`
	// Set on messages from subagents: the id of the Agent tool call that runs them.
	ParentToolUseID *string `json:"parent_tool_use_id"`
	// On a user message carrying an Agent tool's result: the subagent's totals.
	ToolUseResult json.RawMessage `json:"tool_use_result"`
	ModelUsage      map[string]struct {
		ContextWindow int64 `json:"contextWindow"`
	} `json:"modelUsage"`
	Event *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
	Message *struct {
		Usage   *claudeTokens `json:"usage"`
		Content []struct {
			Type      string          `json:"type"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     map[string]any  `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
			IsError   bool            `json:"is_error"`
		} `json:"content"`
	} `json:"message"`
}

type claudeTokens struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
}

func parseClaudeLine(line []byte, emit func(Event)) {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	switch l.Type {
	case "stream_event":
		// Text streams token by token; everything else comes from full messages. A subagent's
		// own text is not shown (Claude Code shows only its tool calls and final report).
		if l.ParentToolUseID == nil && l.Event != nil && l.Event.Type == "content_block_delta" && l.Event.Delta != nil && l.Event.Delta.Type == "text_delta" {
			emit(Event{Kind: EventText, Text: l.Event.Delta.Text})
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
				e := Event{Kind: EventToolStart, ToolID: c.ID, ToolName: c.Name, ToolInput: summarizeInput(c.Input), ParentID: parent}
				if IsAgentTool(c.Name) {
					e.Subagent, _ = c.Input["subagent_type"].(string)
				}
				emit(e)
			}
		}
	case "user":
		if l.Message == nil {
			return
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_result" {
				emit(Event{Kind: EventToolEnd, ToolID: c.ToolUseID, ToolOutput: flattenContent(c.Content), IsError: c.IsError,
					AgentStats: agentStats(l.ToolUseResult)})
			}
		}
	case "rate_limit_event":
		if s := claudeUsage(l); s != nil {
			emit(Event{Kind: EventUsage, Usage: s})
		}
	case "result":
		if l.IsError && l.Result != "" {
			emit(Event{Kind: EventError, Text: l.Result})
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
func claudeInput(req Request) (string, error) {
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
	for _, a := range req.Attachments {
		if a.IsImage {
			if data, err := os.ReadFile(a.Path); err == nil && len(data) <= maxInlineImage {
				blocks = append(blocks, block{Type: "image", Source: &source{
					Type: "base64", MediaType: a.MimeType, Data: base64.StdEncoding.EncodeToString(data),
				}})
				continue
			}
		}
		files = append(files, platform.PathFor(req.Env, a.Path))
	}
	blocks = append(blocks, block{Type: "text", Text: withFileList(req.Prompt, files)})

	msg := map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": blocks},
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

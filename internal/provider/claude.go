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
	Event   *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
	Message *struct {
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

func parseClaudeLine(line []byte, emit func(Event)) {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	switch l.Type {
	case "stream_event":
		// Text streams token by token; everything else comes from full messages.
		if l.Event != nil && l.Event.Type == "content_block_delta" && l.Event.Delta != nil && l.Event.Delta.Type == "text_delta" {
			emit(Event{Kind: EventText, Text: l.Event.Delta.Text})
		}
	case "assistant":
		if l.Message == nil {
			return
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_use" {
				emit(Event{Kind: EventToolStart, ToolID: c.ID, ToolName: c.Name, ToolInput: summarizeInput(c.Input)})
			}
		}
	case "user":
		if l.Message == nil {
			return
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_result" {
				emit(Event{Kind: EventToolEnd, ToolID: c.ToolUseID, ToolOutput: flattenContent(c.Content), IsError: c.IsError})
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
	}
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

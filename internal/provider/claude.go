package provider

import (
	"context"
	"encoding/json"
	"os/exec"

	"harness/internal/platform"
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

	cmd := platform.Command(ctx, req.Env, req.Dir, "claude", args...)
	// The prompt goes over stdin to avoid any shell/argv quoting issues.
	return runJSONL(ctx, cmd, req.Prompt, parseClaudeLine)
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
	Type    string `json:"type"`
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
	case "result":
		if l.IsError && l.Result != "" {
			emit(Event{Kind: EventError, Text: l.Result})
		}
	}
}

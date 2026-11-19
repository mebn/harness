package provider

import (
	"context"
	"encoding/json"
	"os/exec"

	"harness/internal/platform"
)

// Copilot drives the GitHub Copilot CLI in prompt mode with JSONL output.
type Copilot struct{}

func (Copilot) Info() Info {
	_, err := exec.LookPath("copilot")
	return Info{
		ID:        "copilot",
		Name:      "Copilot",
		Available: err == nil || platform.HasWSL(),
		Models: []Option{
			{ID: "auto", Label: "Auto"},
			{ID: "claude-opus-5-5", Label: "Opus 5.5"},
			{ID: "claude-sonnet-5-5", Label: "Sonnet 5.5"},
			{ID: "gpt-6-luna", Label: "GPT-6 Luna"},
			{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol"},
		},
		Efforts: []Option{
			{ID: "low", Label: "Low"},
			{ID: "medium", Label: "Medium"},
			{ID: "high", Label: "High"},
			{ID: "xhigh", Label: "Extra high"},
			{ID: "max", Label: "Max"},
		},
		Modes:         commonModes,
		DefaultModel:  "auto",
		DefaultEffort: "medium",
	}
}

func (Copilot) Run(ctx context.Context, req Request) (<-chan Event, error) {
	// --session-id both creates a new session with that id and resumes an existing one.
	prompt := req.Prompt
	var attachArgs []string
	for _, a := range req.Attachments {
		p := platform.PathFor(req.Env, a.Path)
		if a.IsImage || a.MimeType == "application/pdf" {
			attachArgs = append(attachArgs, "--attachment", p) // native image/document input
		} else {
			prompt += "\n@" + p // @-mentions add the file to the context
		}
	}
	args := []string{"-p", prompt, "--output-format", "json", "--session-id", req.SessionID}
	args = append(args, attachArgs...)
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	// "auto" picks the model per request and rejects an explicit effort.
	if req.Effort != "" && req.Model != "auto" {
		args = append(args, "--reasoning-effort", req.Effort)
	}
	switch req.Mode {
	case ModePlan:
		// read-only: no tool approvals granted
	case ModeEdits:
		args = append(args, "--allow-tool=write")
	default:
		args = append(args, "--allow-all")
	}
	cmd := platform.Command(ctx, req.Env, req.Dir, "copilot", args...)
	return runJSONL(ctx, cmd, "", parseCopilotLine)
}

// Internal bookkeeping tools that add noise to the transcript.
var copilotHiddenTools = map[string]bool{"report_intent": true}

type copilotLine struct {
	Type string `json:"type"`
	Data struct {
		DeltaContent string         `json:"deltaContent"`
		ToolCallID   string         `json:"toolCallId"`
		ToolName     string         `json:"toolName"`
		Arguments    map[string]any `json:"arguments"`
		Success      *bool          `json:"success"`
		Message      string         `json:"message"`
		Result       *struct {
			Content json.RawMessage `json:"content"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"data"`
}

func parseCopilotLine(line []byte, emit func(Event)) {
	var l copilotLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	d := l.Data
	switch l.Type {
	case "assistant.message_delta":
		emit(Event{Kind: EventText, Text: d.DeltaContent})
	case "tool.execution_start":
		if !copilotHiddenTools[d.ToolName] {
			emit(Event{Kind: EventToolStart, ToolID: d.ToolCallID, ToolName: d.ToolName, ToolInput: summarizeInput(d.Arguments)})
		}
	case "tool.execution_complete":
		out := ""
		if d.Result != nil {
			out = flattenContent(d.Result.Content)
		} else if d.Error != nil {
			out = d.Error.Message
		}
		emit(Event{Kind: EventToolEnd, ToolID: d.ToolCallID, ToolOutput: out, IsError: d.Success != nil && !*d.Success})
	case "session.error":
		emit(Event{Kind: EventError, Text: d.Message})
	}
}

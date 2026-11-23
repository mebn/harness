package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func collect(parse lineParser, lines ...string) []Event {
	var out []Event
	for _, l := range lines {
		parse([]byte(l), func(e Event) { out = append(out, e) })
	}
	return out
}

func TestParseClaude(t *testing.T) {
	ev := collect(parseClaudeLine,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a.go"}]}]}}`,
		`{"type":"result","is_error":true,"result":"boom"}`,
	)
	if len(ev) != 4 {
		t.Fatalf("got %d events", len(ev))
	}
	if ev[0].Text != "Hi" || ev[1].ToolInput != "ls" || ev[2].ToolOutput != "a.go" || ev[3].Kind != EventError {
		t.Fatalf("unexpected events: %+v", ev)
	}
}

func TestParseCopilot(t *testing.T) {
	ev := collect(parseCopilotLine,
		`{"type":"assistant.message_delta","data":{"deltaContent":"done"}}`,
		`{"type":"tool.execution_start","data":{"toolCallId":"c1","toolName":"powershell","arguments":{"command":"echo hi"}}}`,
		`{"type":"tool.execution_start","data":{"toolCallId":"c2","toolName":"report_intent","arguments":{}}}`,
		`{"type":"tool.execution_complete","data":{"toolCallId":"c1","success":false,"result":{"content":"hi"}}}`,
	)
	if len(ev) != 3 {
		t.Fatalf("got %d events: %+v", len(ev), ev)
	}
	if ev[0].Text != "done" || ev[1].ToolInput != "echo hi" || ev[2].ToolOutput != "hi" || !ev[2].IsError {
		t.Fatalf("unexpected events: %+v", ev)
	}
}

func TestParseClaudeRateLimit(t *testing.T) {
	ev := collect(parseClaudeLine, `{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":1795092000},"seven_day":{"utilization":0.06,"resetsAt":1795172400}}}}`)
	if len(ev) != 1 || ev[0].Kind != EventUsage {
		t.Fatalf("events: %+v", ev)
	}
	w := ev[0].Usage.Windows
	if len(w) != 2 || w[0].Label != "5h" || w[0].Used != 0.07 || w[0].ResetsAt != 1795092000000 || w[1].Label != "Week" {
		t.Fatalf("windows: %+v", w)
	}
}

func TestClaudeInputAttachments(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "a.png")
	os.WriteFile(img, []byte("png-bytes"), 0o644)
	in, err := claudeInput("native", Input{ID: "u1", Prompt: "look", Attachments: []Attachment{
		{Name: "a.png", MimeType: "image/png", Path: img, IsImage: true},
		{Name: "notes.txt", MimeType: "text/plain", Path: filepath.Join(dir, "notes.txt")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var msg struct {
		Message struct {
			Content []struct {
				Type   string `json:"type"`
				Text   string `json:"text"`
				Source *struct {
					MediaType string `json:"media_type"`
					Data      string `json:"data"`
				} `json:"source"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(in), &msg); err != nil {
		t.Fatal(err)
	}
	c := msg.Message.Content
	if len(c) != 2 || c[0].Type != "image" || c[0].Source.MediaType != "image/png" || c[0].Source.Data == "" {
		t.Fatalf("image block: %+v", c)
	}
	if c[1].Type != "text" || !strings.Contains(c[1].Text, "look") || !strings.Contains(c[1].Text, "notes.txt") {
		t.Fatalf("text block: %+v", c[1])
	}
}

func TestParseClaudeContext(t *testing.T) {
	ev := collect(parseClaudeLine,
		`{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":5},"content":[]}}`,
		// A subagent's usage is not the main conversation's.
		`{"type":"assistant","parent_tool_use_id":"t1","message":{"usage":{"input_tokens":99999},"content":[]}}`,
		`{"type":"result","modelUsage":{"claude-haiku":{"contextWindow":200000},"claude-opus":{"contextWindow":1000000}}}`,
	)
	if len(ev) != 2 || ev[0].Kind != EventContext || ev[1].Kind != EventContext {
		t.Fatalf("unexpected events: %+v", ev)
	}
	if ev[0].ContextTokens != 1215 || ev[1].ContextWindow != 1000000 {
		t.Fatalf("got tokens %d window %d", ev[0].ContextTokens, ev[1].ContextWindow)
	}
}

func TestParseClaudeSubagent(t *testing.T) {
	ev := collect(parseClaudeLine,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a1","name":"Agent","input":{"description":"Find auth","prompt":"...","subagent_type":"Explore"}}]}}`,
		// The subagent's own streamed text stays out of the main transcript.
		`{"type":"stream_event","parent_tool_use_id":"a1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"inner"}}}`,
		`{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_use","id":"g1","name":"Grep","input":{"pattern":"auth"}}]}}`,
		`{"type":"user","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_result","tool_use_id":"g1","content":"x.go"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a1","content":[{"type":"text","text":"report"}]}]},"tool_use_result":{"totalToolUseCount":1,"totalTokens":1234,"totalDurationMs":5000}}`,
	)
	if len(ev) != 4 {
		t.Fatalf("unexpected events: %+v", ev)
	}
	if ev[0].Subagent != "Explore" || ev[0].ToolInput != "Find auth" || ev[0].ParentID != "" {
		t.Fatalf("agent start: %+v", ev[0])
	}
	if ev[1].ToolName != "Grep" || ev[1].ParentID != "a1" {
		t.Fatalf("subagent tool: %+v", ev[1])
	}
	if s := ev[3].AgentStats; s == nil || s.ToolUses != 1 || s.Tokens != 1234 || s.DurationMs != 5000 || ev[3].ToolOutput != "report" {
		t.Fatalf("agent result: %+v", ev[3])
	}
}

func TestParseClaudeFastMode(t *testing.T) {
	ev := collect(parseClaudeLine,
		`{"type":"system","subtype":"init","fast_mode_state":"off","fast_mode_disabled_reason":"extra_usage_disabled"}`,
		`{"type":"system","subtype":"hook_started"}`,
		`{"type":"result","result":"hi","fast_mode_state":"on"}`)
	var fast []Event
	for _, e := range ev {
		if e.Kind == EventFast {
			fast = append(fast, e)
		}
	}
	if len(fast) != 2 || fast[0].FastState != "off" || fast[0].FastOffReason != "extra_usage_disabled" || fast[1].FastState != "on" {
		t.Fatalf("fast events: %+v", fast)
	}
}

func TestClaudeInputPlainText(t *testing.T) {
	in, err := claudeInput("native", Input{ID: "u1", Prompt: "/compact"})
	if err != nil {
		t.Fatal(err)
	}
	var msg struct {
		UUID    string `json:"uuid"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(in), &msg); err != nil || msg.UUID != "u1" || msg.Message.Content != "/compact" {
		t.Fatalf("got %s (%v)", in, err)
	}
}

func TestParseClaudeThinkingAndSystem(t *testing.T) {
	ev := collect(parseClaudeLine,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}`,
		`{"type":"system","subtype":"status","status":null,"permissionMode":"default"}`,
		`{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual"}}`,
		`{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"sleep"},{"task_id":"w","task_type":"x","description":"","ambient":true}]}`,
		`{"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"t9","status":"completed","summary":"done"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGk="}}]}]}}`,
	)
	if len(ev) != 6 {
		t.Fatalf("events: %+v", ev)
	}
	if ev[0].Kind != EventThinking || ev[0].Text != "hmm" || ev[1].Mode != ModeAsk || ev[2].Kind != EventCompact || ev[2].Text != "manual" {
		t.Fatalf("events: %+v", ev[:3])
	}
	if len(ev[3].Tasks) != 1 || ev[3].Tasks[0].ID != "b1" || ev[4].Task.Status != "completed" || ev[4].Task.ToolID != "t9" {
		t.Fatalf("tasks: %+v %+v", ev[3], ev[4])
	}
	if len(ev[5].Images) != 1 || string(ev[5].Images[0].Data) != "hi" {
		t.Fatalf("images: %+v", ev[5])
	}
}

func drain(c *claudeConn) []Event {
	var out []Event
	for {
		select {
		case e := <-c.events:
			out = append(out, e)
		default:
			return out
		}
	}
}

func TestClaudeConnReplayAndRewindPoint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newClaudeConn(ctx, cancel, OpenRequest{LastUUID: "start"})
	c.inputs["m1"] = true
	c.handle([]byte(`{"type":"user","isReplay":true,"uuid":"m1","message":{"content":"hi"}}`))
	c.handle([]byte(`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"yo"}]}}`))
	// A subagent's entries aren't the main conversation's.
	c.handle([]byte(`{"type":"assistant","uuid":"sub","parent_tool_use_id":"x","message":{"content":[]}}`))
	// Echoes of messages we didn't send (e.g. command output) are ignored.
	c.handle([]byte(`{"type":"user","isReplay":true,"uuid":"other","message":{"content":"x"}}`))
	c.handle([]byte(`{"type":"result","subtype":"success"}`))
	ev := drain(c)
	if len(ev) != 2 || ev[0].Kind != EventInputTaken || ev[0].InputID != "m1" || ev[0].PrevUUID != "start" {
		t.Fatalf("events: %+v", ev)
	}
	if ev[1].Kind != EventTurnEnd || ev[1].LastUUID != "a1" {
		t.Fatalf("turn end: %+v", ev[1])
	}
}

func TestClaudeConnPermissionRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newClaudeConn(ctx, cancel, OpenRequest{})
	c.handle([]byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test"},"tool_use_id":"t1","decision_reason":"\u001b[1mcareful\u001b[0m","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"localSettings"}]}}`))
	c.handle([]byte(`{"type":"control_cancel_request","request_id":"r1"}`))
	ev := drain(c)
	if len(ev) != 2 || ev[0].Kind != EventPermission || ev[1].Kind != EventPermissionCancel || ev[1].RequestID != "r1" {
		t.Fatalf("events: %+v", ev)
	}
	p := ev[0].Permission
	if p.RequestID != "r1" || p.ToolID != "t1" || p.Reason != "careful" || !p.CanAlways || p.AlwaysLabel != "Bash(npm test:*)" || !strings.Contains(p.Input, "npm test") {
		t.Fatalf("permission: %+v", p)
	}
}

func TestClaudeConnControlResponse(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newClaudeConn(ctx, cancel, OpenRequest{})
	go func() {
		b := <-c.writes
		var req struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal(b, &req)
		c.handle([]byte(`{"type":"control_response","response":{"subtype":"success","request_id":"` + req.RequestID + `","response":{"canRewind":true}}}`))
	}()
	raw, err := c.Control(ctx, "rewind_files", map[string]any{"user_message_id": "m1"})
	if err != nil || !strings.Contains(string(raw), "canRewind") {
		t.Fatalf("got %s, %v", raw, err)
	}
}

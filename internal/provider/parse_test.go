package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func collect(parse lineParser, lines ...string) []Event {
	var out []Event
	for _, l := range lines {
		parse([]byte(l), func(e Event) {
			if e.Kind < eventInputTaken { // skip events internal to providers
				out = append(out, e)
			}
		})
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
	req := Request{Prompt: "look", Env: "native", Attachments: []Attachment{
		{Name: "a.png", MimeType: "image/png", Path: img, IsImage: true},
		{Name: "notes.txt", MimeType: "text/plain", Path: filepath.Join(dir, "notes.txt")},
	}}
	in, err := claudeInput(req.Env, req.Prompt, req.Attachments)
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

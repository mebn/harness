package provider

import "testing"

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

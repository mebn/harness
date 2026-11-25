package provider

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// newTestCodexConn is a conversation without a process: lines go to handle, replies to writes.
func newTestCodexConn(mode string) *codexConn {
	ctx, cancel := context.WithCancel(context.Background())
	return &codexConn{ctx: ctx, cancel: cancel, events: make(chan Event, 256), writes: make(chan []byte, 64),
		done: make(chan struct{}), ready: make(chan struct{}), settings: Settings{Mode: mode},
		calls: map[string]chan rpcReply{}, perms: map[string]*codexRequest{}, items: map[string]*codexItem{},
		streamed: map[string]bool{}}
}

func drainCodex(c *codexConn) []Event {
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

func lastWrite(t *testing.T, c *codexConn) map[string]any {
	t.Helper()
	var last []byte
	for {
		select {
		case b := <-c.writes:
			last = b
			continue
		default:
		}
		break
	}
	if last == nil {
		t.Fatal("nothing written")
	}
	var m map[string]any
	if err := json.Unmarshal(last, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// Lines recorded from codex-cli 0.153.0 (`codex app-server`), trimmed.
const codexTurnLines = `{"method":"turn/started","params":{"threadId":"th","turn":{"id":"turn1","items":[],"status":"inProgress","error":null}}}
{"method":"item/started","params":{"item":{"type":"userMessage","id":"u1","clientId":null,"content":[{"type":"text","text":"hi"}]},"threadId":"th","turnId":"turn1"}}
{"method":"item/started","params":{"item":{"type":"reasoning","id":"rs1","summary":[],"content":[]},"threadId":"th","turnId":"turn1"}}
{"method":"item/completed","params":{"item":{"type":"reasoning","id":"rs1","summary":["Thinking about it"],"content":[]},"threadId":"th","turnId":"turn1"}}
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m1","text":"","phase":"commentary"},"threadId":"th","turnId":"turn1"}}
{"method":"item/agentMessage/delta","params":{"threadId":"th","turnId":"turn1","itemId":"m1","delta":"Creating "}}
{"method":"item/agentMessage/delta","params":{"threadId":"th","turnId":"turn1","itemId":"m1","delta":"it."}}
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"Creating it.","phase":"commentary"},"threadId":"th","turnId":"turn1"}}
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m2","text":"","phase":"final_answer"},"threadId":"th","turnId":"turn1"}}
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m2","text":"Done.","phase":"final_answer"},"threadId":"th","turnId":"turn1"}}
{"method":"item/started","params":{"item":{"type":"commandExecution","id":"cmd1","command":"go test ./...","cwd":"/x","status":"inProgress","commandActions":[],"aggregatedOutput":null,"exitCode":null},"threadId":"th","turnId":"turn1"}}
{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"cmd1","command":"go test ./...","cwd":"/x","status":"completed","commandActions":[],"aggregatedOutput":"FAIL\n","exitCode":1},"threadId":"th","turnId":"turn1"}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"th","turnId":"turn1","tokenUsage":{"total":{"totalTokens":26641},"last":{"totalTokens":14301,"inputTokens":14167},"modelContextWindow":258400}}}
{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":43200,"resetsAt":1797946151},"secondary":null,"planType":"free"}}}
{"method":"turn/completed","params":{"threadId":"th","turn":{"id":"turn1","items":[],"status":"completed","error":null}}}`

func TestCodexTurnEvents(t *testing.T) {
	c := newTestCodexConn(ModeAsk)
	done := make(chan struct{})
	c.running, c.turnDone = true, done
	for _, l := range strings.Split(codexTurnLines, "\n") {
		c.handle([]byte(l))
	}
	select {
	case <-done:
	default:
		t.Fatal("turn/completed didn't end the turn")
	}
	if c.turnID != "turn1" {
		t.Fatalf("turn id %q", c.turnID)
	}
	var text, thinking strings.Builder
	var tools []Event
	var ctxEv, usageEv *Event
	for _, e := range drainCodex(c) {
		switch e.Kind {
		case EventText:
			text.WriteString(e.Text)
		case EventThinking:
			thinking.WriteString(e.Text)
		case EventToolStart, EventToolEnd:
			tools = append(tools, e)
		case EventContext:
			ctxEv = &e
		case EventUsage:
			usageEv = &e
		}
	}
	if got := text.String(); got != "Creating it.\n\nDone." {
		t.Fatalf("text %q", got)
	}
	if thinking.String() != "Thinking about it" {
		t.Fatalf("thinking %q", thinking.String())
	}
	if len(tools) != 2 || tools[0].ToolName != "Shell" || !strings.Contains(tools[0].ToolArgs, "go test") ||
		tools[1].ToolOutput != "FAIL\n" || !tools[1].IsError {
		t.Fatalf("tools %+v", tools)
	}
	if ctxEv == nil || ctxEv.ContextTokens != 14301 || ctxEv.ContextWindow != 258400 {
		t.Fatalf("context %+v", ctxEv)
	}
	if usageEv == nil || len(usageEv.Usage.Windows) != 1 || usageEv.Usage.Windows[0].ID != "month" ||
		usageEv.Usage.Windows[0].Used != 0.25 || usageEv.Usage.Windows[0].ResetsAt != 1797946151000 {
		t.Fatalf("usage %+v", usageEv)
	}
}

const codexFileLines = `{"method":"item/started","params":{"item":{"type":"fileChange","id":"fc1","changes":[{"path":"C:\\x\\probe.txt","kind":{"type":"add"},"diff":"hello\n"}],"status":"inProgress"},"threadId":"th","turnId":"turn1"}}
{"method":"item/fileChange/requestApproval","id":0,"params":{"threadId":"th","turnId":"turn1","itemId":"fc1","startedAtMs":1,"reason":null,"grantRoot":null}}`

func TestCodexFileApproval(t *testing.T) {
	c := newTestCodexConn(ModeAsk)
	for _, l := range strings.Split(codexFileLines, "\n") {
		c.handle([]byte(l))
	}
	var perm *Permission
	for _, e := range drainCodex(c) {
		if e.Kind == EventPermission {
			perm = e.Permission
		}
	}
	if perm == nil || perm.ToolName != "Write" || !strings.Contains(perm.Input, "probe.txt") || !perm.CanAlways {
		t.Fatalf("permission %+v", perm)
	}
	if err := c.Respond(perm.RequestID, map[string]any{"behavior": "allow", "updatedPermissions": []any{}}); err != nil {
		t.Fatal(err)
	}
	r := lastWrite(t, c)
	if r["id"] != float64(0) || r["result"].(map[string]any)["decision"] != "acceptForSession" {
		t.Fatalf("reply %v", r)
	}

	// Accept edits approves file changes without asking.
	c = newTestCodexConn(ModeEdits)
	for _, l := range strings.Split(codexFileLines, "\n") {
		c.handle([]byte(l))
	}
	for _, e := range drainCodex(c) {
		if e.Kind == EventPermission {
			t.Fatal("asked in Accept edits")
		}
	}
	if r := lastWrite(t, c); r["result"].(map[string]any)["decision"] != "accept" {
		t.Fatalf("reply %v", r)
	}
}

func TestCodexUserInput(t *testing.T) {
	c := newTestCodexConn(ModeAsk)
	c.handle([]byte(`{"method":"item/tool/requestUserInput","id":7,"params":{"threadId":"th","turnId":"t","itemId":"i","isBlocking":true,"questions":[{"id":"q1","header":"Color","question":"Which color?","isOther":true,"isSecret":false,"options":[{"label":"Red","description":""},{"label":"Blue","description":""}]}]}}`))
	var perm *Permission
	for _, e := range drainCodex(c) {
		if e.Kind == EventPermission {
			perm = e.Permission
		}
	}
	if perm == nil || perm.ToolName != "AskUserQuestion" || !strings.Contains(perm.Input, `"question":"Which color?"`) {
		t.Fatalf("permission %+v", perm)
	}
	err := c.Respond(perm.RequestID, map[string]any{"behavior": "allow",
		"updatedInput": map[string]any{"answers": map[string]string{"Which color?": "Blue"}}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(lastWrite(t, c)["result"])
	if string(b) != `{"answers":{"q1":{"answers":["Blue"]}}}` {
		t.Fatalf("reply %s", b)
	}
}

func TestSplitUnifiedDiff(t *testing.T) {
	oldText, newText := splitUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")
	if oldText != "a\nb\nc\n" || newText != "a\nB\nc\n" {
		t.Fatalf("%q %q", oldText, newText)
	}
}

func TestSchemaOrder(t *testing.T) {
	got := schemaOrder(json.RawMessage(`{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"number"}}}`))
	if strings.Join(got, ",") != "zeta,alpha" {
		t.Fatalf("%v", got)
	}
}

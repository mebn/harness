package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.jsonl")
	lines := []string{
		`{"type":"mode","mode":"normal"}`,
		`{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-11-23T10:00:00Z","message":{"role":"user","content":"fix the bug"}}`,
		`{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-11-23T10:00:01Z","message":{"content":[{"type":"thinking","thinking":"look first"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.go"}}]}}`,
		`{"type":"user","uuid":"r1","parentUuid":"a1","timestamp":"2026-11-23T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"package a"}]}}`,
		`{"type":"assistant","uuid":"a2","parentUuid":"r1","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"}]}}`,
		`{"type":"assistant","uuid":"a3","parentUuid":"r1","timestamp":"2026-11-23T10:00:03Z","message":{"content":[{"type":"text","text":"Fixed."}]}}`,
		`{"type":"user","uuid":"m1","isMeta":true,"message":{"content":"<system-reminder>x</system-reminder>"}}`,
		`{"type":"user","uuid":"u2","parentUuid":"a3","timestamp":"2026-11-23T10:01:00Z","message":{"content":"<command-name>/compact</command-name>\n<command-args></command-args>"}}`,
		`{"type":"ai-title","aiTitle":"Fix the bug"}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	msgs, last, err := importHistory(path, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 3 || last != "u2" {
		t.Fatalf("%d messages, last %q: %+v", len(msgs), last, msgs)
	}
	u, a, cmd := msgs[0], msgs[1], msgs[2]
	if u.ID != "u1" || u.CLIUUID != "u1" || u.PrevUUID != "" || u.Parts[0].Text != "fix the bug" {
		t.Fatalf("user: %+v", u)
	}
	if len(a.Parts) != 3 || a.Parts[0].Type != "thinking" || a.Parts[1].ToolOutput != "package a" || a.Parts[2].Text != "Fixed." {
		t.Fatalf("reply: %+v", a.Parts)
	}
	if cmd.Parts[0].Text != "/compact" || cmd.PrevUUID != "a3" {
		t.Fatalf("command: %+v", cmd)
	}
	if got := claudeChatTitle(path); got != "Fix the bug" {
		t.Fatalf("title %q", got)
	}
}

func TestClaudeProjectDir(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", `C:\cfg`)
	got, _ := claudeProjectDir(`C:\Users\me\my.repo`)
	if filepath.Base(got) != "C--Users-me-my-repo" {
		t.Fatalf("got %s", got)
	}
}

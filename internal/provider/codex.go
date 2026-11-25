package provider

import (
	"context"
	"os/exec"
	"path/filepath"

	"harness/internal/platform"
)

// Codex drives the OpenAI Codex CLI as an app server (`codex app-server`, JSON-RPC over
// stdio, the protocol of Codex's IDE extensions): one process per conversation, which asks
// before running commands or changing files outside what the permission mode allows.
type Codex struct {
	ids *copilotSessions
}

// NewCodex returns the Codex provider. stateDir holds the map from Harness's session ids to
// Codex's thread ids ("" keeps it in memory).
func NewCodex(stateDir string) Codex {
	path := ""
	if stateDir != "" {
		path = filepath.Join(stateDir, "codex-sessions.json")
	}
	return Codex{ids: newCopilotSessions(path)}
}

func (Codex) Info() Info {
	_, err := exec.LookPath("codex")
	return Info{
		ID:        "codex",
		Name:      "Codex",
		Available: err == nil || platform.HasWSL(),
		Models: []Option{
			{ID: "gpt-5.6-terra", Label: "GPT-5.6 Terra"},
			{ID: "gpt-5.6-luna", Label: "GPT-5.6 Luna"},
		},
		Efforts: []Option{
			{ID: "low", Label: "Low"},
			{ID: "medium", Label: "Medium"},
			{ID: "high", Label: "High"},
			{ID: "xhigh", Label: "Extra high"},
			{ID: "max", Label: "Max"},
		},
		Modes:         allModes,
		DefaultModel:  "gpt-5.6-terra",
		DefaultEffort: "medium",
		Steer:         true,
	}
}

func (c Codex) Open(ctx context.Context, req OpenRequest) (Conn, error) {
	ids := c.ids
	if ids == nil {
		ids = newCopilotSessions("")
	}
	return openCodexConn(ctx, req, ids)
}

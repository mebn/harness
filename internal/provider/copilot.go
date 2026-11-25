package provider

import (
	"context"
	"os/exec"
	"path/filepath"

	"harness/internal/platform"
)

// Copilot drives the GitHub Copilot CLI as an Agent Client Protocol server (`copilot --acp`):
// one process per conversation, which asks before using tools.
type Copilot struct {
	ids *copilotSessions
}

// NewCopilot returns the Copilot provider. stateDir holds the map from Harness's session
// ids to Copilot's ("" keeps it in memory).
func NewCopilot(stateDir string) Copilot {
	path := ""
	if stateDir != "" {
		path = filepath.Join(stateDir, "copilot-sessions.json")
	}
	return Copilot{ids: newCopilotSessions(path)}
}

func (Copilot) Info() Info {
	_, err := exec.LookPath("copilot")
	return Info{
		ID:        "copilot",
		Name:      "Copilot",
		Available: err == nil || platform.HasWSL(),
		Models: []Option{
			{ID: "auto", Label: "Auto"},
			{ID: "claude-opus-5.5", Label: "Opus 5.5"},
			{ID: "claude-sonnet-5.5", Label: "Sonnet 5.5"},
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
		// Copilot has nothing that reviews tool use for the user, so no Auto mode.
		Modes:         []Option{optManual, optEdits, optPlan, optFull},
		DefaultModel:  "auto",
		DefaultEffort: "medium",
	}
}

func (c Copilot) Open(ctx context.Context, req OpenRequest) (Conn, error) {
	ids := c.ids
	if ids == nil {
		ids = newCopilotSessions("")
	}
	return openCopilotConn(ctx, req, ids)
}

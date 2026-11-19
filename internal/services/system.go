package services

import (
	"runtime"

	"harness/internal/platform"
)

// SystemInfo tells the UI which platform features to show.
type SystemInfo struct {
	OS     string `json:"os"`
	HasWSL bool   `json:"hasWsl"`
}

// SystemService describes the machine the server runs on.
// Native dialogs (like the folder picker) are runtime calls handled by the desktop window.
type SystemService struct{}

func (SystemService) Info() SystemInfo {
	return SystemInfo{OS: runtime.GOOS, HasWSL: platform.HasWSL()}
}

// Activity reports active agent turns and open terminals. A plain function rather than a
// method so it isn't exposed to the frontend.
func Activity(c *ChatService, t *TerminalService) (runs, terminals int) {
	c.mu.Lock()
	runs = len(c.runs)
	c.mu.Unlock()
	t.mu.Lock()
	terminals = len(t.terms)
	t.mu.Unlock()
	return runs, terminals
}

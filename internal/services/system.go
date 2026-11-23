package services

import (
	"os"
	"runtime"

	"harness/internal/platform"
)

// SystemInfo tells the UI which platform features to show.
type SystemInfo struct {
	OS     string `json:"os"`
	HasWSL bool   `json:"hasWsl"`
	// Hostname of the machine the server runs on.
	Hostname string `json:"hostname"`
}

// SystemService describes the machine the server runs on.
// Native dialogs (like the folder picker) are runtime calls handled by the desktop window.
type SystemService struct{}

func (SystemService) Info() SystemInfo {
	host, _ := os.Hostname()
	return SystemInfo{OS: runtime.GOOS, HasWSL: platform.HasWSL(), Hostname: host}
}

// Activity reports active agent turns and open terminals. A plain function rather than a
// method so it isn't exposed to the frontend.
func Activity(c *ChatService, t *TerminalService) (runs, terminals int) {
	runs = c.activity()
	t.mu.Lock()
	terminals = len(t.terms)
	t.mu.Unlock()
	return runs, terminals
}

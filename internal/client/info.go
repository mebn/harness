// Package client finds, starts and talks to the background Harness server. It is the
// contract between the server and its clients (the desktop app in cmd/harness).
//
// The server process owns the database, agent runs and terminals. Desktop windows are
// clients: they find the server through an info file in the data directory, start it if
// needed, and authenticate every request with the token from that file.
package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// TokenHeader carries the auth token on requests from desktop clients.
const TokenHeader = "X-Harness-Token"

// ClientHeader tells the server what kind of client opened the event stream; the desktop app
// sends ClientDesktop.
const (
	ClientHeader  = "X-Harness-Client"
	ClientDesktop = "desktop"
)

// EventQuit tells connected windows the server is quitting on purpose (from its tray menu), so
// they quit too instead of starting it again. A restart into a new build doesn't send it.
const EventQuit = "server:quit"

// EventQuickToggle asks the desktop app to show or hide the quick chat (its hotkey was pressed).
const EventQuickToggle = "quick:toggle"

// QuickArg starts the desktop app with only the quick chat, or (to a running one) shows or
// hides it. The server passes it when the quick chat's hotkey is pressed with no window open.
const QuickArg = "--quick"

// AttachmentsPath is where the UI loads attachments from; the server serves it.
const AttachmentsPath = "/attachments/"

// DataDir holds the database, the server info file, lock and log. HARNESS_DB (a database
// path) moves all of it, so separate databases get separate servers.
func DataDir() (string, error) {
	if p := os.Getenv("HARNESS_DB"); p != "" {
		return filepath.Dir(p), nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "harness"), nil
}

// Info is how clients find and authenticate with a running server.
type Info struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// BaseURL is the server's local HTTP address.
func (i Info) BaseURL() string { return fmt.Sprintf("http://127.0.0.1:%d", i.Port) }

// Status describes what the server is doing.
type Status struct {
	PID        int   `json:"pid"`
	ExeModTime int64 `json:"exeModTime"` // mod time (ms) of the server binary when it started
	Runs       int   `json:"runs"`       // active agent turns
	Terminals  int   `json:"terminals"`  // open shells
}

// ConnectionPath is where the UI asks whether the server is reachable before loading.
// The desktop window answers it itself (starting the server if needed); the server answers
// it for browsers.
const ConnectionPath = "/harness/connection"

// Connection answers ConnectionPath.
type Connection struct {
	Connected bool   `json:"connected"`
	Error     string `json:"error,omitempty"`
	LogPath   string `json:"logPath,omitempty"`
}

func infoPath(dataDir string) string { return filepath.Join(dataDir, "server.json") }

// ReadInfo loads the info file written by a running server.
func ReadInfo(dataDir string) (Info, error) {
	var info Info
	data, err := os.ReadFile(infoPath(dataDir))
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return info, err
	}
	if info.Port == 0 || info.Token == "" {
		return info, fmt.Errorf("incomplete server info")
	}
	return info, nil
}

// WriteInfo atomically replaces the info file. Only the current user may read it.
func WriteInfo(dataDir string, info Info) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}
	tmp := infoPath(dataDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, infoPath(dataDir))
}

// RemoveInfo deletes the info file if it still belongs to pid.
func RemoveInfo(dataDir string, pid int) {
	if info, err := ReadInfo(dataDir); err == nil && info.PID == pid {
		_ = os.Remove(infoPath(dataDir))
	}
}

// ExeModTime returns the mod time (ms) of a file, or 0 if unknown.
func ExeModTime(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.ModTime().UnixMilli()
}

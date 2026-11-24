// Package server runs and finds the background Harness server.
//
// The server process owns the database, agent runs and terminals. Desktop windows are
// clients: they find the server through an info file in the data directory, start it if
// needed, and authenticate every request with the token from that file.
package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// TokenHeader carries the auth token on requests from desktop clients.
const TokenHeader = "X-Harness-Token"

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

// writeInfo atomically replaces the info file. Only the current user may read it.
func writeInfo(dataDir string, info Info) error {
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

// removeInfo deletes the info file if it still belongs to pid.
func removeInfo(dataDir string, pid int) {
	if info, err := ReadInfo(dataDir); err == nil && info.PID == pid {
		_ = os.Remove(infoPath(dataDir))
	}
}

// exeModTime returns the mod time (ms) of a file, or 0 if unknown.
func exeModTime(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.ModTime().UnixMilli()
}

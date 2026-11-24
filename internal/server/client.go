package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	startTimeout = 20 * time.Second
	pollInterval = 150 * time.Millisecond
	maxLogSize   = 5 << 20
)

// Client finds the server, starting it when needed, and keeps it alive while connected.
type Client struct {
	dataDir string
	exe     string // server binary to start

	mu   sync.Mutex
	info *Info
	http *http.Client
}

// NewClient creates a client for the server binary exe using dataDir for discovery.
func NewClient(dataDir, exe string) *Client {
	return &Client{dataDir: dataDir, exe: exe, http: &http.Client{Timeout: 2 * time.Second}}
}

// Current returns the connected server, connecting (and starting it) if needed.
func (c *Client) Current(ctx context.Context) (Info, error) {
	c.mu.Lock()
	if c.info != nil {
		info := *c.info
		c.mu.Unlock()
		return info, nil
	}
	c.mu.Unlock()
	return c.Ensure(ctx)
}

// Invalidate forgets info after a failed request, so the next call reconnects.
func (c *Client) Invalidate(info Info) {
	c.mu.Lock()
	if c.info != nil && c.info.Token == info.Token {
		c.info = nil
	}
	c.mu.Unlock()
}

// Ensure connects to a healthy server, starting one if none is running.
// A server running an older binary is replaced by the new one, but only when nothing
// would be lost: no agent turn running and no terminal open.
func (c *Client) Ensure(ctx context.Context) (Info, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.info != nil {
		if _, err := c.status(ctx, *c.info); err == nil {
			return *c.info, nil
		}
		c.info = nil
	}

	if info, err := ReadInfo(c.dataDir); err == nil {
		if st, err := c.status(ctx, info); err == nil {
			if !c.outdated(st) || st.Runs > 0 || st.Terminals > 0 {
				c.info = &info
				return info, nil
			}
			// Restart into the newer binary while nothing is running.
			_ = c.shutdown(ctx, info)
			c.waitGone(ctx, info)
		}
	}

	exited, err := c.spawn()
	if err != nil {
		return Info{}, err
	}
	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return Info{}, ctx.Err()
		case code := <-exited:
			exited = nil // it's gone; keep waiting only if another server holds the lock
			if code != 0 {
				return Info{}, fmt.Errorf("harness server exited during startup (code %d)%s", code, c.logTail())
			}
		case <-time.After(pollInterval):
		}
		info, err := ReadInfo(c.dataDir)
		if err != nil {
			continue
		}
		if _, err := c.status(ctx, info); err == nil {
			c.info = &info
			return info, nil
		}
	}
	return Info{}, fmt.Errorf("harness server did not start within %s%s", startTimeout, c.logTail())
}

// LogPath is where the server writes its output.
func (c *Client) LogPath() string { return filepath.Join(c.dataDir, "server.log") }

// logTail is the end of the server log, to show why it didn't start.
func (c *Client) logTail() string {
	data, err := os.ReadFile(c.LogPath())
	if err != nil || len(data) == 0 {
		return ""
	}
	if len(data) > 1500 {
		data = data[len(data)-1500:]
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) > 8 {
		lines = lines[len(lines)-8:]
	}
	return "\n\n" + strings.Join(lines, "\n")
}

// Ping reports whether a server answers at info.
func Ping(info Info) bool {
	c := &Client{http: &http.Client{Timeout: 2 * time.Second}}
	_, err := c.status(context.Background(), info)
	return err == nil
}

func (c *Client) outdated(st Status) bool {
	mod := exeModTime(c.exe)
	return mod != 0 && st.ExeModTime != 0 && mod > st.ExeModTime
}

func (c *Client) status(ctx context.Context, info Info) (Status, error) {
	var st Status
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.BaseURL()+"/api/status", nil)
	if err != nil {
		return st, err
	}
	req.Header.Set(TokenHeader, info.Token)
	resp, err := c.http.Do(req)
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return st, errors.New(resp.Status)
	}
	return st, json.NewDecoder(resp.Body).Decode(&st)
}

func (c *Client) shutdown(ctx context.Context, info Info) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, info.BaseURL()+"/api/shutdown", nil)
	if err != nil {
		return err
	}
	req.Header.Set(TokenHeader, info.Token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *Client) waitGone(ctx context.Context, info Info) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := c.status(ctx, info); err != nil {
			return
		}
		time.Sleep(pollInterval)
	}
}

// spawn starts the server detached, so it outlives this process. Output goes to server.log.
// The channel receives its exit code if it exits while this process is still running.
func (c *Client) spawn() (<-chan int, error) {
	if _, err := os.Stat(c.exe); err != nil {
		return nil, fmt.Errorf("harness server binary not found: %w", err)
	}
	if err := os.MkdirAll(c.dataDir, 0o700); err != nil {
		return nil, err
	}
	logPath := c.LogPath()
	if st, err := os.Stat(logPath); err == nil && st.Size() > maxLogSize {
		_ = os.Remove(logPath)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()

	cmd, err := StartDetached(c.exe, logFile, serverEnv())
	if err != nil {
		return nil, err
	}
	exited := make(chan int, 1)
	go func() {
		_ = cmd.Wait()
		exited <- cmd.ProcessState.ExitCode()
	}()
	return exited, nil
}

// serverEnv is this process's environment minus what only makes sense for a window.
// In `wails3 dev` the window gets FRONTEND_DEVSERVER_URL; a dev-built server that inherits
// it waits for Vite at startup and exits when it isn't there (and would outlive it anyway).
func serverEnv() []string {
	env := os.Environ()
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(strings.ToUpper(kv), "FRONTEND_DEVSERVER_URL=") {
			out = append(out, kv)
		}
	}
	return out
}

// StartDetached starts exe so it outlives this process (no console, own process group,
// outside the parent's job object when allowed). out receives its output; nil discards it.
// env nil means this process's environment. The caller may Wait on the returned command.
func StartDetached(exe string, out *os.File, env []string) (*exec.Cmd, error) {
	start := func(breakaway bool) (*exec.Cmd, error) {
		cmd := exec.Command(exe)
		cmd.Dir = filepath.Dir(exe)
		cmd.Env = env
		if out != nil {
			cmd.Stdout, cmd.Stderr = out, out
		}
		detach(cmd, breakaway)
		return cmd, cmd.Start()
	}
	// Breaking away from a job object (used by some launchers) can be denied; then start inside it.
	if cmd, err := start(true); err == nil {
		return cmd, nil
	}
	return start(false)
}

package services

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aymanbagabas/go-pty"
	"github.com/google/uuid"

	"harness/internal/platform"
	"harness/internal/store"
)

// TerminalService runs interactive shells in pseudo-terminals.
type TerminalService struct {
	store *store.Store
	emit  Emitter

	mu    sync.Mutex
	terms map[string]pty.Pty
	// The shell's process id, for shells whose commands can be seen (native, not as admin).
	pids map[string]int
}

func NewTerminalService(s *store.Store, emit Emitter) *TerminalService {
	return &TerminalService{store: s, emit: emit, terms: map[string]pty.Pty{}, pids: map[string]int{}}
}

// Start opens a shell in the project's folder or its worktree (or home if projectID is empty).
// With admin (Windows only) the shell runs as administrator, after a UAC prompt.
func (t *TerminalService) Start(projectID, worktree string, admin bool, cols, rows int) (string, error) {
	dir, _ := os.UserHomeDir()
	env := platform.EnvNative
	if projectID != "" {
		loc, err := locate(t.store, projectID, worktree)
		if err != nil {
			return "", err
		}
		dir, env = loc.Dir, loc.Env
	}

	name, args := platform.ShellCommand(env, dir)
	if admin {
		if env.Normalize() != platform.EnvNative {
			return "", errors.New("administrator terminals are only available for Windows folders")
		}
		var err error
		if name, args, err = platform.AdminShellCommand(dir); err != nil {
			return "", err
		}
	}
	// A WSL shell's commands run inside the distro, and an admin shell sits behind sudo: their
	// processes can't be told apart from the shell's own here.
	track := env.Normalize() == platform.EnvNative && !admin
	return t.spawn(name, args, dir, env, terminalEnv(), track, cols, rows)
}

// startCommand runs one command (not a shell) in a terminal, in the home folder of env, with
// the environment vars (nil = a shell's). Its output streams like a shell's, and the terminal
// closes when it exits.
func (t *TerminalService) startCommand(env platform.Env, name string, args, vars []string, cols, rows int) (string, error) {
	dir, _ := os.UserHomeDir()
	if env.Normalize() == platform.EnvWSL {
		args = append([]string{"--cd", "~", "-e", "bash", "-lic", `exec "$0" "$@"`, name}, args...)
		name = "wsl.exe"
	} else if platform.IsWindows() {
		// Batch-file shims (npm installs) only run through cmd.
		if p, err := exec.LookPath(name); err == nil {
			name = p
			if ext := strings.ToLower(filepath.Ext(p)); ext == ".cmd" || ext == ".bat" {
				args = append([]string{"/c", p}, args...)
				name = "cmd.exe"
			}
		}
	}
	if vars == nil {
		vars = terminalEnv()
	}
	return t.spawn(name, args, dir, env, vars, false, cols, rows)
}

// spawn starts name in a new pseudo-terminal, with the environment vars, and streams its output
// as term:data events. track records its process id so Busy can look for child processes.
func (t *TerminalService) spawn(name string, args []string, dir string, env platform.Env, vars []string, track bool, cols, rows int) (string, error) {
	p, err := pty.New()
	if err != nil {
		return "", err
	}
	if cols > 0 && rows > 0 {
		_ = p.Resize(cols, rows)
	}
	cmd := p.Command(name, args...)
	if env.Normalize() == platform.EnvNative {
		cmd.Dir = dir
	}
	cmd.Env = vars
	if err := cmd.Start(); err != nil {
		p.Close()
		return "", err
	}

	id := uuid.NewString()
	t.mu.Lock()
	t.terms[id] = p
	if track && cmd.Process != nil {
		t.pids[id] = cmd.Process.Pid
	}
	t.mu.Unlock()

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				t.emit(EventTermData, TermData{ID: id, Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		_ = cmd.Wait()
		t.Close(id)
		t.emit(EventTermExit, TermExit{ID: id})
	}()
	return id, nil
}

func (t *TerminalService) get(id string) (pty.Pty, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.terms[id]
	if !ok {
		return nil, errors.New("terminal not found")
	}
	return p, nil
}

func (t *TerminalService) Write(id, data string) error {
	p, err := t.get(id)
	if err != nil {
		return err
	}
	_, err = p.Write([]byte(data))
	return err
}

func (t *TerminalService) Resize(id string, cols, rows int) error {
	p, err := t.get(id)
	if err != nil {
		return err
	}
	return p.Resize(cols, rows)
}

// Busy returns the terminals among ids that are running a command (the shell has a child
// process). Terminals where that can't be seen (WSL, administrator) are never busy.
func (t *TerminalService) Busy(ids []string) []string {
	t.mu.Lock()
	pids := map[string]int{}
	for _, id := range ids {
		if pid, ok := t.pids[id]; ok {
			pids[id] = pid
		}
	}
	t.mu.Unlock()
	busy := []string{}
	for id, pid := range pids {
		if platform.HasChildProcesses(pid) {
			busy = append(busy, id)
		}
	}
	return busy
}

func (t *TerminalService) Close(id string) {
	t.mu.Lock()
	p, ok := t.terms[id]
	delete(t.terms, id)
	delete(t.pids, id)
	t.mu.Unlock()
	if ok {
		_ = p.Close()
	}
}

// ServiceShutdown is a Wails lifecycle hook: close all shells on exit.
func (t *TerminalService) ServiceShutdown() error {
	t.mu.Lock()
	ids := make([]string, 0, len(t.terms))
	for id := range t.terms {
		ids = append(ids, id)
	}
	t.mu.Unlock()
	for _, id := range ids {
		t.Close(id)
	}
	return nil
}

// terminalEnv is the server's environment adjusted for an interactive xterm.js terminal.
// The server inherits whatever launched it, which may be a tool that turns colours off
// (NO_COLOR) or sets TERM for something else, and every shell would inherit that too.
func terminalEnv() []string {
	drop := map[string]bool{"NO_COLOR": true, "TERM": true, "COLORTERM": true}
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if !drop[strings.ToUpper(name)] {
			env = append(env, kv)
		}
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
}

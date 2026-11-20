package services

import (
	"encoding/base64"
	"errors"
	"os"
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
}

func NewTerminalService(s *store.Store, emit Emitter) *TerminalService {
	return &TerminalService{store: s, emit: emit, terms: map[string]pty.Pty{}}
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

	p, err := pty.New()
	if err != nil {
		return "", err
	}
	if cols > 0 && rows > 0 {
		_ = p.Resize(cols, rows)
	}
	name, args := platform.ShellCommand(env, dir)
	if admin {
		if env.Normalize() != platform.EnvNative {
			p.Close()
			return "", errors.New("administrator terminals are only available for Windows folders")
		}
		var err error
		if name, args, err = platform.AdminShellCommand(dir); err != nil {
			p.Close()
			return "", err
		}
	}
	cmd := p.Command(name, args...)
	if env.Normalize() == platform.EnvNative {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	if err := cmd.Start(); err != nil {
		p.Close()
		return "", err
	}

	id := uuid.NewString()
	t.mu.Lock()
	t.terms[id] = p
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

func (t *TerminalService) Close(id string) {
	t.mu.Lock()
	p, ok := t.terms[id]
	delete(t.terms, id)
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

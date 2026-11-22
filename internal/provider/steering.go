package provider

import "sync"

// Input is a user message sent into a turn that is already running.
type Input struct {
	ID          string
	Prompt      string
	Attachments []Attachment
}

// Steering carries messages into a running turn. A provider that can take input mid-turn
// opens it; for the others Send always reports false and the caller falls back to
// interrupting the turn.
type Steering struct {
	mu      sync.Mutex
	write   func(Input) error
	closeIn func()
	closed  bool
	// waiting holds ids of messages written to the agent that it has not taken in yet,
	// oldest first. "" is the turn's opening prompt.
	waiting []string
}

func NewSteering() *Steering { return &Steering{} }

// Send writes a message into the running turn. It reports false when the turn can't take
// it: the provider doesn't support steering, or the turn has finished.
func (s *Steering) Send(in Input) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.write == nil || s.closed {
		return false
	}
	if s.write(in) != nil {
		return false
	}
	s.waiting = append(s.waiting, in.ID)
	return true
}

// open starts accepting messages, writing the opening prompt first.
func (s *Steering) open(first Input, write func(Input) error, closeIn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.write, s.closeIn = write, closeIn
	s.waiting = append([]string{""}, s.waiting...)
	if write(first) != nil {
		s.closed = true
		closeIn()
	}
}

// taken records that the agent took in the oldest waiting message and returns its id.
func (s *Steering) taken() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.waiting) == 0 {
		return "", false
	}
	id := s.waiting[0]
	s.waiting = s.waiting[1:]
	return id, true
}

// turnEnded ends the input once the agent has taken in every message: a message still
// waiting starts another round, so input stays open for it.
func (s *Steering) turnEnded() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	// Only the opening prompt left means the CLI doesn't echo input back; don't wait for it.
	if len(s.waiting) == 1 && s.waiting[0] == "" {
		s.waiting = nil
	}
	if len(s.waiting) == 0 {
		s.closed = true
		s.closeIn()
	}
}

// shutdown stops accepting messages once the process has exited.
func (s *Steering) shutdown() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

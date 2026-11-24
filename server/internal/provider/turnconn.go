package provider

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// turnRunner runs one turn as its own process and streams its events until it exits.
type turnRunner func(ctx context.Context, req Request) (<-chan Event, error)

// turnConn is a Conn for providers that run a process per turn. It can't take messages
// mid-turn and never starts turns on its own.
type turnConn struct {
	run    turnRunner
	base   OpenRequest
	ctx    context.Context
	cancel context.CancelFunc
	events chan Event
	wg     sync.WaitGroup

	mu         sync.Mutex
	settings   Settings
	resume     bool
	turnCancel context.CancelFunc // set while a turn runs
	closed     bool
}

// OpenPerTurn returns a Conn that runs each turn with run (used by tests and simple providers).
func OpenPerTurn(ctx context.Context, req OpenRequest, run func(ctx context.Context, req Request) (<-chan Event, error)) Conn {
	return openTurnConn(ctx, req, run)
}

func openTurnConn(ctx context.Context, req OpenRequest, run turnRunner) *turnConn {
	ctx, cancel := context.WithCancel(ctx)
	c := &turnConn{run: run, base: req, ctx: ctx, cancel: cancel, events: make(chan Event, 64),
		settings: req.Settings, resume: req.Resume}
	go func() {
		<-ctx.Done()
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		c.wg.Wait()
		close(c.events)
	}()
	return c
}

func (c *turnConn) Events() <-chan Event { return c.events }

func (c *turnConn) emit(e Event) {
	select {
	case c.events <- e:
	case <-c.ctx.Done():
	}
}

func (c *turnConn) Send(in Input) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("conversation closed")
	}
	if c.turnCancel != nil {
		return errors.New("a turn is already running")
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.turnCancel = cancel
	req := Request{Prompt: in.Prompt, Dir: c.base.Dir, Env: c.base.Env, Settings: c.settings,
		SessionID: c.base.SessionID, Attachments: in.Attachments, Resume: c.resume}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer cancel()
		c.emit(Event{Kind: EventInputTaken, InputID: in.ID})
		gotOutput := false
		events, err := c.run(ctx, req)
		if err != nil {
			c.emit(Event{Kind: EventError, Text: err.Error()})
		} else {
			for e := range events {
				gotOutput = gotOutput || e.Kind != EventError
				c.emit(e)
			}
		}
		c.mu.Lock()
		c.turnCancel = nil
		if gotOutput {
			c.resume = true
		}
		c.mu.Unlock()
		c.emit(Event{Kind: EventTurnEnd})
	}()
	return nil
}

func (c *turnConn) Apply(s Settings) error {
	c.mu.Lock()
	c.settings = s
	c.mu.Unlock()
	return nil
}

func (c *turnConn) Interrupt() error {
	c.mu.Lock()
	cancel := c.turnCancel
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

func (c *turnConn) Respond(string, map[string]any) error { return ErrUnsupported }

func (c *turnConn) Control(context.Context, string, map[string]any) (json.RawMessage, error) {
	return nil, ErrUnsupported
}

func (c *turnConn) Close() { c.cancel() }

// Package provider wraps agent CLIs (Claude Code, Copilot) behind one streaming interface.
package provider

import (
	"context"

	"harness/internal/platform"
)

// Option is a selectable value (model, effort level, permission mode).
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Info describes a provider and the choices it supports.
type Info struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Available     bool     `json:"available"`
	Models        []Option `json:"models"`
	Efforts       []Option `json:"efforts"`
	Modes         []Option `json:"modes"`
	DefaultModel  string   `json:"defaultModel"`
	DefaultEffort string   `json:"defaultEffort"`
}

// Permission modes shared by all providers; each maps them to its own flags.
const (
	ModeFull  = "full"
	ModeEdits = "edits"
	ModePlan  = "plan"
)

var commonModes = []Option{
	{ID: ModeFull, Label: "Full access"},
	{ID: ModeEdits, Label: "Accept edits"},
	{ID: ModePlan, Label: "Plan"},
}

// Request is one user turn sent to a provider.
type Request struct {
	Prompt    string
	Dir       string
	Env       platform.Env
	Model     string
	Effort    string
	Mode      string
	SessionID string // provider-side session id
	Resume    bool   // true when SessionID already exists on the provider side
}

type EventKind int

const (
	EventText EventKind = iota
	EventToolStart
	EventToolEnd
	EventError
)

// Event is a normalized streaming event from a provider.
type Event struct {
	Kind       EventKind
	Text       string
	ToolID     string
	ToolName   string
	ToolInput  string
	ToolOutput string
	IsError    bool
}

// Provider runs one turn and streams events until the channel closes.
type Provider interface {
	Info() Info
	Run(ctx context.Context, req Request) (<-chan Event, error)
}

// Registry holds providers in display order.
type Registry struct {
	order []string
	byID  map[string]Provider
}

func NewRegistry(providers ...Provider) *Registry {
	r := &Registry{byID: map[string]Provider{}}
	for _, p := range providers {
		id := p.Info().ID
		r.order = append(r.order, id)
		r.byID[id] = p
	}
	return r
}

func (r *Registry) Get(id string) (Provider, bool) {
	p, ok := r.byID[id]
	return p, ok
}

func (r *Registry) Default() Provider { return r.byID[r.order[0]] }

func (r *Registry) Infos() []Info {
	out := make([]Info, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id].Info())
	}
	return out
}

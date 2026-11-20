// Package provider wraps agent CLIs (Claude Code, Copilot) behind one streaming interface.
package provider

import (
	"context"

	"harness/internal/platform"
	"harness/internal/usage"
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
	// Attachments are files saved on the host; providers decide how to pass them.
	Attachments []Attachment
	Resume      bool // true when SessionID already exists on the provider side
}

// Attachment is a file the user attached to a turn.
type Attachment struct {
	Name     string
	MimeType string
	Path     string // host path
	IsImage  bool
}

type EventKind int

const (
	EventText EventKind = iota
	EventToolStart
	EventToolEnd
	EventError
	EventUsage   // plan usage limits reported by the provider
	EventContext // context window usage of the conversation so far
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
	// ParentID is set on tool calls a subagent made: the id of the Agent tool call running it.
	ParentID string
	// Subagent is the agent type of an Agent tool call (e.g. "Explore"); "" for other tools.
	Subagent string
	// Set on an Agent tool's result when the CLI reports them.
	AgentStats *AgentStats
	Usage      *usage.Snapshot // set for EventUsage
	// EventContext: tokens currently in context, and the model's window (0 = not reported).
	ContextTokens int64
	ContextWindow int64
}

// AgentStats summarizes a finished subagent run.
type AgentStats struct {
	ToolUses   int
	Tokens     int64
	DurationMs int64
}

// IsAgentTool reports whether a tool call starts a subagent (named Task in older CLIs).
func IsAgentTool(name string) bool { return name == "Agent" || name == "Task" }

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

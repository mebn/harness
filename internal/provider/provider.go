// Package provider wraps agent CLIs (Claude Code, Copilot) behind one streaming interface.
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"sync"

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
	ID string `json:"id"`
	// Tool is the agent CLI behind it ("claude", "codex", "copilot"); several accounts of one
	// CLI are separate providers with the same Tool.
	Tool string `json:"tool"`
	Name string `json:"name"`
	// Account names the account it signs in as (a name or email), "" when not known.
	Account string `json:"account"`
	// AccountNo numbers the CLI's accounts from 1 (the CLI's own sign-in) when it has more
	// than one; 0 otherwise.
	AccountNo     int      `json:"accountNo"`
	Available     bool     `json:"available"`
	Models        []Option `json:"models"`
	Efforts       []Option `json:"efforts"`
	Modes         []Option `json:"modes"`
	DefaultModel  string   `json:"defaultModel"`
	DefaultEffort string   `json:"defaultEffort"`
	// Steer is true when messages can be sent into a running turn; otherwise steering
	// interrupts the turn and sends the message as a new one.
	Steer bool `json:"steer"`
	// Fast is true when the provider has a fast mode.
	Fast bool `json:"fast"`
	// Interactive is true when the provider asks before using tools, takes slash commands,
	// and can rewind and fork conversations.
	Interactive bool `json:"interactive"`
}

// Permission modes, named as in Claude Code; each provider maps them to its own flags.
const (
	ModeAuto  = "auto" // a reviewer (not the user) approves or denies tool use
	ModeAsk   = "ask"  // "Manual mode": ask before tools that need permission
	ModeEdits = "edits"
	ModePlan  = "plan"
	ModeFull  = "full"
)

var (
	optAuto   = Option{ID: ModeAuto, Label: "Auto mode"}
	optManual = Option{ID: ModeAsk, Label: "Manual mode"}
	optEdits  = Option{ID: ModeEdits, Label: "Accept edits"}
	optPlan   = Option{ID: ModePlan, Label: "Plan mode"}
	optFull   = Option{ID: ModeFull, Label: "Full access"}

	// allModes are every mode, for providers that have them all.
	allModes = []Option{optAuto, optManual, optEdits, optPlan, optFull}
)

// Settings are the per-session choices a conversation runs with.
type Settings struct {
	Model  string
	Effort string
	Mode   string
	Fast   bool // fast mode, when the provider has one
}

// OpenRequest starts a conversation with a provider.
type OpenRequest struct {
	Dir string
	Env platform.Env
	// Admin runs the agent as administrator (native Windows only), after a UAC prompt.
	Admin bool
	Settings
	SessionID string // provider-side session id
	Resume    bool   // true when SessionID already exists on the provider side
	// ForkFrom, when set, starts SessionID as a copy of that provider session, cut after the
	// entry ResumeAt ("" = the whole conversation).
	ForkFrom string
	ResumeAt string
	// LastUUID is the id of the conversation's latest entry, carried over from earlier runs.
	LastUUID string
	// ConfigDir is the CLI's config directory for the account it runs as ("" = its default).
	ConfigDir string
}

// Request is one user turn for providers that run a process per turn.
type Request struct {
	Prompt string
	Dir    string
	Env    platform.Env
	Settings
	SessionID string
	// Attachments are files saved on the host; providers decide how to pass them.
	Attachments []Attachment
	Resume      bool
}

// Attachment is a file the user attached to a turn.
type Attachment struct {
	Name     string
	MimeType string
	Path     string // host path
	IsImage  bool
}

// Input is a user message sent to a conversation.
type Input struct {
	ID          string // a UUID; Claude Code keeps it as the message's id
	Prompt      string
	Attachments []Attachment
}

// ErrUnsupported is returned for requests a provider can't handle.
var ErrUnsupported = errors.New("not supported by this provider")

// Conn is a conversation with a provider. Claude keeps one CLI process per conversation,
// so it takes messages mid-turn and starts turns on its own (when a background task ends);
// other providers run a process per turn behind the same interface.
type Conn interface {
	// Events streams everything the provider reports, across turns. It closes when the
	// conversation ends (the process exited or Close was called).
	Events() <-chan Event
	// Send starts a turn, or steers the message into the running one.
	Send(in Input) error
	// Apply changes settings for the turns that follow (the running one too, where possible).
	Apply(s Settings) error
	// Interrupt stops the running turn.
	Interrupt() error
	// Respond answers a permission request (EventPermission).
	Respond(requestID string, result map[string]any) error
	// Control sends a provider-specific request and waits for its reply.
	Control(ctx context.Context, subtype string, fields map[string]any) (json.RawMessage, error)
	Close()
}

type EventKind int

const (
	EventText EventKind = iota
	EventThinking
	EventToolStart
	EventToolEnd
	EventError
	EventUsage   // plan usage limits reported by the provider
	EventContext // context window usage of the conversation so far
	// EventInputTaken: the agent took in a message sent with Send (InputID says which;
	// PrevUUID is the conversation entry before it, "" at the start).
	EventInputTaken
	// EventFast: the provider reported fast mode's state (FastState, FastOffReason).
	EventFast
	// EventTurnEnd: the agent finished responding to everything it has taken in.
	// LastUUID is the conversation's latest entry.
	EventTurnEnd
	EventPermission       // the agent asks to use a tool (Permission)
	EventPermissionCancel // a permission request was withdrawn (RequestID)
	EventTasks            // the background tasks running now (Tasks)
	EventTaskDone         // a background task ended (Task)
	EventCompact          // the conversation was compacted (Text: "manual" | "auto")
	EventCommands         // the slash commands available (Commands)
	EventMode             // the provider changed permission mode itself (Mode)
)

// Event is a normalized streaming event from a provider.
type Event struct {
	Kind     EventKind
	Text     string
	ToolID   string
	ToolName string
	// ToolInput is a one-line summary of the input; ToolArgs the full input as JSON.
	ToolInput  string
	ToolArgs   string
	ToolOutput string
	// Images a tool returned.
	Images  []Image
	IsError bool
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
	InputID       string // EventInputTaken
	PrevUUID      string // EventInputTaken
	LastUUID      string // EventTurnEnd
	FastState     string // EventFast: "on" | "off" | "cooldown"
	FastOffReason string // EventFast: why fast mode is off, e.g. "extra_usage_disabled"
	Permission    *Permission
	RequestID     string // EventPermissionCancel
	Tasks         []Task
	Task          *Task
	Commands      []Command
	Mode          string
}

// Image is an image a tool returned.
type Image struct {
	MimeType string
	Data     []byte
}

// Permission is a request to use a tool, or (with Elicitation set) a request for input
// from an MCP server.
type Permission struct {
	RequestID string `json:"requestId"`
	ToolName  string `json:"toolName"`
	ToolID    string `json:"toolId"`
	// Input is the tool's input as JSON.
	Input       string `json:"input"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// Reason says why the provider asks (e.g. a safety check).
	Reason      string `json:"reason"`
	BlockedPath string `json:"blockedPath"`
	// Suggestions are rules that would allow this call from now on (raw JSON array).
	Suggestions json.RawMessage `json:"-"`
	// CanAlways is true when "allow always" may be offered.
	CanAlways bool `json:"canAlways"`
	// AlwaysLabel describes what "allow always" would allow.
	AlwaysLabel string `json:"alwaysLabel"`
	AgentID     string `json:"agentId"`
	// Feedback is true when a denial can carry a message telling the agent what to do instead.
	Feedback bool `json:"feedback"`
	// Elicitation is set when an MCP server asks the user for input instead of a tool asking
	// to run. The answer is {action: "accept"|"decline"|"cancel", content}.
	Elicitation *Elicitation `json:"elicitation,omitempty"`
}

// Elicitation is an MCP server's request for input: a form (Schema) or a URL to visit.
type Elicitation struct {
	Server  string `json:"server"`
	Message string `json:"message"`
	Mode    string `json:"mode"` // "form" | "url"
	URL     string `json:"url"`
	// Schema is the JSON Schema of the requested object (form mode), as JSON.
	Schema string `json:"schema"`
	// Order lists Schema's top-level properties in the order the server gave them.
	Order []string `json:"order"`
}

// Task is a background task (a shell command, subagent or monitor).
type Task struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Description string `json:"description"`
	ToolID      string `json:"toolId"`
	// Set when it ended (EventTaskDone): "completed" | "failed" | "stopped".
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

// Command is a slash command.
type Command struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	ArgumentHint string   `json:"argumentHint"`
	Aliases      []string `json:"aliases"`
	Builtin      bool     `json:"builtin"`
}

// AgentStats summarizes a finished subagent run.
type AgentStats struct {
	ToolUses   int
	Tokens     int64
	DurationMs int64
}

// IsAgentTool reports whether a tool call starts a subagent (named Task in older CLIs).
func IsAgentTool(name string) bool { return name == "Agent" || name == "Task" }

// Provider opens conversations.
type Provider interface {
	Info() Info
	Open(ctx context.Context, req OpenRequest) (Conn, error)
}

// Account is a sign-in of an agent CLI kept apart from its default one, in a config directory
// of its own.
type Account struct {
	ID    string // unique; the provider's id is "<tool>@<ID>"
	Tool  string
	Label string // a name or email, "" when not known
	Dir   string // the CLI's config directory (a host path)
}

// ProviderID is the id of the provider that runs the account.
func (a Account) ProviderID() string { return a.Tool + "@" + a.ID }

// ConfigDirVar is the environment variable that points a CLI at its config directory.
func ConfigDirVar(tool string) string {
	switch tool {
	case "claude":
		return "CLAUDE_CONFIG_DIR"
	case "codex":
		return "CODEX_HOME"
	case "copilot":
		return "COPILOT_HOME"
	}
	return ""
}

// setConfigDir points a CLI started for req at the account's config directory, if any.
func setConfigDir(cmd *exec.Cmd, req OpenRequest, tool string) {
	if req.ConfigDir != "" {
		platform.SetEnv(cmd, req.Env, ConfigDirVar(tool), req.ConfigDir, true)
	}
}

// accountProvider runs a provider as one of its CLI's other accounts.
type accountProvider struct {
	base Provider
	acct Account
	no   int
}

func (a accountProvider) Info() Info {
	info := a.base.Info()
	info.ID, info.Account, info.AccountNo = a.acct.ProviderID(), a.acct.Label, a.no
	return info
}

func (a accountProvider) Open(ctx context.Context, req OpenRequest) (Conn, error) {
	req.ConfigDir = a.acct.Dir
	return a.base.Open(ctx, req)
}

// labelled is a provider's default account, with its label and number.
type labelled struct {
	Provider
	label string
	no    int
}

func (l labelled) Info() Info {
	info := l.Provider.Info()
	info.Account, info.AccountNo = l.label, l.no
	return info
}

// Registry holds providers in display order: each CLI's default account, then its others.
type Registry struct {
	base []Provider

	mu    sync.RWMutex
	order []string
	byID  map[string]Provider
}

func NewRegistry(providers ...Provider) *Registry {
	r := &Registry{base: providers}
	r.SetAccounts(nil, nil)
	return r
}

// SetAccounts replaces the accounts besides each CLI's default one. defaults labels the
// default accounts by tool.
func (r *Registry) SetAccounts(accounts []Account, defaults map[string]string) {
	order := []string{}
	byID := map[string]Provider{}
	for _, p := range r.base {
		info := p.Info()
		var mine []Account
		for _, a := range accounts {
			if a.Tool == info.Tool {
				mine = append(mine, a)
			}
		}
		no := 0
		if len(mine) > 0 {
			no = 1
		}
		order = append(order, info.ID)
		byID[info.ID] = labelled{Provider: p, label: defaults[info.Tool], no: no}
		for i, a := range mine {
			order = append(order, a.ProviderID())
			byID[a.ProviderID()] = accountProvider{base: p, acct: a, no: i + 2}
		}
	}
	r.mu.Lock()
	r.order, r.byID = order, byID
	r.mu.Unlock()
}

func (r *Registry) Get(id string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.byID[id]
	return p, ok
}

func (r *Registry) Default() Provider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.byID[r.order[0]]
}

func (r *Registry) Infos() []Info {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Info, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id].Info())
	}
	return out
}

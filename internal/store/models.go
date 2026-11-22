package store

// Project is a folder on disk that sessions run in.
type Project struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Env      string `json:"env"` // "native" | "wsl", inferred from Path
	Expanded bool   `json:"expanded"`
	// AdminTerminals opens new terminals as administrator (Windows).
	AdminTerminals bool  `json:"adminTerminals"`
	CreatedAt      int64 `json:"createdAt"`
}

// Session is one agent conversation inside a project.
type Session struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Effort    string `json:"effort"`
	Mode      string `json:"mode"`
	// Worktree is the Claude Code worktree the session runs in ("" = the project's own folder).
	// It is fixed once the session has started, since the CLI keeps sessions per folder.
	Worktree string `json:"worktree"`
	// Fast asks for fast mode (Claude). FastState and FastOffReason are what the CLI last
	// reported: "on" / "off" / "cooldown", and why it is off ("" when unknown).
	// TurnProvider and TurnModel are what the latest turn ran with ("" before the first).
	TurnProvider  string `json:"turnProvider"`
	TurnModel     string `json:"turnModel"`
	Fast          bool   `json:"fast"`
	FastState     string `json:"fastState"`
	FastOffReason string `json:"fastOffReason"`
	// ProviderSessionID is the id the provider CLI uses to resume context.
	ProviderSessionID string `json:"providerSessionId"`
	// Started is true once the provider has created its session (resume instead of create).
	// LastStatus is the outcome of the latest turn: "done" | "waiting" | "error" | "".
	LastStatus string `json:"lastStatus"`
	Started    bool   `json:"started"`
	// ContextTokens is how much of the model's context the latest turn used (0 if unknown).
	ContextTokens int64 `json:"contextTokens"`
	// ContextWindow is the model's context size as last reported (0 if unknown).
	ContextWindow int64 `json:"contextWindow"`
	CreatedAt     int64 `json:"createdAt"`
	UpdatedAt     int64 `json:"updatedAt"`
}

// ProjectTree is a project with its sessions, used to render the sidebar.
type ProjectTree struct {
	Project  Project   `json:"project"`
	Sessions []Session `json:"sessions"`
}

// Part is one block of a message: text or a tool call.
type Part struct {
	Type       string `json:"type"` // "text" | "tool" | "error" | "attachment"
	Text       string `json:"text,omitempty"`
	ToolID     string `json:"toolId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	ToolInput  string `json:"toolInput,omitempty"`
	ToolOutput string `json:"toolOutput,omitempty"`
	IsError    bool   `json:"isError,omitempty"`
	Done       bool   `json:"done,omitempty"`
	// ParentID is set on tool calls made by a subagent: the toolId of its Agent call.
	ParentID string `json:"parentId,omitempty"`
	// Subagent is an Agent call's agent type ("Explore", "general-purpose", ...).
	Subagent string `json:"subagent,omitempty"`
	// When a tool call started and finished (ms), to time subagents.
	StartedAt int64 `json:"startedAt,omitempty"`
	EndedAt   int64 `json:"endedAt,omitempty"`
	// A finished subagent's totals, when the CLI reported them.
	AgentToolUses int   `json:"agentToolUses,omitempty"`
	AgentTokens   int64 `json:"agentTokens,omitempty"`
	// Attachment fields (Type "attachment").
	FileName string `json:"fileName,omitempty"`
	FilePath string `json:"filePath,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	URL      string `json:"url,omitempty"`
}

// Message is a chat message shown in a session.
type Message struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Role      string `json:"role"` // "user" | "assistant" | "event" (shown in the chat only, e.g. a model switch)
	Parts     []Part `json:"parts"`
	CreatedAt int64  `json:"createdAt"`
}

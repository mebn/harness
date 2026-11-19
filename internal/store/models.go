package store

// Project is a folder on disk that sessions run in.
type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Env       string `json:"env"` // "native" | "wsl", inferred from Path
	Expanded  bool   `json:"expanded"`
	CreatedAt int64  `json:"createdAt"`
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
	// ProviderSessionID is the id the provider CLI uses to resume context.
	ProviderSessionID string `json:"providerSessionId"`
	// Started is true once the provider has created its session (resume instead of create).
	// LastStatus is the outcome of the latest turn: "done" | "waiting" | "error" | "".
	LastStatus string `json:"lastStatus"`
	Started   bool  `json:"started"`
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// ProjectTree is a project with its sessions, used to render the sidebar.
type ProjectTree struct {
	Project  Project   `json:"project"`
	Sessions []Session `json:"sessions"`
}

// Part is one block of a message: text or a tool call.
type Part struct {
	Type       string `json:"type"` // "text" | "tool" | "error"
	Text       string `json:"text,omitempty"`
	ToolID     string `json:"toolId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	ToolInput  string `json:"toolInput,omitempty"`
	ToolOutput string `json:"toolOutput,omitempty"`
	IsError    bool   `json:"isError,omitempty"`
	Done       bool   `json:"done,omitempty"`
}

// Message is a chat message shown in a session.
type Message struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Role      string `json:"role"` // "user" | "assistant"
	Parts     []Part `json:"parts"`
	CreatedAt int64  `json:"createdAt"`
}

// Package services exposes backend functionality to the frontend as Wails services.
package services

// Event names shared with the frontend.
const (
	EventChatMessage    = "chat:message"
	EventChatStatus     = "chat:status"
	EventChatQueue      = "chat:queue"
	EventChatPending    = "chat:pending"  // permission requests waiting for an answer
	EventChatTasks      = "chat:tasks"    // background tasks running
	EventChatCommands   = "chat:commands" // slash commands available
	EventChatReload     = "chat:reload"   // a chat's messages changed wholesale (rewind)
	EventSessionUpdated = "session:updated"
	EventTermData       = "term:data"
	EventTermExit       = "term:exit"
	EventUsageUpdated   = "usage:updated"
)

// Emitter sends events to the frontend. Abstracted so services stay testable.
type Emitter func(name string, data any)

// ChatStatus reports whether a session's agent is running.
type ChatStatus struct {
	SessionID string `json:"sessionId"`
	Running   bool   `json:"running"`
}

// TermData is a chunk of terminal output (base64 to keep raw bytes intact).
type TermData struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

// TermExit signals a terminal process ended.
type TermExit struct {
	ID string `json:"id"`
}

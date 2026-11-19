// Package services exposes backend functionality to the frontend as Wails services.
package services

import "github.com/wailsapp/wails/v3/pkg/application"

// Event names shared with the frontend.
const (
	EventChatMessage    = "chat:message"
	EventChatStatus     = "chat:status"
	EventSessionUpdated = "session:updated"
	EventTermData       = "term:data"
	EventTermExit       = "term:exit"
)

// Emitter sends events to the frontend. Abstracted so services stay testable.
type Emitter func(name string, data any)

// AppEmitter emits through the running Wails application.
func AppEmitter(name string, data any) {
	if app := application.Get(); app != nil {
		app.Event.Emit(name, data)
	}
}

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

package services

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/platform"
)

// SystemInfo tells the UI which platform features to show.
type SystemInfo struct {
	OS     string `json:"os"`
	HasWSL bool   `json:"hasWsl"`
}

type SystemService struct{}

func (SystemService) Info() SystemInfo {
	return SystemInfo{OS: runtime.GOOS, HasWSL: platform.HasWSL()}
}

// PickFolder opens a native folder picker. Returns "" if cancelled.
func (SystemService) PickFolder() (string, error) {
	return application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		SetTitle("Open folder").
		PromptForSingleSelection()
}

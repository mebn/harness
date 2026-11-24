//go:build !harness_server

package main

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The quick chat is a fixed, transparent stage; the cards in it are drawn and animated by the
// frontend (components/quick), so the window itself never resizes. It is larger than the
// cards so their shadows fit.
const (
	quickWidth  = 880
	quickHeight = 780
	// A quick chat dragged to within this many pixels of the center of its screen snaps there.
	quickSnap = 40
)

// Events between the quick chat's page and this process.
const (
	// Sent to the page each time the quick chat is shown.
	eventQuickShown = "quick:shown"
	// From the page: a native dialog (file picker) opened (true) or closed (false). Losing
	// focus to it must not hide the window.
	eventQuickDialog = "quick:dialog"
	// From the page: hide the quick chat (Esc).
	eventQuickHide = "quick:hide"
	// From the page: open a chat in the main window (the main window's page opens the chat).
	eventQuickOpenChat = "quick:open-chat"
)

// quickWindow is the floating chat the hotkey opens. It is created the first time it's
// shown, then hidden and shown again; once it exists, this process keeps running after the
// main window closes, so the next press is instant.
type quickWindow struct {
	app *application.App

	mu         sync.Mutex
	win        *application.WebviewWindow
	placed     bool // shown once; after that it stays where it was dragged
	dialogOpen bool
}

func newQuickWindow(app *application.App) *quickWindow {
	q := &quickWindow{app: app}
	app.Event.On(eventQuickDialog, func(e *application.CustomEvent) {
		open, _ := e.Data.(bool)
		q.mu.Lock()
		q.dialogOpen = open
		q.mu.Unlock()
	})
	app.Event.On(eventQuickHide, func(*application.CustomEvent) { q.Hide() })
	return q
}

func (q *quickWindow) window() *application.WebviewWindow {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.win != nil {
		return q.win
	}
	win := q.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:          "quick",
		Title:         "Harness Quick Chat",
		Width:         quickWidth,
		Height:        quickHeight,
		Frameless:     true,
		DisableResize: true,
		Hidden:        true,
		AlwaysOnTop:   true,
		// Esc is handled by the page: it closes menus first, then hides.
		BackgroundType: application.BackgroundTypeTransparent,
		URL:            "/?quick",
		Mac: application.MacWindow{
			// A non-activating panel takes keyboard input without stealing focus from the app
			// you were in, the way Spotlight does.
			WindowClass:      application.MacWindowClassPanel,
			PanelPreferences: application.MacPanelPreferences{NonActivating: true},
			CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
				application.MacWindowCollectionBehaviorFullScreenAuxiliary |
				application.MacWindowCollectionBehaviorIgnoresCycle,
			WindowLevel: application.MacWindowLevelFloating,
			// A transparent webview needs -tags private_mac_apis (build/darwin/Taskfile.yml).
			Backdrop:      application.MacBackdropTransparent,
			DisableShadow: true,
			TitleBar: application.MacTitleBar{
				AppearsTransparent: true,
				Hide:               true,
			},
		},
		Windows: application.WindowsWindow{
			BackdropType:    application.None,
			HiddenOnTaskbar: true,
			// The frame decorations extend the DWM frame over the whole window, which paints
			// the transparent stage white and draws a close button in its corner.
			DisableFramelessWindowDecorations: true,
		},
	})
	// Like cmdcmd: clicking anywhere else hides it, except into a dialog it opened.
	win.OnWindowEvent(events.Common.WindowLostFocus, func(*application.WindowEvent) {
		q.mu.Lock()
		open := q.dialogOpen
		q.mu.Unlock()
		if !open {
			win.Hide()
		}
	})
	snapToCenter(win, quickSnap)
	q.win = win
	return win
}

// Toggle shows the quick chat if hidden and hides it otherwise.
func (q *quickWindow) Toggle() {
	q.mu.Lock()
	win := q.win
	q.mu.Unlock()
	if win != nil && win.IsVisible() {
		q.Hide()
	} else {
		q.Show()
	}
}

// Show brings the quick chat up with its input focused. The first time, and whenever the
// cursor is on another screen, it is centered on the cursor's screen.
func (q *quickWindow) Show() {
	win := q.window()
	q.mu.Lock()
	recenter := !q.placed
	q.placed = true
	q.mu.Unlock()
	placeWindow(q.app, win, quickWidth, quickHeight, recenter)
	win.Show()
	win.Focus()
	bringToFront(win)
	q.app.Event.Emit(eventQuickShown)
}

// Hide hides the quick chat. Its chat keeps running.
func (q *quickWindow) Hide() {
	q.mu.Lock()
	win := q.win
	q.mu.Unlock()
	if win != nil {
		win.Hide()
	}
	deactivateApp()
}

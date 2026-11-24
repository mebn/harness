package main

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"harness/server/client"
	"harness/server/internal/server"
	"harness/server/internal/services"
)

//go:embed appicon.png
var trayIcon []byte

const trayRefresh = 2 * time.Second

// setupTray shows the server in the Windows notification area / macOS menu bar:
// what it's doing, a way to open the window or the quick chat, and a way to quit it. It also
// starts the quick chat's hotkey.
func setupTray(app *application.App, host *server.Host, transport *server.Transport, hotkeys *services.HotkeyService) {
	toggleQuick := func() { toggleQuickChat(transport) }
	menu := application.NewMenu()
	status := menu.Add("Starting…").SetEnabled(false)
	menu.AddSeparator()
	menu.Add("Open Harness").OnClick(func(*application.Context) { openWindow() })
	quickItem := menu.Add("Quick chat").OnClick(func(*application.Context) { toggleQuick() })
	menu.AddSeparator()
	// Windows close along with the server.
	quit := menu.Add("Quit Harness Server").OnClick(func(*application.Context) { go transport.QuitWithWindows(app.Quit) })

	tray := app.SystemTray.New()
	tray.SetIcon(trayIcon)
	tray.SetMenu(menu)
	if runtime.GOOS == "windows" {
		// Windows convention: left click opens the app, right click shows the menu.
		tray.OnClick(openWindow)
	}

	last := ""
	update := func() {
		runs, terms := host.Activity()
		text := activityText(runs, terms)
		quick := "Quick chat"
		if label := hotkeys.Get().Label; label != "" {
			quick += "  (" + label + ")"
		}
		if text+quick == last {
			return
		}
		last = text + quick
		quickItem.SetLabel(quick)
		status.SetLabel(text)
		if runs > 0 {
			quit.SetLabel(fmt.Sprintf("Quit Harness Server (stops %s)", plural(runs, "session")))
		} else {
			quit.SetLabel("Quit Harness Server")
		}
		menu.Update()
		tray.SetTooltip("Harness Server: " + text)
	}
	// Menus can only change on the main thread, which exists once the app runs. Calling
	// InvokeSync before that crashes the server.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		services.StartHotkey(hotkeys, app.GlobalShortcut, toggleQuick)
		application.InvokeSync(update)
		go func() {
			for range time.Tick(trayRefresh) {
				application.InvokeSync(update)
			}
		}()
	})
}

func activityText(runs, terms int) string {
	text := "No sessions running"
	if runs > 0 {
		text = plural(runs, "session") + " running"
	}
	if terms > 0 {
		text += " · " + plural(terms, "terminal")
	}
	return text
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// toggleQuickChat shows or hides the quick chat: through the connected desktop app, or by
// starting it with only the quick chat.
func toggleQuickChat(transport *server.Transport) {
	allowForeground()
	if transport.HasDesktop() {
		transport.Emit(client.EventQuickToggle, nil)
		return
	}
	launchDesktop(client.QuickArg)
}

// openWindow launches the desktop app next to this binary. If it's already open, its
// single-instance handling focuses the existing window.
func openWindow() { launchDesktop() }

func launchDesktop(args ...string) {
	exe := os.Getenv("HARNESS_DESKTOP_EXE")
	if exe == "" {
		self, err := os.Executable()
		if err != nil {
			log.Printf("open window: %v", err)
			return
		}
		name := "harness"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		exe = filepath.Join(filepath.Dir(self), name)
	}
	cmd, err := client.StartDetached(exe, nil, nil, args...)
	if err != nil {
		log.Printf("open window: %v", err)
		return
	}
	_ = cmd.Process.Release()
}

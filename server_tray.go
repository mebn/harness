//go:build harness_server

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

	"harness/internal/server"
)

//go:embed build/appicon.png
var trayIcon []byte

const trayRefresh = 2 * time.Second

// setupTray shows the server in the Windows notification area / macOS menu bar:
// what it's doing, a way to open the window, and a way to quit it.
func setupTray(app *application.App, host *server.Host) {
	menu := application.NewMenu()
	status := menu.Add("Starting…").SetEnabled(false)
	menu.AddSeparator()
	menu.Add("Open Harness").OnClick(func(*application.Context) { openWindow() })
	menu.AddSeparator()
	quit := menu.Add("Quit Harness Server").OnClick(func(*application.Context) { app.Quit() })

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
		if text == last {
			return
		}
		last = text
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

// openWindow launches the desktop app next to this binary. If it's already open, its
// single-instance handling focuses the existing window.
func openWindow() {
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
	cmd, err := server.StartDetached(exe, nil, nil)
	if err != nil {
		log.Printf("open window: %v", err)
		return
	}
	_ = cmd.Process.Release()
}

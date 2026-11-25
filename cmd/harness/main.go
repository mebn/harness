// harness is the desktop window: a thin client of the server (cmd/harness-server), which it finds
// through the data directory, starting it when needed.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"harness/internal/client"
	"harness/internal/desktop"
	"harness/ui"
)

func main() {
	dir, err := client.DataDir()
	if err != nil {
		log.Fatal(err)
	}
	conn := client.New(dir, serverExe())
	bridge := desktop.NewBridge(conn)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start or find the server while the window loads; backend calls wait for it.
	go func() {
		if _, err := conn.Ensure(ctx); err != nil {
			log.Printf("server: %v", err)
		}
	}()

	quickOnly := slices.Contains(os.Args[1:], client.QuickArg)
	var app *application.App
	var quick *quickWindow

	// The main window. It may be closed while the quick chat keeps this process running, and
	// is opened again from the tray or by launching Harness.
	var mu sync.Mutex
	var window *application.WebviewWindow
	showMain := func() {
		mu.Lock()
		w := window
		if w == nil {
			w = newMainWindow(app)
			window = w
			w.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
				mu.Lock()
				if window == w {
					window = nil
				}
				mu.Unlock()
			})
		}
		mu.Unlock()
		w.Restore()
		w.Show()
		w.Focus()
	}

	opts := application.Options{
		Name:        "Harness",
		Description: "A desktop harness for coding agents",
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(ui.Assets),
			Middleware: bridge.Middleware,
		},
		Mac: application.MacOptions{
			// Closing the window quits only this client; sessions keep running in the server.
			// Once the quick chat exists (hidden, not closed) this process stays for it.
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// Launching again focuses the open window (one per data directory); with client.QuickArg
		// (from the server's hotkey) it shows or hides the quick chat instead.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "harness-desktop-" + shortHash(dir),
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
				if slices.Contains(d.Args, client.QuickArg) {
					quick.Toggle()
				} else {
					showMain()
				}
			},
		},
	}
	// A custom database (dev, tests) also gets its own WebView profile, so it can run
	// next to the regular app.
	if os.Getenv("HARNESS_DB") != "" {
		opts.Windows.WebviewUserDataPath = filepath.Join(dir, "webview")
	}
	app = application.New(opts)
	quick = newQuickWindow(app)
	app.Event.On(eventQuickOpenChat, func(*application.CustomEvent) {
		quick.Hide()
		showMain()
	})

	if quickOnly {
		quick.window() // created now (hidden) so the app starts with a window
		app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { quick.Show() })
	} else {
		showMain()
	}

	go bridge.RelayEvents(ctx, func(name string, data any) {
		switch name {
		case client.EventQuit:
			// The server was quit from its tray: the window goes too.
			app.Quit()
		case client.EventQuickToggle:
			quick.Toggle()
		default:
			app.Event.Emit(name, data)
		}
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func newMainWindow(app *application.App) *application.WebviewWindow {
	return app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Harness",
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 560,
		// The app draws its own title bar; macOS keeps native traffic lights via HiddenInset.
		Frameless: runtime.GOOS != "darwin",
		// Dragging comes from the page's --wails-draggable regions only. Wails'
		// InvisibleTitleBarHeight is left unset: it drags from every click in the top strip,
		// the traffic lights included, before they see it.
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInset,
		},
		// Solid, matching the light theme's backdrop until the page paints its own.
		BackgroundColour: application.NewRGB(238, 238, 238),
		URL:              "/",
	})
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:6])
}

// serverExe is the server binary next to this one, unless HARNESS_SERVER_EXE overrides it.
func serverExe() string {
	if p := os.Getenv("HARNESS_SERVER_EXE"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return "harness-server"
	}
	name := "harness-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(exe), name)
}

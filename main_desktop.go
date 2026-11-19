//go:build !harness_server

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/desktop"
	"harness/internal/server"
)

func main() {
	dir, err := dataDir()
	if err != nil {
		log.Fatal(err)
	}
	client := server.NewClient(dir, serverExe())
	bridge := desktop.NewBridge(client)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start or find the server while the window loads; backend calls wait for it.
	go func() {
		if _, err := client.Ensure(ctx); err != nil {
			log.Printf("server: %v", err)
		}
	}()

	var window *application.WebviewWindow
	opts := application.Options{
		Name:        "Harness",
		Description: "A desktop harness for coding agents",
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: bridge.Middleware,
		},
		Mac: application.MacOptions{
			// Closing the window quits only this client; sessions keep running in the server.
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// Launching again focuses the open window (one per data directory).
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "harness-desktop-" + shortHash(dir),
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if window != nil {
					window.Restore()
					window.Show()
					window.Focus()
				}
			},
		},
	}
	// A custom database (dev, tests) also gets its own WebView profile, so it can run
	// next to the regular app.
	if os.Getenv("HARNESS_DB") != "" {
		opts.Windows.WebviewUserDataPath = filepath.Join(dir, "webview")
	}
	app := application.New(opts)

	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Harness",
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 560,
		// The app draws its own title bar; macOS keeps native traffic lights via HiddenInset.
		Frameless: runtime.GOOS != "darwin",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 40,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(255, 255, 255),
		URL:              "/",
	})

	go bridge.RelayEvents(ctx, func(name string, data any) { app.Event.Emit(name, data) })

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
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

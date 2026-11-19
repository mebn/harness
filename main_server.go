//go:build harness_server

package main

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/attach"
	"harness/internal/provider"
	"harness/internal/server"
	"harness/internal/services"
	"harness/internal/store"
	"harness/internal/usage"
)

func init() {
	// Registered events get typed payloads in the generated TS bindings.
	application.RegisterEvent[store.Message](services.EventChatMessage)
	application.RegisterEvent[services.ChatStatus](services.EventChatStatus)
	application.RegisterEvent[store.Session](services.EventSessionUpdated)
	application.RegisterEvent[services.TermData](services.EventTermData)
	application.RegisterEvent[services.TermExit](services.EventTermExit)
	application.RegisterEvent[usage.Snapshot](services.EventUsageUpdated)
}

func main() {
	dir, err := dataDir()
	if err != nil {
		log.Fatal(err)
	}
	// One server per data directory.
	if info, err := server.ReadInfo(dir); err == nil && server.Ping(info) {
		log.Printf("server already running (pid %d)", info.PID)
		return
	}

	dbPath, err := store.DefaultPath()
	if err != nil {
		log.Fatal(err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	attachDir, err := attach.DefaultDir()
	if err != nil {
		log.Fatal(err)
	}
	files := attach.Store{Dir: attachDir}

	host, err := server.NewHost(dir)
	if err != nil {
		log.Fatal(err)
	}

	// Serves calls, events and assets on the host's port, behind its token.
	transport := server.NewTransport(host)
	providers := provider.NewRegistry(provider.Claude{}, provider.Copilot{})
	emit := services.Emitter(transport.Emit)
	usageSvc := services.NewUsageService(db, emit)
	chat := services.NewChatService(db, providers, usageSvc, files, emit)
	terms := services.NewTerminalService(db, emit)

	app := application.New(application.Options{
		Name:        "Harness Server",
		Description: "Runs Harness sessions in the background",
		Services: []application.Service{
			application.NewService(&services.SystemService{}),
			application.NewService(services.NewProjectService(db, providers, files)),
			application.NewService(chat),
			application.NewService(usageSvc),
			application.NewService(services.NewFileService(db)),
			application.NewService(services.NewGitService(db)),
			application.NewService(terms),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: files.Middleware, // serves /attachments/... for image previews
		},
		Transport: transport,
		// No windows: the server lives in the tray (Windows) / menu bar (macOS).
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyAccessory, // no Dock icon
		},
	})
	host.SetHooks(func() (int, int) { return services.Activity(chat, terms) }, app.Quit)
	defer host.Close()
	setupTray(app, host)
	log.Printf("server listening on %s (pid %d)", host.Info.BaseURL(), host.Info.PID)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

package main

import (
	"errors"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/attach"
	"harness/internal/client"
	"harness/internal/provider"
	"harness/internal/server"
	"harness/internal/services"
	"harness/internal/store"
	"harness/internal/usage"
	"harness/ui"
)

// harness-server owns the database, agent runs and terminals, keeps running in the
// background when windows close, and shows a tray icon. The desktop app (cmd/harness) is a
// client of it.

func init() {
	// Registered events get typed payloads in the generated TS bindings.
	application.RegisterEvent[store.Message](services.EventChatMessage)
	application.RegisterEvent[services.ChatStatus](services.EventChatStatus)
	application.RegisterEvent[services.ChatQueue](services.EventChatQueue)
	application.RegisterEvent[store.Session](services.EventSessionUpdated)
	application.RegisterEvent[services.TermData](services.EventTermData)
	application.RegisterEvent[services.TermExit](services.EventTermExit)
	application.RegisterEvent[usage.Snapshot](services.EventUsageUpdated)
}

func main() {
	// The server never uses the Vite dev server (windows load the UI themselves). A dev build
	// that sees this waits for Vite at startup and exits when it isn't running.
	os.Unsetenv("FRONTEND_DEVSERVER_URL")

	dir, err := client.DataDir()
	if err != nil {
		log.Fatal(err)
	}
	// One server per data directory. The lock (not server.json, which a crash leaves behind)
	// decides: a second server started at the same moment exits here instead of racing.
	lock, err := server.AcquireLock(dir)
	if errors.Is(err, server.ErrLocked) {
		log.Printf("server already running for %s", dir)
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	defer lock.Release()

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
	providers := provider.NewRegistry(provider.Claude{}, provider.NewCopilot(dir), provider.NewCodex(dir))
	emit := services.Emitter(transport.Emit)
	usageSvc := services.NewUsageService(db, emit)
	chat := services.NewChatService(db, providers, usageSvc, files, emit)
	terms := services.NewTerminalService(db, emit)
	hotkeys := services.NewHotkeyService(db)
	agents := services.NewAgentService(db, providers, terms, dir)

	app := application.New(application.Options{
		Name:        "Harness Server",
		Description: "Runs Harness sessions in the background",
		Services: []application.Service{
			application.NewService(&services.SystemService{}),
			application.NewService(services.NewProjectService(db, providers, files, chat)),
			application.NewService(chat),
			application.NewService(usageSvc),
			application.NewService(services.NewFileService(db)),
			application.NewService(services.NewGitService(db)),
			application.NewService(terms),
			application.NewService(hotkeys),
			application.NewService(agents),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(ui.Assets),
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
	setupTray(app, host, transport, hotkeys)
	log.Printf("server listening on %s (pid %d)", host.Info.BaseURL(), host.Info.PID)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

package main

import (
	"embed"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"harness/internal/provider"
	"harness/internal/services"
	"harness/internal/store"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Registered events get typed payloads in the generated TS bindings.
	application.RegisterEvent[store.Message](services.EventChatMessage)
	application.RegisterEvent[services.ChatStatus](services.EventChatStatus)
	application.RegisterEvent[store.Session](services.EventSessionUpdated)
	application.RegisterEvent[services.TermData](services.EventTermData)
	application.RegisterEvent[services.TermExit](services.EventTermExit)
}

func main() {
	dbPath, err := store.DefaultPath()
	if err != nil {
		log.Fatal(err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	providers := provider.NewRegistry(provider.Claude{}, provider.Copilot{})
	emit := services.AppEmitter

	app := application.New(application.Options{
		Name:        "Harness",
		Description: "A desktop harness for coding agents",
		Services: []application.Service{
			application.NewService(&services.SystemService{}),
			application.NewService(services.NewProjectService(db, providers)),
			application.NewService(services.NewChatService(db, providers, emit)),
			application.NewService(services.NewFileService(db)),
			application.NewService(services.NewGitService(db)),
			application.NewService(services.NewTerminalService(db, emit)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
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

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

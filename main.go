// Harness builds as two binaries from this package:
//
//   - harness (default build): the desktop window. A thin client of the server.
//   - harness-server (-tags harness_server): owns the database, agent runs and terminals,
//     keeps running in the background when windows close, and shows a tray icon.
package main

import (
	"embed"
	"path/filepath"

	"harness/internal/store"
)

// quickArg starts the desktop app with only the quick chat, or (to a running one) shows or
// hides it. The server passes it when the quick chat's hotkey is pressed with no window open.
const quickArg = "--quick"

//go:embed all:frontend/dist
var assets embed.FS

// dataDir holds the database, attachments' siblings and the server info file.
// Following HARNESS_DB keeps separate databases on separate servers.
func dataDir() (string, error) {
	dbPath, err := store.DefaultPath()
	if err != nil {
		return "", err
	}
	return filepath.Dir(dbPath), nil
}

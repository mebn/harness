// Package ui embeds the built React app (ui/dist). The desktop window serves it, and the
// server serves the same files to browsers (http://127.0.0.1:<port>/?token=<token>).
//
// dist is built by `wails3 build` (or `npm run build` here); it is not checked in, so build
// the UI before compiling either binary.
package ui

import "embed"

//go:embed all:dist
var Assets embed.FS

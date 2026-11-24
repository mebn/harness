// Package webui embeds the UI the server serves to browsers
// (http://127.0.0.1:<port>/?token=<token>). The desktop app serves its own copy.
//
// dist is a copy of frontend/ui/dist made by the frontend's build:server task; it is not
// checked in. Without it the server still runs, but has no page for browsers.
package webui

import "embed"

//go:embed all:dist
var Assets embed.FS

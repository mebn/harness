# Harness

A desktop app for running coding agents (Claude Code, GitHub Copilot CLI) across projects.
Built with Go + Wails v3, React, Tailwind and shadcn/ui.

The app wraps the agent CLIs as they are. It adds no system prompt or instructions, so each
agent uses its own config (CLAUDE.md, settings, MCP servers, and so on).

## Run

```sh
wails3 dev      # dev mode with hot reload
wails3 build    # produces bin/harness(.exe) and bin/harness-server(.exe)
```

## Architecture

Harness is two processes built from the same package:

- **`harness-server`** (`-tags harness_server`, `main_server.go`) owns the database, agent runs
  and terminals. It is a windowless Wails app with a tray icon (Windows) / menu bar item
  (macOS) showing what's running, with "Open Harness" and "Quit Harness Server". A custom
  transport (`internal/server/transport.go`) serves bound services over HTTP and events over
  WebSocket on `127.0.0.1` with a random port and a per-run token. It keeps running when
  windows close and never exits on its own (quit it from the tray).
- **`harness`** (`main_desktop.go`) is the window. It finds the server through
  `<data dir>/server.json`, starting it if needed, and forwards bound-method calls,
  attachments and events (`internal/desktop`). Window, dialog and other native runtime calls
  stay local. Closing it never stops a session.

When the window starts and the server binary on disk is newer than the running server, the
server is restarted into the new binary only if no agent is running and no terminal is open.
Otherwise the old server keeps running until a later start finds it idle.
The server log is `<data dir>/server.log`.

A browser can use the server directly at `http://127.0.0.1:<port>/?token=<token>`
(values from `server.json`); window controls and the folder picker only work in the desktop app.

Requires `claude` and/or `copilot` on PATH. For WSL projects, they must be on PATH inside the distro.

## Layout

```
main.go                     shared: embedded frontend, data dir
main_server.go              server: store, providers, services (+ server_tray.go)
main_desktop.go             window: finds/starts the server, proxies to it
internal/
  platform/                 native vs WSL execution, path translation, shell choice
  store/                    SQLite (pure Go) persistence: projects, sessions, messages
  provider/                 Provider interface + Claude Code / Copilot adapters (JSONL streams)
  gitx/                     git CLI wrapper: status with line counts, diffs, commit-all, push
  server/                   server discovery (server.json), auth, HTTP/WebSocket transport, spawning
  desktop/                  window-side proxy to the server and event relay
  services/                 Wails services exposed to the frontend
    projects.go             sidebar tree CRUD, session settings
    chat.go, transcript.go  runs turns, accumulates events, streams `chat:message`
    files.go                file explorer (sandboxed to project root)
    terminal.go             PTY shells (ConPTY on Windows) via go-pty
    system.go               OS info, folder picker
frontend/src/
  stores/                   zustand: app (data), panel (right tabs), layout, theme
  components/sidebar/       projects and sessions
  components/chat/          message list, tool calls, composer and pickers
  components/panel/         right panel tabs: files, terminal (xterm.js), browser
  components/settings/      settings dialog (theme)
  components/layout/        three-pane shell, custom title bar and window controls
```

## Notes

- Data lives in `<UserConfigDir>/harness/harness.db`. Set `HARNESS_DB` to override it; the
  server, `server.json` and (for the window) the WebView profile follow that directory, so a
  custom database runs fully separate from the regular app.
- Bindings are generated from the server build (`-tags harness_server`), which registers the services.
- Each session has its own provider-side session id. Turns after the first use `--resume`
  (Claude) or `--session-id` (Copilot). Switching provider starts a fresh provider conversation.
- Permission modes: Full access (`bypassPermissions` / `--allow-all`), Accept edits, Plan.
- On Windows, a project runs in WSL when its folder lives inside a distro (`\\wsl.localhost\...`
  or `\\wsl$\...`), and natively otherwise. There is no manual switch.
- To add a provider, implement `provider.Provider` and register it in `main_server.go`.
- Model lists are static in `internal/provider/claude.go` and `copilot.go`.

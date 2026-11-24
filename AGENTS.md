# Agent notes for Harness

## Rules

- `README.md` holds only the title and how to run the app. Don't add architecture, notes or
  anything else there; documentation for working on the code goes in this file.
- Don't add personal tooling (launch scripts, shortcuts) to the repo.

## What it is

A desktop app for running coding agents (Claude Code, GitHub Copilot CLI) across projects.
Built with Go + Wails v3, React, Tailwind and shadcn/ui.

The app wraps the agent CLIs as they are. It adds no system prompt or instructions, so each
agent uses its own config (CLAUDE.md, settings, MCP servers, and so on).

Requires `claude` and/or `copilot` on PATH. For WSL projects, they must be on PATH inside the distro.

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

Only one server runs per data directory: it holds `<data dir>/server.lock` (an OS file lock,
released even if it crashes), and a second one exits at once. The server is started without the
window's `FRONTEND_DEVSERVER_URL`, so a server launched from `wails3 dev` never waits on Vite.
Before loading anything, the window asks `/harness/connection` (answered by the window itself,
which starts the server if needed). Until that succeeds it shows a startup screen, and if it
fails, the error and the end of the server log, with a Retry button. A server that dies while
starting is reported right away rather than after the 20 s start timeout.

When the window starts and the server binary on disk is newer than the running server, the
server is restarted into the new binary only if no agent is running and no terminal is open.
Otherwise the old server keeps running until a later start finds it idle. This is what lets
Harness be developed from inside itself with `wails3 dev`: rebuilds restart only the window.
The server log is `<data dir>/server.log`.

A browser can use the server directly at `http://127.0.0.1:<port>/?token=<token>`
(values from `server.json`); window controls and the folder picker only work in the desktop app.

## Layout

```
main.go                     shared: embedded frontend, data dir
main_server.go              server: store, providers, services (+ server_tray.go)
main_desktop.go             window: finds/starts the server, proxies to it
internal/
  platform/                 native vs WSL execution, path translation, shell choice
  store/                    SQLite (pure Go) persistence: projects, sessions, messages
  provider/                 Provider/Conn interfaces + Claude Code (stream-json) / Copilot (ACP) adapters
  gitx/                     git CLI wrapper: status with line counts, diffs, commit-all, push
  server/                   server discovery (server.json), lock, auth, HTTP/WebSocket transport, spawning
  desktop/                  window-side proxy to the server and event relay
  services/                 Wails services exposed to the frontend
    projects.go             sidebar tree CRUD, session settings
    chat.go, transcript.go  live conversations: turns, queue, steering; streams `chat:message`
    permissions.go          permission prompts, questions, plan approval; slash commands
    rewind.go               /clear, rewind, fork
    files.go                file explorer (sandboxed to project root)
    terminal.go             PTY shells (ConPTY on Windows) via go-pty
    system.go               OS info, folder picker
frontend/src/
  stores/                   zustand: app (data), groups and layout, settings, theme, sort
  components/sidebar/       workspaces and groups (both drag to reorder)
  components/workspace/     groups of windows and tabs
  components/chat/          message list, tool calls, composer and pickers
  components/panel/         tab contents: files, changes, terminal (xterm.js), browser
  components/settings/      settings dialog
  components/layout/        shell, startup screen, custom title bar and window controls
```

## Notes

- Data lives in `<UserConfigDir>/harness/harness.db`. Set `HARNESS_DB` to override it; the
  server, `server.json` and (for the window) the WebView profile follow that directory, so a
  custom database runs fully separate from the regular app.
- Bindings are generated from the server build (`-tags harness_server`), which registers the services.
- The window is opaque (no translucency or blur). The UI is sized in rem: the app-interface text
  size scales the root font size, and tab content divides that back out (`tab-layer.tsx`).
- Terminals get a colour-friendly environment (`terminalEnv` in `terminal.go`: no `NO_COLOR`,
  `TERM=xterm-256color`, `COLORTERM=truecolor`), whatever the server inherited.
- Each session has its own provider-side session id. Switching provider starts a fresh
  provider conversation.
- Claude Code runs over the stream-json control protocol the Agent SDK uses
  (`internal/provider/claudeconn.go`): one `claude -p` process per chat, kept open between
  turns (closed after 2 hours idle with no background tasks). That gives permission prompts
  (`--permission-prompt-tool stdio`), AskUserQuestion and plan approval, MCP servers asking
  for input (`elicitation` requests: a form or a link), slash commands
  (listed by `initialize`), thinking (`--thinking-display summarized`), background tasks that
  start a turn when they finish, and rewinding files (`rewind_files`, with file checkpointing
  on). Rewind and fork cut the conversation with `--resume <id> --fork-session
  --resume-session-at <entry>`; each user message is sent with its Harness id as its uuid.
- Copilot runs as an Agent Client Protocol server (`copilot --acp`,
  `internal/provider/copilotacp.go`): one process per chat, which asks before using tools.
  Model, effort and mode are ACP config options (Accept edits approves edit requests in
  Harness; Full access turns on `allow_all`). ACP picks new sessions' ids, so
  `<data dir>/copilot-sessions.json` maps Harness's ids to Copilot's. Copilot can't take
  messages mid-turn, rewind or fork, and a denial can't carry a message.
- Permission modes: Ask permissions, Accept edits, Plan, Full access.
- `/clear` is handled by Harness (a fresh conversation in the same chat); other slash commands
  go to Claude Code.
- Closing a tab, window or group that has a chat still working or a terminal running a command
  asks first (`lib/close-guard.ts`; pressing the close shortcut again confirms). Terminals check
  for child processes of the shell (`TerminalService.Busy`), which can't be seen for WSL or
  administrator shells, so those never ask.
- Workspaces show an icon found in their folder (`ProjectService.Icon`: app icons, favicons,
  logos; see `iconCandidates` in `project_icon.go`), else a folder.
- Sidebar lists reorder live while dragging (`sidebar/use-live-reorder.ts`, with `hooks/use-flip.ts`
  sliding items to their new place). Dropping somewhere the sort wouldn't put it switches the
  sidebar to manual order.
- `HARNESS_E2E=1 go test ./internal/services -run ClaudeEndToEnd` checks the Claude
  integration against the real CLI (uses Haiku); `HARNESS_E2E=1 go test ./internal/provider
  -run CopilotEndToEnd` does the same for Copilot.
- On Windows, a project runs in WSL when its folder lives inside a distro (`\\wsl.localhost\...`
  or `\\wsl$\...`), and natively otherwise. There is no manual switch.
- To add a provider, implement `provider.Provider` and register it in `main_server.go`.
- Model lists are static in `internal/provider/claude.go` and `copilot.go`.

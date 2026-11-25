# Agent notes for Harness

## Rules

- `README.md` holds only the title and how to run the app. Don't add architecture, notes or
  anything else there; documentation for working on the code goes in this file.
- Don't add personal tooling (launch scripts, shortcuts) to the repo.
- Agents usually run inside Harness itself, often a `wails3 dev` build of this checkout. Never
  quit, restart or replace the running Harness window or server: that kills the agent's own
  session. `wails3 dev` rebuilds and restarts on every Go change, so for longer work use a
  separate git worktree outside the watched folder, and copy the changes back when done. To
  run or test the app, start a separate instance with its own `HARNESS_DB` (its own data
  directory, server and WebView profile) and binaries built outside `bin/`.

## What it is

A desktop app for running coding agents (Claude Code, GitHub Copilot CLI) across projects.
Built with Go + Wails v3, React, Tailwind and shadcn/ui.

The app wraps the agent CLIs as they are. It adds no system prompt or instructions, so each
agent uses its own config (CLAUDE.md, settings, MCP servers, and so on).

Requires `claude` and/or `copilot` on PATH. For WSL projects, they must be on PATH inside the distro.

## Running

Everything runs from the repo root (needs `wails3`, Go and Node):

```sh
wails3 dev               # dev build, Vite hot reload; Go changes rebuild
wails3 build             # bin/harness and bin/harness-server
wails3 build DEV=true    # the same, unoptimised (what `wails3 dev` builds)
```

Both binaries must sit side by side: the window starts the server next to it
(`HARNESS_SERVER_EXE` overrides that path, `HARNESS_DESKTOP_EXE` the server's path to the window).

To test without touching the running Harness, build in a separate worktree and start the window
with its own data directory; it starts its own server there:

```sh
HARNESS_DB=/tmp/harness-test/harness.db ./bin/harness
```

Stop that test server afterwards with its tray menu, or
`curl -X POST -H "X-Harness-Token: <token>" http://127.0.0.1:<port>/api/shutdown` (values from
`/tmp/harness-test/server.json`).

Tests: `go test ./...` (after building the UI once: both binaries embed `ui/dist`);
`npx tsc --noEmit` in `ui`.

## Architecture

Harness is one Go module (`harness`) with two binaries:

- **`harness-server`** (`cmd/harness-server`) owns the database, agent runs
  and terminals. It is a windowless Wails app with a tray icon (Windows) / menu bar item
  (macOS) showing what's running, with "Open Harness" and "Quit Harness Server". A custom
  transport (`internal/server/transport.go`) serves bound services over HTTP and events over
  WebSocket on `127.0.0.1` with a random port and a per-run token. It keeps running when
  windows close and never exits on its own (quit it from the tray).
- **`harness`** (`cmd/harness`) is the window: the Wails app with the React UI in `ui`. It finds the server through `<data dir>/server.json`, starting it
  if needed, and forwards bound-method calls, attachments and events (`internal/desktop`).
  Window, dialog and other native runtime calls stay local. Closing it never stops a session.

The contract between them is `internal/client` (data dir, server info, headers, event names,
finding and starting the server). The window imports only that, `internal/desktop` and `ui`,
never the server's packages (store, services, providers, ...); `cmd/harness/deps_test.go`
checks this. Both binaries embed the built UI through the `ui` package (`ui/embed.go`); the
server serves it to browsers. Build tasks live in the root `Taskfile.yml` and `build/`:
`build:sessionserver` builds `cmd/harness-server` into `bin/harness-server`, and `wails3 dev`
watches the whole repo, so server changes rebuild too.

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

### Quick chat

Double-tapping Ctrl (⌘ on macOS) anywhere opens the quick chat: a floating, always-on-top,
transparent window with one chat, like Spotlight (the design comes from the earlier cmdcmd
app). The hotkey lives in the server, which keeps running when windows close
(`internal/hotkey` for double taps through a keyboard hook / event tap,
`services.HotkeyService` for combinations through Wails' global shortcuts; the choice is in
Settings › Keyboard shortcuts and saved in the database). A press emits `quick:toggle` to the
connected desktop app (`Transport.HasDesktop`), or starts `harness --quick` when none is
connected, which opens only the quick chat. `cmd/harness/quick.go` owns the window (`/?quick`, rendered
by `components/quick`); once it exists the desktop process keeps running after the main window
closes, so later presses are instant, and the main window is reopened on demand. It shows the
chat last focused in either window (`lib/quick.ts`, in localStorage) and hides on Esc or when
it loses focus (except to its own file picker). Chats started in it get a group in the main
window once something is sent. On Windows the server calls `AllowSetForegroundWindow` and
the window joins the foreground thread's input to take focus from the app in front. On macOS
the window is a non-activating panel, double taps need Input Monitoring, and the transparent
webview needs `-tags private_mac_apis` (set in `build/darwin/Taskfile.yml`).

A browser can use the server directly at `http://127.0.0.1:<port>/?token=<token>`
(values from `server.json`); window controls and the folder picker only work in the desktop app.

## Layout

```
go.mod                      module harness (one module for both binaries)
Taskfile.yml, build/        Wails build config; builds both binaries into bin/
cmd/
  harness/                  the window: finds/starts the server, proxies to it
    quick*.go               the quick chat's floating window
  harness-server/           the server: store, providers, services (+ tray.go)
internal/
  client/                   data dir, server.json, finding/starting the server, shared names
  desktop/                  window-side proxy to the server and event relay
  hotkey/                   system-wide double-tap detection (Windows hook, macOS event tap)
  platform/                 native vs WSL execution, path translation, shell choice
  store/                    SQLite (pure Go) persistence: projects, sessions, messages
  provider/                 Provider/Conn interfaces + Claude Code (stream-json) / Copilot (ACP) adapters
  gitx/                     git CLI wrapper: status with line counts, diffs, commit-all, push
  server/                   host (auth, status, shutdown), lock, HTTP/WebSocket transport
  services/                 Wails services exposed to the frontend
    projects.go             sidebar tree CRUD, session settings
    chat.go, transcript.go  live conversations: turns, queue, steering; streams `chat:message`
    permissions.go          permission prompts, questions, plan approval; slash commands
    rewind.go               /clear, rewind, fork
    files.go                file explorer (sandboxed to project root)
    terminal.go             PTY shells (ConPTY on Windows) via go-pty
    system.go               OS info, folder picker
    hotkey.go               the quick chat's hotkey
ui/                         React app (Vite); embed.go embeds dist/ for both binaries
  bindings/                 generated from cmd/harness-server
  src/
    stores/                 zustand: app (data), groups and layout, settings, theme, sort
    components/sidebar/     workspaces and groups (both drag to reorder)
    components/workspace/   groups of windows and tabs
    components/chat/        message list, tool calls, composer and pickers
    components/quick/       the quick chat window
    components/panel/       tab contents: files, changes, terminal (xterm.js), browser
    components/settings/    settings dialog
    components/layout/      shell, startup screen, custom title bar and window controls
```

## Notes

- Data lives in `<UserConfigDir>/harness/harness.db`. Set `HARNESS_DB` to override it; the
  server, `server.json` and (for the window) the WebView profile follow that directory, so a
  custom database runs fully separate from the regular app.
- Bindings are generated from the server binary, which registers the services
  (`common:generate:bindings` runs `wails3 generate bindings -d ui/bindings ./cmd/harness-server`).
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
- Codex runs as an app server (`codex app-server`, JSON-RPC over stdio, the protocol of its
  IDE extensions; `internal/provider/codexconn.go`): one process per chat, one Codex thread.
  `codex app-server generate-ts --experimental --out <dir>` prints the protocol's types.
  Model, effort, approval policy and sandbox go with each `turn/start`: Ask runs read-only
  with `on-request` approvals (so edits and writing commands ask), Accept edits uses
  `workspace-write`, Plan adds Codex's plan collaboration mode, Full access uses
  `danger-full-access` with `never`. Messages sent mid-turn go in with `turn/steer`.
  `<data dir>/codex-sessions.json` maps Harness's ids to Codex's thread ids. Codex can't
  rewind or fork here, and a denial can't carry a message.
- Permission modes: Ask permissions, Accept edits, Plan, Full access.
- `/clear` (and `/new`, `/reset`) is handled by Harness: it empties the chat and starts a fresh
  provider conversation in it. Other slash commands go to Claude Code.
- Closing a tab, window or group that has a chat still working or a terminal running a command
  asks first (`lib/close-guard.ts`; pressing the close shortcut again confirms). Terminals check
  for child processes of the shell (`TerminalService.Busy`), which can't be seen for WSL or
  administrator shells, so those never ask.
- Run as administrator (a workspace's menu, Windows folders) runs its chats' agent and new
  terminals elevated, through sudo for Windows (inline) or gsudo, each after a UAC prompt
  (`platform.AgentCommand`, `AdminShellCommand`). A chat's agent restarts for it when idle.
  Stored as `projects.admin_terminals`, named from when it covered terminals only.
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
- To add a provider, implement `provider.Provider` and register it in `cmd/harness-server/main.go`.
- Model lists are static in `internal/provider/claude.go`, `copilot.go` and `codex.go`.
- Settings › Agents & models (`services.AgentService`, `agents.go`) finds the agent CLIs natively
  and, on Windows, in WSL's default distro (one login shell; CLIs under `/mnt` are the Windows
  ones through interop), with version and sign-in state. Update and sign-in run the CLI's own
  commands in a small terminal in the dialog (`TerminalService.startCommand`). It also keeps the
  model and effort new chats start with (`newChatDefaults` in the kv table; empty = like the
  last chat), which `CreateSession` applies.

# Harness

A desktop app for running coding agents (Claude Code, GitHub Copilot CLI) across projects.
Built with Go + Wails v3, React, Tailwind and shadcn/ui.

The app wraps the agent CLIs as they are. It adds no system prompt or instructions, so each
agent uses its own config (CLAUDE.md, settings, MCP servers, and so on).

## Run

```sh
wails3 dev      # dev mode with hot reload
wails3 build    # produces bin/harness(.exe)
```

Requires `claude` and/or `copilot` on PATH. For WSL projects, they must be on PATH inside the distro.

## Layout

```
main.go                     wiring: store, providers, services, window
internal/
  platform/                 native vs WSL execution, path translation, shell choice
  store/                    SQLite (pure Go) persistence: projects, sessions, messages
  provider/                 Provider interface + Claude Code / Copilot adapters (JSONL streams)
  gitx/                     git CLI wrapper: status with line counts, diffs, commit-all, push
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

- Data lives in `<UserConfigDir>/harness/harness.db`. Set `HARNESS_DB` to override it.
- Each session has its own provider-side session id. Turns after the first use `--resume`
  (Claude) or `--session-id` (Copilot). Switching provider starts a fresh provider conversation.
- Permission modes: Full access (`bypassPermissions` / `--allow-all`), Accept edits, Plan.
- On Windows, a project runs in WSL when its folder lives inside a distro (`\\wsl.localhost\...`
  or `\\wsl$\...`), and natively otherwise. There is no manual switch.
- To add a provider, implement `provider.Provider` and register it in `main.go`.
- Model lists are static in `internal/provider/claude.go` and `copilot.go`.

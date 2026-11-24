// Single entry point to the generated Wails bindings.
// Bound-method calls are served by the background server (the desktop window forwards them).
export {
  ChatService,
  FileService,
  GitService,
  HotkeyService,
  ProjectService,
  SystemService,
  TerminalService,
  UsageService,
} from "@bindings/harness/server/internal/services";

export type {
  SystemInfo,
  FileEntry,
  HotkeyInfo,
  PendingRequest,
  PermissionAnswer,
  RewindResult,
} from "@bindings/harness/server/internal/services/models";
export type { Command as SlashCommand, Task as BackgroundTask, Elicitation } from "@bindings/harness/server/internal/provider/models";
export type { Message, Part, Project, ProjectTree, Session } from "@bindings/harness/server/internal/store/models";
export type { Branch as GitBranch, File as GitFile, Status as GitStatus, Worktree } from "@bindings/harness/server/internal/gitx/models";
export type { Info as ProviderInfo, Option } from "@bindings/harness/server/internal/provider/models";

export { Browser, Dialogs, Events } from "@wailsio/runtime";

/** Emitted by the desktop window after it reconnects to the server; state may have moved on. */
export const EVENT_SERVER_RECONNECTED = "server:reconnected";

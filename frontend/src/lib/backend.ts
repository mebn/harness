// Single entry point to the generated Wails bindings.
// Bound-method calls are served by the background server (the desktop window forwards them).
export {
  ChatService,
  FileService,
  GitService,
  ProjectService,
  SystemService,
  TerminalService,
  UsageService,
} from "@bindings/harness/internal/services";

export type { SystemInfo, FileEntry } from "@bindings/harness/internal/services/models";
export type { Message, Part, Project, ProjectTree, Session } from "@bindings/harness/internal/store/models";
export type { File as GitFile, Status as GitStatus } from "@bindings/harness/internal/gitx/models";
export type { Info as ProviderInfo, Option } from "@bindings/harness/internal/provider/models";

export { Dialogs, Events } from "@wailsio/runtime";

/** Emitted by the desktop window after it reconnects to the server; state may have moved on. */
export const EVENT_SERVER_RECONNECTED = "server:reconnected";

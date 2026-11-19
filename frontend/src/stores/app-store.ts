import { create } from "zustand";
import {
  ChatService,
  Dialogs,
  ProjectService,
  SystemService,
  type Message,
  type ProjectTree,
  type ProviderInfo,
  type Session,
  type SystemInfo,
} from "@/lib/backend";
import { storage } from "@/lib/storage";
import type { AttachmentInput } from "@bindings/harness/internal/services/models";

const SEEN_KEY = "harness.seen";

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(storage.get(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export type SessionSettings = Pick<Session, "provider" | "model" | "effort" | "mode">;

type AppState = {
  ready: boolean;
  system: SystemInfo;
  providers: ProviderInfo[];
  tree: ProjectTree[];
  messages: Record<string, Message[]>;
  running: Record<string, boolean>;
  /** When each session was last viewed; newer activity shows as unseen in the sidebar. */
  seen: Record<string, number>;

  init: () => Promise<void>;
  refreshTree: () => Promise<void>;

  /** Asks for a folder and adds it; returns the new project's id. */
  addProject: () => Promise<string | undefined>;
  removeProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  toggleProject: (id: string) => Promise<void>;

  newSession: (projectId: string) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Fetches a session's messages the first time a chat shows it. */
  loadMessages: (id: string) => Promise<void>;
  updateSettings: (id: string, patch: Partial<SessionSettings>) => Promise<void>;

  send: (sessionId: string, prompt: string, attachments?: AttachmentInput[]) => Promise<void>;
  stop: (sessionId: string) => void;
  markSeen: (sessionId: string) => void;

  // Backend event handlers
  onMessage: (m: Message) => void;
  onStatus: (sessionId: string, running: boolean) => void;
  onSession: (s: Session) => void;
};

function mapSession(tree: ProjectTree[], id: string, fn: (s: Session) => Session): ProjectTree[] {
  return tree.map((node) => ({
    ...node,
    sessions: (node.sessions ?? []).map((s) => (s.id === id ? fn(s) : s)),
  }));
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  system: { os: "", hasWsl: false, hostname: "" },
  providers: [],
  tree: [],
  messages: {},
  running: {},
  seen: loadSeen(),

  init: async () => {
    const [system, providers, tree, running] = await Promise.all([
      SystemService.Info(),
      ChatService.Providers(),
      ProjectService.Tree(),
      ChatService.Running(),
    ]);
    set({
      system,
      providers: providers ?? [],
      tree: tree ?? [],
      running: Object.fromEntries((running ?? []).map((id) => [id, true])),
      ready: true,
    });
    // Sessions never tracked before count as seen, so existing history starts quiet.
    const seen = { ...get().seen };
    for (const s of (tree ?? []).flatMap((n) => n.sessions ?? [])) seen[s.id] ??= s.updatedAt;
    set({ seen });
    storage.set(SEEN_KEY, JSON.stringify(seen));
    // Reloaded chats are fetched again by the chat views that show them.
    set({ messages: {} });
  },

  refreshTree: async () => set({ tree: (await ProjectService.Tree()) ?? [] }),

  addProject: async () => {
    // A runtime call, so the native picker opens in the desktop window (not on the server).
    const path = await Dialogs.OpenFile({
      Title: "Open folder",
      CanChooseDirectories: true,
      CanChooseFiles: false,
      CanCreateDirectories: true,
    });
    if (!path) return undefined;
    const project = await ProjectService.AddProject(path);
    await get().refreshTree();
    return project.id;
  },

  removeProject: async (id) => {
    await ProjectService.RemoveProject(id);
    await get().refreshTree();
  },

  renameProject: async (id, name) => {
    await ProjectService.RenameProject(id, name);
    await get().refreshTree();
  },

  toggleProject: async (id) => {
    const node = get().tree.find((n) => n.project.id === id);
    if (!node) return;
    const expanded = !node.project.expanded;
    set({
      tree: get().tree.map((n) => (n.project.id === id ? { ...n, project: { ...n.project, expanded } } : n)),
    });
    await ProjectService.SetExpanded(id, expanded);
  },


  newSession: async (projectId) => {
    const session = await ProjectService.CreateSession(projectId);
    await get().refreshTree();
    // A new chat is known to be empty; no need to fetch.
    set({ messages: { ...get().messages, [session.id]: [] } });
    return session;
  },

  deleteSession: async (id) => {
    await ProjectService.DeleteSession(id);
    await get().refreshTree();
  },

  renameSession: async (id, title) => {
    await ProjectService.RenameSession(id, title);
    set({ tree: mapSession(get().tree, id, (s) => ({ ...s, title })) });
    get().markSeen(id);
  },

  loadMessages: async (id) => {
    if (get().messages[id]) return;
    const list = (await ChatService.Messages(id)) ?? [];
    set({ messages: { ...get().messages, [id]: list } });
  },

  updateSettings: async (id, patch) => {
    const current = findSession(get().tree, id);
    if (!current) return;
    const next = { ...current, ...patch };
    set({ tree: mapSession(get().tree, id, () => next) }); // optimistic
    const saved = await ProjectService.UpdateSessionSettings(id, next.provider, next.model, next.effort, next.mode);
    set({ tree: mapSession(get().tree, id, () => saved) });
  },

  send: async (sessionId, prompt, attachments = []) => {
    set({ running: { ...get().running, [sessionId]: true } });
    try {
      await ChatService.Send(sessionId, prompt, attachments);
    } catch (err) {
      set({ running: { ...get().running, [sessionId]: false } });
      throw err;
    }
  },

  stop: (sessionId) => void ChatService.Stop(sessionId),

  markSeen: (sessionId) => {
    const seen = { ...get().seen, [sessionId]: Date.now() };
    set({ seen });
    storage.set(SEEN_KEY, JSON.stringify(seen));
  },

  onMessage: (m) => {
    const list = get().messages[m.sessionId];
    if (!list) return; // not loaded; will be fetched on select
    const i = list.findIndex((x) => x.id === m.id);
    const next = i === -1 ? [...list, m] : list.map((x, j) => (j === i ? m : x));
    set({ messages: { ...get().messages, [m.sessionId]: next } });
  },

  onStatus: (sessionId, running) => set({ running: { ...get().running, [sessionId]: running } }),

  // Chats that are on screen mark their own activity as seen.
  onSession: (s) => set({ tree: mapSession(get().tree, s.id, () => s) }),
}));

export function findSession(tree: ProjectTree[], id: string | null): Session | undefined {
  if (!id) return undefined;
  for (const node of tree) {
    const s = node.sessions?.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}

export function useSession(id: string | undefined) {
  return useApp((s) => (id ? findSession(s.tree, id) : undefined));
}

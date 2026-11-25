// The quick chat (components/quick) and the main window share localStorage (same app, same
// origin) and talk through Wails events, which reach every window and the desktop process.

import { Events } from "@/lib/backend";
import { storage } from "./storage";

/** This page is the quick chat window (the desktop app opens it at "/?quick"). */
export const isQuickWindow = new URLSearchParams(window.location.search).has("quick");

/** Sent by the desktop process each time the quick chat is shown. */
export const EVENT_QUICK_SHOWN = "quick:shown";
/** Asks the desktop process to hide the quick chat. */
export const EVENT_QUICK_HIDE = "quick:hide";
/** A native dialog of the quick chat opened (true) or closed: losing focus to it keeps it up. */
export const EVENT_QUICK_DIALOG = "quick:dialog";
/** The quick chat started a chat: the main window gives it a group. */
export const EVENT_QUICK_SESSION = "quick:session";
/** Open a chat in the main window (the desktop process shows it; the window opens the chat). */
export const EVENT_QUICK_OPEN_CHAT = "quick:open-chat";

const LAST_CHAT_KEY = "harness.lastChat";
const NEW_SESSIONS_KEY = "harness.quickSessions";
const OPEN_CHAT_KEY = "harness.openChat";

/** Remembers the chat last focused in either window; the hotkey opens it. */
export function rememberChat(sessionId: string) {
  if (storage.get(LAST_CHAT_KEY) !== sessionId) storage.set(LAST_CHAT_KEY, sessionId);
}

export function lastChat(): string | null {
  return storage.get(LAST_CHAT_KEY);
}

/**
 * Records a chat the quick chat started, for the main window to list. Kept in storage too, so
 * a main window opened later picks it up.
 */
export function noteQuickSession(sessionId: string) {
  const ids = takeList(NEW_SESSIONS_KEY, false);
  if (!ids.includes(sessionId)) storage.set(NEW_SESSIONS_KEY, JSON.stringify([...ids, sessionId]));
  void Events.Emit(EVENT_QUICK_SESSION, sessionId);
}

/** Chats the quick chat started that the main window hasn't listed yet; clears them. */
export function takeQuickSessions(): string[] {
  return takeList(NEW_SESSIONS_KEY, true);
}

/** Opens a chat in the main window, starting it if needed. */
export function openInMainWindow(sessionId: string) {
  storage.set(OPEN_CHAT_KEY, sessionId);
  void Events.Emit(EVENT_QUICK_OPEN_CHAT, sessionId);
}

/** The chat the quick chat asked the main window to open, if any; clears it. */
export function takeOpenChat(): string | null {
  const id = storage.get(OPEN_CHAT_KEY);
  if (id) storage.remove(OPEN_CHAT_KEY);
  return id;
}

function takeList(key: string, clear: boolean): string[] {
  let ids: string[] = [];
  try {
    const data = JSON.parse(storage.get(key) ?? "[]");
    if (Array.isArray(data)) ids = data.filter((x): x is string => typeof x === "string");
  } catch {
    /* unreadable: start over */
  }
  if (clear) storage.remove(key);
  return ids;
}

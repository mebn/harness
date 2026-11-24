import { useEffect } from "react";
import { Events } from "@/lib/backend";
import { findPane } from "@/lib/layout-tree";
import {
  EVENT_QUICK_OPEN_CHAT,
  EVENT_QUICK_SESSION,
  rememberChat,
  takeOpenChat,
  takeQuickSessions,
} from "@/lib/quick";
import { findSession, useApp } from "@/stores/app-store";
import { useGroups } from "@/stores/group-store";

/**
 * The main window's side of the quick chat: it remembers the focused chat (the hotkey opens
 * it), lists chats the quick chat started, and opens a chat the quick chat hands over.
 * Mount once, in the main window, after the app has loaded.
 */
export function useQuickLink() {
  useEffect(() => {
    const remember = (s: ReturnType<typeof useGroups.getState>) => {
      const g = s.groups.find((x) => x.id === s.activeId);
      const pane = g ? findPane(g.root, g.focused) : undefined;
      const tab = pane?.tabs.find((t) => t.id === pane.active);
      if (tab?.kind === "chat" && tab.sessionId) rememberChat(tab.sessionId);
    };
    remember(useGroups.getState());
    return useGroups.subscribe(remember);
  }, []);

  useEffect(() => {
    const pickUp = async () => {
      const started = takeQuickSessions();
      const open = takeOpenChat();
      if (started.length === 0 && !open) return;
      await useApp.getState().refreshTree();
      const tree = useApp.getState().tree;
      for (const id of started) {
        const s = findSession(tree, id);
        if (s) useGroups.getState().adoptChat(s);
      }
      const s = findSession(tree, open);
      if (s) useGroups.getState().openChat(s);
    };
    void pickUp();
    const offs = [
      Events.On(EVENT_QUICK_SESSION, () => void pickUp()),
      Events.On(EVENT_QUICK_OPEN_CHAT, () => void pickUp()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}

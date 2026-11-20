import { FolderTree, GitCompare, Globe, MessageSquare, Plus, SquareTerminal, type LucideIcon } from "lucide-react";
import { hostLabel } from "@/components/panel/browser-view";
import type { Tab, TabKind } from "@/lib/layout-tree";
import { findSession, useApp } from "@/stores/app-store";
import { tabsOf } from "@/lib/layout-tree";
import type { Group } from "@/stores/group-store";

export const KIND_META: Record<TabKind, { label: string; icon: LucideIcon }> = {
  chat: { label: "Chat", icon: MessageSquare },
  terminal: { label: "Terminal", icon: SquareTerminal },
  browser: { label: "Browser", icon: Globe },
  changes: { label: "Changes", icon: GitCompare },
  files: { label: "Files", icon: FolderTree },
  new: { label: "New tab", icon: Plus },
};

export function TabIcon({ kind, className }: { kind: TabKind; className?: string }) {
  const Icon = KIND_META[kind].icon;
  return <Icon className={className} />;
}

/** What a tab is called in its pane header and the sidebar. */
export function useTabLabel(tab: Tab): string {
  const title = useApp((s) => (tab.sessionId ? findSession(s.tree, tab.sessionId)?.title : undefined));
  if (tab.kind === "chat") return title || "Chat";
  if (tab.kind === "browser" && tab.url) return hostLabel(tab.url);
  if (tab.kind === "terminal" && tab.admin) return "Terminal (Admin)";
  return KIND_META[tab.kind].label;
}

/** A group's name: its own title if renamed, else its first chat's, else its first tab's. */
export function useGroupTitle(w: Group | undefined): string {
  const tabs = w ? tabsOf(w.root) : [];
  const chat = tabs.find((t) => t.kind === "chat");
  const chatTitle = useApp((s) => (chat?.sessionId ? findSession(s.tree, chat.sessionId)?.title : undefined));
  if (!w) return "";
  if (w.title) return w.title;
  if (chatTitle) return chatTitle;
  if (tabs[0]) return KIND_META[tabs[0].kind].label;
  return "Empty group";
}

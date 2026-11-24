import { TerminalService } from "@/lib/backend";
import { findPane, tabsOf, type Tab } from "@/lib/layout-tree";
import { findSession, useApp } from "@/stores/app-store";
import { useGroups } from "@/stores/group-store";
import { useLayout } from "@/stores/layout-store";

/** Each terminal tab's shell, so closing can check for a running command. */
const terminals = new Map<string, string>();

/** Records a terminal tab's shell id; returns the cleanup. */
export function trackTerminal(tabId: string, terminalId: string): () => void {
  terminals.set(tabId, terminalId);
  return () => {
    if (terminals.get(tabId) === terminalId) terminals.delete(tabId);
  };
}

/** What closing these tabs would cut off: chats still working and terminal commands. */
async function busyWith(tabs: Tab[]): Promise<string[]> {
  const { running, tree } = useApp.getState();
  const lines = tabs
    .filter((t) => t.kind === "chat" && t.sessionId && running[t.sessionId])
    .map((t) => `The agent is still working in “${findSession(tree, t.sessionId!)?.title || "Chat"}”.`);
  const shells = tabs.flatMap((t) => (t.kind === "terminal" && terminals.has(t.id) ? [terminals.get(t.id)!] : []));
  if (shells.length > 0) {
    const busy = (await TerminalService.Busy(shells).catch(() => null)) ?? [];
    if (busy.length === 1) lines.push("A command is still running in a terminal.");
    else if (busy.length > 1) lines.push(`Commands are still running in ${busy.length} terminals.`);
  }
  return lines;
}

/** Closes, asking first if anything in `tabs` is still running. */
async function guard(tabs: Tab[], what: "tab" | "window" | "group", close: () => void) {
  const lines = await busyWith(tabs);
  if (lines.length > 0) {
    const yes = await useLayout.getState().ask({ title: `Close ${what}?`, message: lines, action: `Close ${what}` });
    if (!yes) return;
  }
  close();
}

export function requestCloseTab(groupId: string, tabId: string) {
  const g = useGroups.getState().groups.find((x) => x.id === groupId);
  const tab = g && tabsOf(g.root).find((t) => t.id === tabId);
  if (tab) return guard([tab], "tab", () => useGroups.getState().closeTab(groupId, tabId));
}

export function requestClosePane(groupId: string, paneId: string) {
  const g = useGroups.getState().groups.find((x) => x.id === groupId);
  const pane = g && findPane(g.root, paneId);
  if (pane) return guard(pane.tabs, "window", () => useGroups.getState().closePane(groupId, paneId));
}

export function requestCloseGroup(groupId: string) {
  const g = useGroups.getState().groups.find((x) => x.id === groupId);
  if (g) return guard(tabsOf(g.root), "group", () => useGroups.getState().closeGroup(groupId));
}

import { useEffect } from "react";
import { TAB_KINDS, findPane, panesOf, sizeKind } from "@/lib/layout-tree";
import { requestCloseGroup, requestClosePane, requestCloseTab } from "@/lib/close-guard";
import { findShortcut, isMac, useShortcuts, type ShortcutId } from "@/lib/shortcuts";
import { closeInTab } from "@/lib/tab-close";
import { useGroups } from "@/stores/group-store";
import { useLayout } from "@/stores/layout-store";
import { useDrag } from "@/stores/drag-store";
import { useSettings } from "@/stores/settings-store";

/** How long ⌘/Ctrl must be held alone before the sidebar shows group numbers. */
const MOD_HINT_DELAY_MS = 350;

function run(id: ShortcutId, index: number) {
  const layout = useLayout.getState();
  const groups = useGroups.getState();
  const group = groups.groups.find((g) => g.id === groups.activeId);
  const pane = group && findPane(group.root, group.focused);

  // Closing the last, empty window of a group closes the group. Running chats and commands ask first.
  const closeWindow = () => {
    if (!group || !pane) return;
    if (panesOf(group.root).length === 1 && pane.tabs.length === 0) return void requestCloseGroup(group.id);
    void requestClosePane(group.id, pane.id);
  };

  // Text size follows the kind of tab in the focused window.
  const activeKind = pane?.tabs.find((t) => t.id === pane.active)?.kind;
  const focusedKind = activeKind && sizeKind(activeKind);

  switch (id) {
    case "zoomIn":
      return focusedKind && useSettings.getState().zoom(focusedKind, 1);
    case "zoomOut":
      return focusedKind && useSettings.getState().zoom(focusedKind, -1);
    case "zoomReset":
      return focusedKind && useSettings.getState().resetFontSize(focusedKind);
    // New windows open empty, showing 1–5 to choose what goes in them.
    case "newWindow":
      return void groups.openWindow();
    case "newTab":
      return group && pane && void groups.addTab(group.id, pane.id);
    case "splitRight":
      return group && pane && void groups.split(group.id, pane.id, "right");
    case "splitDown":
      return group && pane && void groups.split(group.id, pane.id, "bottom");
    case "newGroup":
      return group && void groups.newGroup(group.projectId);
    case "maximize":
      return group && pane && groups.toggleMaximize(group.id, pane.id);
    case "closeTab":
      // The tab may close something of its own first (a file open in the explorer).
      if (pane?.active && closeInTab(pane.active)) return;
      // The last tab of a group's only window takes the (then empty) group with it.
      if (group && pane?.active && panesOf(group.root).length === 1 && pane.tabs.length === 1) {
        return void requestCloseGroup(group.id);
      }
      if (group && pane?.active) return void requestCloseTab(group.id, pane.active);
      return closeWindow();
    case "closeWindow":
      return closeWindow();
    case "nextTab":
      return groups.cycleTab(1);
    case "prevTab":
      return groups.cycleTab(-1);
    case "focusLeft":
      return groups.focusDirection("left");
    case "focusRight":
      return groups.focusDirection("right");
    case "focusUp":
      return groups.focusDirection("up");
    case "focusDown":
      return groups.focusDirection("down");
    case "moveLeft":
      return groups.moveDirection("left");
    case "moveRight":
      return groups.moveDirection("right");
    case "moveUp":
      return groups.moveDirection("up");
    case "moveDown":
      return groups.moveDirection("down");
    case "goToGroup":
      return groups.goToGroup(index);
    case "nextGroup":
      return groups.cycleGroup(1);
    case "prevGroup":
      return groups.cycleGroup(-1);
    case "renameGroup":
      return group && layout.setRenamingGroup(group.id);
    case "search":
      return layout.setSearchOpen(!layout.searchOpen);
    case "findFile":
      return layout.setFileSearch(layout.fileSearch === "files" ? null : "files");
    case "findInFiles":
      return layout.setFileSearch(layout.fileSearch === "text" ? null : "text");
    case "toggleSidebar":
      return layout.toggleSidebar();
    case "settings":
      return layout.setSettingsOpen(true);
    case "shortcuts":
      return layout.setSettingsOpen(true, "shortcuts");
  }
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset", "file"].includes(el.type);
  return (el as HTMLElement).isContentEditable || !!el.closest(".xterm");
}

/** 1–5 typed while the focused window shows the choices (a new tab, or empty) picks one. */
function fillEmptyWindow(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  const kind = digit && TAB_KINDS[Number(digit[1]) - 1];
  if (!kind || document.querySelector("[role=dialog]")) return false;
  // Typing in a tab elsewhere is stale once an empty window is focused; other inputs (sidebar
  // rename, search) keep their keys.
  const el = document.activeElement;
  if (isTextEntry(el) && !el?.closest("[data-tab-content]")) return false;
  const groups = useGroups.getState();
  const group = groups.groups.find((g) => g.id === groups.activeId);
  const pane = group && findPane(group.root, group.focused);
  const placeholder = pane?.tabs.find((t) => t.id === pane.active)?.kind === "new";
  if (!group || !pane || (pane.tabs.length > 0 && !placeholder)) return false;
  void groups.fillTab(group.id, pane.id, kind);
  return true;
}

/** Global shortcuts. Capture phase so they work even when a terminal has focus. */
export function useHotkeys() {
  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHint = () => {
      clearTimeout(hintTimer);
      useLayout.getState().setModHeld(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // A modifier held on its own shows the group numbers after a moment.
      const modKey = isMac ? e.key === "Meta" : e.key === "Control";
      if (modKey && !e.shiftKey && !e.altKey) {
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => useLayout.getState().setModHeld(true), MOD_HINT_DELAY_MS);
        return;
      }
      clearHint();

      if (useShortcuts.getState().recording || useDrag.getState().drag) return;
      if (fillEmptyWindow(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const hit = findShortcut(e);
      if (!hit) return;
      // Plain Ctrl+letter belongs to a focused terminal (Ctrl+D ends input, Ctrl+C interrupts),
      // except closing a tab, which works everywhere as in browsers.
      const plainCtrlLetter = !isMac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^Key[A-Z]$/.test(e.code);
      if (plainCtrlLetter && hit.id !== "closeTab" && document.activeElement?.closest(".xterm")) return;
      // Leave dialogs (search, settings) their own keys, except the ones that toggle them.
      if (document.querySelector("[role=dialog]") && !["search", "settings", "shortcuts"].includes(hit.id)) return;
      e.preventDefault();
      e.stopPropagation();
      run(hit.id, hit.index);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", clearHint, { capture: true });
    window.addEventListener("blur", clearHint);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", clearHint, { capture: true });
      window.removeEventListener("blur", clearHint);
    };
  }, []);
}

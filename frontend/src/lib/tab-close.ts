/**
 * Tab contents that close something of their own before the tab itself on Ctrl/⌘+W (a file
 * open inside the explorer, say). A handler returns true when it closed something.
 */
const handlers = new Map<string, () => boolean>();

/** Registers a tab's handler; returns the unregister function (for effect cleanups). */
export function onCloseInTab(tabId: string, handler: () => boolean): () => void {
  handlers.set(tabId, handler);
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}

/** Lets the tab close something inside it first; true if it did. */
export function closeInTab(tabId: string): boolean {
  return handlers.get(tabId)?.() ?? false;
}

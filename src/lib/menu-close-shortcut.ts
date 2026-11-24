// ⌘W that nothing on the page claimed, handed back by the macOS app menu (the
// Rust `app_menu` module). The workspace claims ⌘W in its own keydown listener,
// but a keystroke pressed inside an iframe goes to that frame's document, and
// one pressed inside a built-in browser page or an HTML document view goes to
// another webview altogether. The menu is where those end up — and where its
// "Close Window" used to close the whole workspace instead of a tab.

import type { WorkspaceMode, WorkspacePane } from "@/contexts/workspace-context"

export const CLOSE_SHORTCUT_EVENT = "app://close-shortcut"

export interface CloseShortcutPayload {
  /** The workspace window ⌘W was pressed in. Every webview hears the event,
   *  so each listener checks this against its own window. */
  window: string
  /** The built-in browser surface that had keyboard focus, by backend tab id
   *  — only the native side can tell which of its views that was. */
  surfaceTabId: string | null
}

/** The chord the menu item is bound to, as the shortcut matcher reads it. */
export const MENU_CLOSE_CHORD = {
  key: "w",
  code: "KeyW",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
} as const

export type CloseShortcutOrigin =
  /** An element of this document that stands for where it was pressed: the
   *  focused iframe, or the placeholder a native surface is fitted to. */
  | { kind: "element"; element: Element }
  /** This document had the keystroke, and its listeners let it through. */
  | { kind: "page" }
  /** No view in the window had keyboard focus — as after the page that had it
   *  was closed. */
  | { kind: "window" }
  /** A surface this document does not show. */
  | { kind: "unknown" }

export function closeShortcutOrigin(
  surfaceTabId: string | null,
  doc: Document = document
): CloseShortcutOrigin {
  if (surfaceTabId !== null) {
    const placeholder = findSurfacePlaceholder(surfaceTabId, doc)
    return placeholder
      ? { kind: "element", element: placeholder }
      : { kind: "unknown" }
  }
  // True while an iframe of this document has focus too: `hasFocus` counts
  // nested browsing contexts, and `activeElement` is then the iframe.
  if (!doc.hasFocus()) return { kind: "window" }
  const active = doc.activeElement
  return active instanceof HTMLIFrameElement
    ? { kind: "element", element: active }
    : { kind: "page" }
}

/** The placeholder `NativeSurfaceHost` renders for a surface. A browser tab
 *  can have two at once (the file column hidden under a full-page route, and
 *  the side panel over it); the page is showing at the visible one. */
function findSurfacePlaceholder(
  backendId: string,
  doc: Document
): Element | null {
  for (const element of doc.querySelectorAll("[data-browser-surface]")) {
    if (element.getAttribute("data-browser-surface") !== backendId) continue
    if (
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ visibilityProperty: true } as never)
    ) {
      return element
    }
  }
  return null
}

/** The workspace pane `element` sits in, by the `data-workspace-pane` mark on
 *  each pane's content (see the workspace layout). Null outside both: a side
 *  panel, a full-page route. */
export function workspacePaneOf(element: Element): WorkspacePane | null {
  const pane = element
    .closest("[data-workspace-pane]")
    ?.getAttribute("data-workspace-pane")
  return pane === "conversation" || pane === "files" ? pane : null
}

/** Which tab strip the workspace's tab shortcuts act on, with `pane` as the
 *  pane the user is in. A maximized column covers the other one, so while
 *  either is maximized its strip — the only one on screen — is the one meant,
 *  whatever pane was last active. */
export function tabShortcutTarget(
  mode: WorkspaceMode,
  pane: WorkspacePane,
  filesMaximized: boolean,
  conversationMaximized: boolean
): { conversation: boolean; files: boolean } {
  const target: WorkspacePane = filesMaximized
    ? "files"
    : conversationMaximized
      ? "conversation"
      : pane
  return {
    conversation:
      mode === "conversation" ||
      (mode === "fusion" && target === "conversation"),
    files: mode === "fusion" && target === "files",
  }
}

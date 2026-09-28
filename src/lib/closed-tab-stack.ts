import type { AgentType } from "@/lib/types"

export const CLOSED_TAB_STACK_LIMIT = 20

export type ClosedConversationTab = {
  kind: "conversation"
  /** The closed tab's id. Identity for the repeat-push guard in `pushClosedTab`. */
  key: string
  /**
   * The strip slot the tab was closed from. Reopening splices the tab back in
   * there, clamped to the strip's current length, instead of appending it:
   * a restored tab goes back where it was, the way a browser puts it.
   */
  index: number
  folderId: number
  conversationId: number | null
  agentType: AgentType
  title: string
  workingDir?: string
  isPinned: boolean
}

export type ClosedFileTab = {
  kind: "file"
  /** The closed tab's id. Identity for the repeat-push guard in `pushClosedTab`. */
  key: string
  /** See `ClosedConversationTab.index`. */
  index: number
  path: string
  folderId: number | null
}

export type ClosedBrowserTab = {
  kind: "browser"
  /** The closed tab's id. Identity for the repeat-push guard in `pushClosedTab`. */
  key: string
  /** See `ClosedConversationTab.index`. */
  index: number
  /** The page the tab showed when it was closed (not the one it opened with). */
  url: string
  title: string
  folderId: number | null
  /** The browser profile the tab lived in; it reopens in the same one. */
  profile: string
  /** An address on the remote codeg host (`BrowserTabSeed.remote`): it
   *  reopens as one, never as a page of this computer. */
  remote?: true
}

export type ClosedWorkspaceTab =
  | ClosedConversationTab
  | ClosedFileTab
  | ClosedBrowserTab

let stack: ClosedWorkspaceTab[] = []

/**
 * Record a tab so `reopen_last_closed_tab` can bring it back. One entry per tab
 * id: re-recording a tab moves it to the top instead of appending a duplicate,
 * which is both what "reopen the last closed tab" means and what makes this
 * callable from inside a React state updater.
 *
 * The file-tab closers push from inside a `setFileTabs` updater, which React
 * double-invokes under StrictMode and may replay when it discards a render.
 * Move-to-top makes any number of extra passes land on the same stack — for a
 * "close all" loop too, where a guard against only the top entry would still
 * let a second pass append the whole batch again.
 */
export function pushClosedTab(tab: ClosedWorkspaceTab): void {
  const existing = stack.findIndex((entry) => entry.key === tab.key)
  if (existing >= 0) stack.splice(existing, 1)
  stack.push(tab)
  if (stack.length > CLOSED_TAB_STACK_LIMIT) {
    stack = stack.slice(-CLOSED_TAB_STACK_LIMIT)
  }
}

export function popClosedTab(): ClosedWorkspaceTab | null {
  return stack.pop() ?? null
}

/**
 * Forget a conversation that no longer exists. Declining to record at close
 * time only covers a tab that was still open — a conversation closed earlier is
 * already on the stack, and deleting it then (from this window or another) has
 * to reach back and remove it. Drafts never match: they carry a null
 * `conversationId`.
 */
export function forgetClosedConversation(conversationId: number): void {
  stack = stack.filter(
    (entry) =>
      entry.kind !== "conversation" || entry.conversationId !== conversationId
  )
}

/** Forget everything recorded for a folder that no longer exists. */
export function forgetClosedTabsInFolder(folderId: number): void {
  stack = stack.filter((entry) => entry.folderId !== folderId)
}

export function peekClosedTab(): ClosedWorkspaceTab | null {
  return stack[stack.length - 1] ?? null
}

export function resetClosedTabStackForTests(): void {
  stack = []
}

/**
 * The slot to record for each member of a batch close, in strip order. The
 * stack is popped newest-first, so a member's slot is where it would sit once
 * the members before it are already gone, as if the batch had closed one tab
 * at a time: `[a, b, c]` closed together records every tab at 0, and reopening
 * c, then b, then a rebuilds `[a, b, c]` ahead of whatever replaced them.
 * Closing all but `b` records a@0, c@1, d@1 and rebuilds `[a, b, c, d]`. A
 * closed member that is never recorded (a diff tab) still shifts what follows.
 */
export function batchCloseSlots<T>(
  strip: readonly T[],
  closing: (tab: T) => boolean = () => true
): Array<[tab: T, slot: number]> {
  const out: Array<[T, number]> = []
  strip.forEach((tab, i) => {
    if (closing(tab)) out.push([tab, i - out.length])
  })
  return out
}

/**
 * `index` is the tab's slot in its strip as it closes. A batch close (close
 * others, close all) takes it from `batchCloseSlots`, not from the pre-close
 * strip.
 */
export function snapshotConversationTab(
  tab: {
    id: string
    folderId: number
    conversationId: number | null
    agentType: AgentType
    title: string
    workingDir?: string
    isPinned: boolean
  },
  index: number
): ClosedConversationTab {
  return {
    kind: "conversation",
    key: tab.id,
    index,
    folderId: tab.folderId,
    conversationId: tab.conversationId,
    agentType: tab.agentType,
    title: tab.title,
    workingDir: tab.workingDir,
    isPinned: tab.isPinned,
  }
}

/**
 * Only a real file tab is restorable: reopening goes through `openFilePreview`,
 * which opens the source editor. A `diff` / `rich-diff` tab carries a path too
 * (a branch comparison, an external-conflict view) but that path is the file it
 * compares, not what the tab shows — restoring it would silently swap the diff
 * for the editor. A pathless tab (the whole-worktree diff) has nothing to key on.
 */
export function snapshotFileTab(
  tab: {
    id: string
    kind: string
    path: string | null
    folderId: number | null
  },
  index: number
): ClosedFileTab | null {
  if (tab.kind !== "file") return null
  if (!tab.path) return null
  return {
    kind: "file",
    key: tab.id,
    index,
    path: tab.path,
    folderId: tab.folderId,
  }
}

/**
 * A browser tab reopens at the page it was showing, which is the live URL
 * the caller reads from the tab store — the record itself only knows the
 * address the tab was opened with.
 */
export function snapshotBrowserTab(
  tab: {
    id: string
    folderId: number | null
    browser: { profile: string; remote?: true }
  },
  url: string,
  title: string,
  index: number
): ClosedBrowserTab {
  return {
    kind: "browser",
    key: tab.id,
    index,
    url,
    title,
    folderId: tab.folderId,
    profile: tab.browser.profile,
    ...(tab.browser.remote ? { remote: true as const } : {}),
  }
}

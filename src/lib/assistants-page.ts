/**
 * Whether the assistants page is the current page of this window: its keys
 * (⌘1–⌘9, ⌥↑/⌥↓, Ctrl+Tab — `useAssistantShortcuts`) win over the
 * workspace's tab keys only then (10.9). The page is mounted only while it
 * is the current route, so it holds this while mounted; a count, so a
 * second mount (React's development double mount) letting go first does
 * not clear it.
 */

let holders = 0

/** Mark the page current; call the result when it goes. */
export function holdAssistantsPage(): () => void {
  holders += 1
  let held = true
  return () => {
    if (!held) return
    held = false
    holders = Math.max(0, holders - 1)
  }
}

export function isAssistantsPageCurrent(): boolean {
  return holders > 0
}

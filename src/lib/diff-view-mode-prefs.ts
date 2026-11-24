// Inline vs. side-by-side layout for the lightweight diff preview
// (`UnifiedDiffPreview`). Persisted in localStorage; defaults to the inline
// view so the existing look is unchanged until the user opts in.
//
// The preference is GLOBAL, and a single screen routinely mounts several
// previews at once (one per Edit/Write tool call in a transcript, plus any
// permission dialog stacked on top). Reading localStorage once per instance
// would leave every already-mounted sibling on the old layout until it
// remounted, so the toggle broadcasts and each preview subscribes — the same
// shape `office-preview-prefs` uses for its cross-surface toggle.

import { useEffect, useState } from "react"

export type DiffViewMode = "unified" | "split"

const DIFF_VIEW_MODE_KEY = "workspace:diff-view-mode"
const DIFF_VIEW_MODE_EVENT = "codeg:diff-view-mode-changed"

export function loadDiffViewMode(): DiffViewMode {
  if (typeof window === "undefined") return "unified"
  try {
    const raw = localStorage.getItem(DIFF_VIEW_MODE_KEY)
    if (raw === "split" || raw === "unified") return raw
  } catch {
    /* ignore */
  }
  return "unified"
}

export function saveDiffViewMode(mode: DiffViewMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(DIFF_VIEW_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
  // Notify every preview mounted in THIS window; other windows/tabs get the
  // native `storage` event. The new mode rides along on the event so the
  // toggle still works in a browser where the write above threw (quota,
  // storage disabled) — it just won't survive a reload.
  window.dispatchEvent(new CustomEvent(DIFF_VIEW_MODE_EVENT, { detail: mode }))
}

function modeFromEvent(event: Event): DiffViewMode | null {
  const detail = (event as CustomEvent<unknown>).detail
  return detail === "split" || detail === "unified" ? detail : null
}

/**
 * Reactive read of the diff view mode, plus the setter that persists it.
 * Every mounted preview flips together — including ones the user is not
 * pointing at — because the mode is one preference, not per-preview state.
 */
export function useDiffViewMode(): [
  DiffViewMode,
  (mode: DiffViewMode) => void,
] {
  const [mode, setMode] = useState<DiffViewMode>(loadDiffViewMode)
  useEffect(() => {
    // Same-window broadcasts carry the value; a cross-window `storage` event
    // does not, so re-read for those.
    const sync = (event: Event) =>
      setMode(modeFromEvent(event) ?? loadDiffViewMode())
    window.addEventListener(DIFF_VIEW_MODE_EVENT, sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener(DIFF_VIEW_MODE_EVENT, sync)
      window.removeEventListener("storage", sync)
    }
  }, [])
  // `saveDiffViewMode` writes and then dispatches synchronously, so this
  // instance updates through the same subscription as its siblings — one path
  // instead of a local `setState` that could drift from the broadcast one.
  return [mode, saveDiffViewMode]
}

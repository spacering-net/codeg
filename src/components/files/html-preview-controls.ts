"use client"

import { useEffect, useSyncExternalStore } from "react"

import type { HtmlPreviewEngine } from "@/lib/browser/browser-prefs"

/** Where an HTML preview puts its controls: its own header strip, or its
 *  host's (published here). */
export type HtmlPreviewChrome = "bar" | "hoisted"

/**
 * An HTML preview's own controls, published for its host to render.
 *
 * The preview has two chromes (see `HtmlPreview`'s `chrome` prop). With
 * `"bar"` it draws its own header strip — that is what the transcript's file
 * viewer drawer and the canvas file card get, since neither has a place to put
 * these. With `"hoisted"` it draws no strip at all and publishes the same
 * controls here instead, so the file column can fold them into the one header
 * it already has (`FileWorkspaceHeader`) rather than stacking a second row of
 * chrome under it.
 *
 * Labels travel WITH the actions on purpose: "enable scripts" means something
 * different per renderer (the inline iframe gets the network, the document
 * guest does not), so only the renderer can name and explain its own switch.
 * The host stays a dumb renderer of whatever it is handed.
 */
export interface HtmlPreviewControls {
  /** Whether the document's scripts may run — the preview's one security
   *  switch, always shown by the host rather than buried in a menu. */
  scripts: {
    on: boolean
    /** No renderer behind it yet (the guest is still being created). */
    disabled: boolean
    /** State-dependent label, e.g. "Enable scripts" / "Scripts on". */
    label: string
    /** The longer explanation, shown on hover. */
    hint: string
    toggle: () => void
  }
  /** Re-render the document from disk. Absent where the renderer has no such
   *  notion (the inline preview renders the tab's own bytes). */
  reload: { label: string; run: () => void } | null
  /** Switch this file to the OTHER renderer, for the session. */
  switchEngine: {
    to: HtmlPreviewEngine
    label: string
    run: () => void
  } | null
  /** A passive remark about what is on screen ("unsaved changes are not
   *  shown"), shown next to the controls. */
  note: string | null
}

// Keyed by file tab id: the host looks up the tab it is showing, so a preview
// that is still mounted behind a full-page route can never drive the header of
// a different file.
const published = new Map<string, HtmlPreviewControls>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish a hoisted preview's controls for as long as it is mounted.
 *
 * `controls` must be a memoized value — it is the effect's dependency, so a
 * fresh object each render would republish (and re-render the host) on every
 * pass.
 */
export function usePublishHtmlPreviewControls(
  tabId: string,
  controls: HtmlPreviewControls | null
): void {
  useEffect(() => {
    if (!controls) return
    published.set(tabId, controls)
    emit()
    return () => {
      // Identity-guarded: switching renderers unmounts one preview and mounts
      // the other, and a stale cleanup must not wipe the newcomer's entry.
      if (published.get(tabId) !== controls) return
      published.delete(tabId)
      emit()
    }
  }, [controls, tabId])
}

/** The controls of the preview showing `tabId`, if one is hoisted. */
export function useHtmlPreviewControls(
  tabId: string | null
): HtmlPreviewControls | null {
  return useSyncExternalStore(
    subscribe,
    () => (tabId ? (published.get(tabId) ?? null) : null),
    () => null
  )
}

/** Tests only. */
export function resetHtmlPreviewControlsForTests(): void {
  published.clear()
  emit()
}

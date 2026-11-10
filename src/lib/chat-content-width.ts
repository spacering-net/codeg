import type React from "react"

import { STORAGE_KEY_CHAT_CONTENT_WIDTH } from "./appearance-script"

/** The `<html>` custom property the `chat-content-w` utility reads. */
export const CHAT_CONTENT_WIDTH_VAR = "--chat-content-width"

/*
 * Every content width here — stored, dragged, typed into the slider — is in px
 * AT 100% ZOOM. App zoom rescales the root font size (see `setZoomLevel`), and
 * the width is written to CSS in rem, so it grows and shrinks with the zoom
 * exactly like the 48rem default does. A raw px width would stay put while the
 * text around it grew: a column set at 100% would hold half as many characters
 * at 200%, and at 80% the default (614px) would sit below the drag floor.
 */
const BASE_REM_PX = 16

/** The built-in width, 48rem (the old `max-w-3xl`). */
export const CHAT_CONTENT_DEFAULT = 768

/** Floor for a dragged content width. */
export const CHAT_CONTENT_MIN = 640

/**
 * Blank strip (CSS px, not zoom-scaled) kept on EACH side of the chat column,
 * whatever the width. The column may never run edge to edge: the drag handles
 * sit just inside its edges, and a handle pushed onto the window border would
 * lose every later press to the window's own resize grip (4px on Linux, ~8px
 * on Windows), which does not grow with the app zoom either. Exposed to CSS as
 * `--chat-gutter` on the conversation shell (see `chatGutterStyle`), which the
 * `chat-content-w` utility subtracts.
 */
export const CHAT_CONTENT_GUTTER = 12

/** CSS variable the `chat-content-w` utility reads for the gutter. */
export const CHAT_GUTTER_VAR = "--chat-gutter"

/** Inline style that turns the gutter on for a subtree. */
export const chatGutterStyle = {
  [CHAT_GUTTER_VAR]: `${CHAT_CONTENT_GUTTER}px`,
} as React.CSSProperties

/** Upper bound for a stored value; anything larger is treated as corrupt. */
const CHAT_CONTENT_SANE_MAX = 10000

/** The persisted width preference in px, or null when absent or corrupt. */
export function readChatContentWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 && value <= CHAT_CONTENT_SANE_MAX
      ? value
      : null
  } catch {
    return null
  }
}

/** The CSS length for a width in px at 100% zoom. */
export function chatContentWidthCss(px: number): string {
  return `${px / BASE_REM_PX}rem`
}

/**
 * The app zoom as a factor: how many CSS px one px at 100% zoom takes right
 * now. Read off the root font size, which is what rem resolves against.
 */
export function chatZoomFactor(): number {
  const rootPx = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  )
  return Number.isFinite(rootPx) && rootPx > 0 ? rootPx / BASE_REM_PX : 1
}

/** Show `px` (or the built-in default for null) without touching storage. */
export function applyChatContentWidth(px: number | null) {
  const style = document.documentElement.style
  if (px === null) style.removeProperty(CHAT_CONTENT_WIDTH_VAR)
  else style.setProperty(CHAT_CONTENT_WIDTH_VAR, chatContentWidthCss(px))
}

/** Apply and persist; null resets to the default. */
export function commitChatContentWidth(px: number | null) {
  applyChatContentWidth(px)
  try {
    if (px === null) localStorage.removeItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)
    else localStorage.setItem(STORAGE_KEY_CHAT_CONTENT_WIDTH, `${px}`)
  } catch {
    // Storage unavailable: the width still holds for this session.
  }
}

/**
 * The widest the column can be in a host `columnWidth` CSS px wide, in px at
 * 100% zoom: all of it but the gutter on both sides. Relative to the host, so
 * it follows the window (and the side panels) instead of being a fixed px
 * ceiling.
 */
export function maxChatContentWidth(columnWidth: number, zoom = 1): number {
  return Math.max(0, (columnWidth - 2 * CHAT_CONTENT_GUTTER) / zoom)
}

/**
 * The width a resize gesture should store, or null when it should store
 * nothing. `current` is the column's visible width and `wanted` the width the
 * gesture asks for, both in px at 100% zoom; `columnWidth` is the host's width
 * in CSS px.
 *
 * Bounded by what the host can show and never lifted past it. In a host too
 * narrow for the floor, every width from the floor up renders the same (CSS
 * caps it), so storing one would quietly replace the preference with a value
 * the user never saw — and the floor is narrower than the default. Likewise a
 * gesture that leaves the visible width where it was (pushing outward at the
 * cap) keeps whatever the preference already is.
 */
export function resizedChatContentWidth(
  current: number,
  wanted: number,
  columnWidth: number,
  zoom = 1
): number | null {
  const max = maxChatContentWidth(columnWidth, zoom)
  if (max < CHAT_CONTENT_MIN) return null
  const next = Math.min(Math.max(wanted, CHAT_CONTENT_MIN), max)
  // Compared before rounding: a cap can fall on a half (a 1601px host at 200%
  // zoom shows 788.5), and rounding it up would read as a change, replacing a
  // wider preference with no visible effect.
  if (Math.abs(next - current) < 0.5) return null
  return Math.round(next)
}

/**
 * Upper end of the Settings slider: the widest the column can get in a window
 * filling a screen `screenWidth` CSS px wide at `zoom`, on the slider's 8px
 * grid. The settings page measures the screen, not its own window: on the
 * desktop it is a separate window, so `innerWidth` would be its own width.
 * Never below the default, so the slider can always show where the default
 * sits (and never collapses to a zero-length range on a small screen at a high
 * zoom); a value the window cannot fit is capped by CSS as usual.
 */
export function chatContentWidthCeiling(screenWidth: number, zoom = 1): number {
  return Math.max(
    CHAT_CONTENT_DEFAULT,
    Math.floor(maxChatContentWidth(screenWidth, zoom) / 8) * 8
  )
}

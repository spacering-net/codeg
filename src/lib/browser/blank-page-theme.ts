import { readEffectiveTokenValue, toHexColor } from "@/lib/custom-style"

import { browserSetBlankPageTheme } from "./browser-api"

/** The colours the empty tab's page is painted with. */
export interface BlankPageTheme {
  /** `--background` resolved to `#rrggbb`. */
  background: string
  dark: boolean
}

/**
 * What the empty tab's page should look like right now.
 *
 * Null when the colour cannot be resolved to `#rrggbb` — `--background` is
 * `oklch()` in this app's themes, and normalising one goes through a canvas
 * the engine may refuse (see `toHexColor`). The page then stays as the engine
 * drew it, which is where it was before any of this: a wrong colour on the
 * page would be worse than the plain one.
 */
export function readBlankPageTheme(): BlankPageTheme | null {
  if (typeof document === "undefined") return null
  const background = toHexColor(readEffectiveTokenValue("background"))
  if (!background) return null
  return {
    background,
    dark: document.documentElement.classList.contains("dark"),
  }
}

/** Delay before another go at a failed push, as for the site rules pushed
 *  next to this one in `BrowserEventsBridge`. */
const PUSH_RETRY_MS = 1000
/** Goes at one colour: the push, and one more after it. */
const PUSH_ATTEMPTS = 2

// ONE pusher for the document, not one per watcher. What is being kept in
// step is a single value on the backend, and two pushes travelling together
// are two commands on its runtime, applied in either order — the loser being
// the colour it is left holding, on a page nobody is going to change again.
// Two watchers can overlap for an instant (a remount, React's development
// double-invoke), so the queue cannot belong to either of them.
let watching = 0
/** How many watchers there are, and what the backend has acknowledged — null
 *  whenever nobody is watching, since the theme can move unseen. */
let applied: string | null = null
/** The colour being attempted and how many goes it has had. Per colour, not
 *  per push: a change that arrives while a doomed push is in flight has had
 *  no attempt of its own and must not inherit that one's last chance. */
let attempted: string | null = null
let attempts = 0
let sending = false
let retry: number | null = null

/**
 * Send the colour on screen, if it is not the one the backend has and no
 * push is already travelling. A change heard while one is in flight is not
 * queued: the push re-reads the theme when it lands, and that read is the
 * change — by then it is also the colour that is actually on screen.
 */
function push(): void {
  if (!watching || sending) return
  const theme = readBlankPageTheme()
  if (!theme) return
  const key = `${theme.background}/${theme.dark}`
  // Most root-attribute changes are not colour changes at all (the UI font,
  // the workspace background switch): the backend hears about the ones that
  // are, and nothing else.
  if (key === applied) return
  if (key !== attempted) {
    attempted = key
    attempts = 0
  } else if (attempts >= PUSH_ATTEMPTS) {
    return
  }
  attempts += 1
  sending = true
  void browserSetBlankPageTheme(theme).then(
    () => {
      // A colour nobody was watching for is not one to remember holding: the
      // theme may have moved while there was no observer on the root.
      applied = watching ? key : null
      sending = false
      // Whatever changed while that was in flight is settled here; if nothing
      // did, this reads the colour just acknowledged and stops.
      push()
    },
    () => {
      sending = false
      if (attempts >= PUSH_ATTEMPTS) {
        // The command has no reason to fail except the app shutting down, and
        // nothing on the page is owed to us afterwards — a blank page left in
        // the colours of the theme the user has just left is the whole of
        // what this exists to prevent.
        console.warn(
          "[browser] the blank page's colours could not be sent to the backend"
        )
      }
      // This colour's second go — or the first of a newer one, if the theme
      // moved while that push was failing. `push` decides which when it runs,
      // and does nothing if it is neither.
      if (watching) {
        retry = window.setTimeout(() => {
          retry = null
          push()
        }, PUSH_RETRY_MS)
      }
    }
  )
}

/**
 * Keep the backend's idea of the empty tab's page in step with the theme, for
 * as long as the returned function has not been called.
 *
 * Pushed on start and on every change to the ROOT element's attributes, which
 * is where every appearance change lands: the `dark` class, a preset's
 * `data-theme`, a custom theme's inline variables (`appearance-provider`).
 * Watching the element rather than subscribing to each of those means a new
 * way of changing the theme is carried without anyone remembering this.
 */
export function watchBlankPageTheme(): () => void {
  watching += 1
  const observer = new MutationObserver(() => push())
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  })
  push()
  let stopped = false
  return () => {
    // Teardown can be called twice — React does, in development — and the
    // count is what decides whether anybody is left watching.
    if (stopped) return
    stopped = true
    observer.disconnect()
    watching -= 1
    if (watching) return
    // Nobody is left to hear the next change, so nothing here can still claim
    // to know what the backend holds by the time somebody is. `sending` is
    // not touched: it belongs to the push that is travelling.
    if (retry !== null) {
      window.clearTimeout(retry)
      retry = null
    }
    applied = null
    attempted = null
    attempts = 0
  }
}

"use client"

import * as React from "react"

import { openUrl } from "@/lib/platform"

/**
 * A link to somewhere outside the app — the ONLY way to write one.
 *
 * A bare `<a target="_blank">` is a trap: it works in the browser (web mode,
 * `next dev`) and is DEAD in the desktop app. `target="_blank"` asks the
 * webview for a new window, and codeg registers no `on_new_window` handler, so
 * wry answers the request with nil on macOS and cancels it outright on Windows
 * (`args.SetHandled(true)`). Either way the click does nothing at all — no
 * navigation, no error, no clue. An eslint rule bans the attribute outside this
 * file so the trap cannot be re-laid.
 *
 * So the click is routed through `openUrl` instead: the Tauri opener plugin on
 * desktop (system browser), `window.open` on web. `href`/`target`/`rel` stay on
 * the element because they are what make it a LINK rather than a clickable
 * span — "copy link address", the status-bar preview and assistive tech all
 * read the DOM, not the handler.
 *
 * KNOWN LIMIT: middle-click fires `auxclick`, not `click`, so it still takes
 * the native path — a background tab in web mode, and nothing on desktop.
 *
 * `preventDefault` is not optional: on web, letting the native `_blank` through
 * would open the tab twice, once for the browser and once for `openUrl`.
 *
 * Modified clicks (⌘/ctrl/shift) go through `openUrl` too. Letting them fall
 * through to the native default would restore the dead click on desktop, and
 * one predictable outcome beats a shortcut that works on one runtime only.
 *
 * An `onClick` of your own runs FIRST — pass one to `stopPropagation` inside a
 * clickable card. Call `preventDefault` in it to keep the link from opening at
 * all (the conventional "I handled this myself").
 */
export function BrowserLink({
  href,
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<"a">, "href" | "target"> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        void openUrl(href)
      }}
    >
      {children}
    </a>
  )
}

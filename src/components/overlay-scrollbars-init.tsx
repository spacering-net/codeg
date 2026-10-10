"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import "overlayscrollbars/overlayscrollbars.css"
import {
  useOverlayScrollbars,
  type UseOverlayScrollbarsParams,
} from "overlayscrollbars-react"

// Routes whose page is a fixed, viewport-filling shell: the body never
// scrolls there (every pane scrolls inside itself), so a body-level instance
// has nothing to do — and it is not free. OverlayScrollbars measures its host
// from a window `resize` listener and a ResizeObserver, each forcing a
// synchronous layout of the host — here the whole document — so every window
// resize step paid two full-page layouts on top of the real one. Profiled on
// the workspace with a long transcript: ~66ms resize frames (vs a 16ms
// budget), back under the long-frame threshold without it; in the desktop app
// that lag also held back the window itself, which waits on the webview.
const BODY_FIXED_ROUTES = ["/workspace"]

function isBodyFixedRoute(pathname: string | null): boolean {
  return BODY_FIXED_ROUTES.some(
    (route) => pathname === route || pathname?.startsWith(`${route}/`)
  )
}

const BODY_SCROLLBARS_OPTIONS: UseOverlayScrollbarsParams["options"] = {
  scrollbars: {
    theme: "os-theme-codeg",
    autoHide: "leave",
    dragScroll: false,
  },
  overflow: { x: "hidden" },
}

export function OverlayScrollbarsInit() {
  const pathname = usePathname()
  // Follows client-side navigation too: `/` and `/login` route into the
  // workspace with `router.replace`, which keeps this component mounted.
  // Arriving there unmounts the instance's owner rather than destroying the
  // instance, because the init is deferred: one that has not run yet has no
  // instance to destroy, and only the hook's unmount cleanup cancels it.
  if (isBodyFixedRoute(pathname)) return null
  return <BodyOverlayScrollbars />
}

function BodyOverlayScrollbars() {
  const [init] = useOverlayScrollbars({
    options: BODY_SCROLLBARS_OPTIONS,
    defer: true,
  })

  useEffect(() => {
    init(document.body)
  }, [init])

  return null
}

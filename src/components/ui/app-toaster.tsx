"use client"

import { useEffect, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import { Toaster, toast, useSonner, type ToasterProps } from "sonner"

import {
  acquireNativeSurfaceOcclusion,
  subscribeNativeSurfaceReclaim,
} from "@/lib/browser/native-surface-occlusion"

/** Client-only gate that survives hydration: `false` on the server AND on the
 *  hydration pass, `true` on the first render after it — so the portal below
 *  never makes the two disagree. */
const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

/**
 * Longest a run of toasts may keep a page down.
 *
 * Every toast this app raises goes away on its own well inside it (the
 * workspace's own are the longest at 15 s), so this is not a reading budget —
 * it is the stop on a toast that never leaves: one raised with an infinite
 * duration, or one whose dismissal was lost. The page comes back; the toast
 * stays, hidden behind it, as it was before any of this.
 */
const MAX_HOLD_MS = 20_000

/**
 * While a toast is on screen, hold the native browser surfaces down.
 *
 * A child webview paints above every DOM element of the window (see
 * `native-surface-occlusion`), so a toast raised while a browser tab is open
 * is not "behind" the page in any way a z-index could fix — it is simply not
 * on screen. The lease is a PASSIVE one: the hosts leave the page's last frame
 * in place, keep the keyboard where it was, refuse to blank a pane that has no
 * frame to leave, and give the page straight back when the user reaches for it
 * — which is what the reclaim below answers, by taking the toasts away.
 *
 * Costs nothing where there is no surface to hold down (every other window,
 * and the workspace whenever no browser tab is showing): the store has no
 * subscribers and the lease is a counter bump.
 */
function ToastOcclusion() {
  const { toasts } = useSonner()
  const showing = toasts.length > 0

  useEffect(() => {
    if (!showing) return
    // One lease and one timer per RUN of toasts, not per toast: the effect
    // only re-runs when the screen goes empty, so toasts arriving back to
    // back hold the page down once instead of flickering it in between.
    const release = acquireNativeSurfaceOcclusion("toast", { passive: true })
    const timer = window.setTimeout(release, MAX_HOLD_MS)
    const unsubscribe = subscribeNativeSurfaceReclaim(() => toast.dismiss())
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
      release()
    }
  }, [showing])

  return null
}

export function AppToaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme()
  const theme = props.theme ?? (resolvedTheme === "dark" ? "dark" : "light")
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer)

  if (!mounted) return null
  // Portalled to the body, because sonner's z-index is only worth what its
  // stacking context is: the workspace shell's root is `fixed inset-0`, which
  // establishes one, and every dialog portals to the body at z-50 — so a toast
  // raised while a dialog is open (the error that explains why the button did
  // nothing) painted UNDER it. In the body the toaster sits in the root
  // stacking context, above every overlay, wherever it is mounted from.
  return createPortal(
    <>
      <Toaster {...props} theme={theme} />
      {/* Its own component so the toast list it watches re-renders nothing
          but itself. */}
      <ToastOcclusion />
    </>,
    document.body
  )
}

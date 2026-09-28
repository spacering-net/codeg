"use client"

import { Loader2 } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { useWorkspaceView } from "@/contexts/workspace-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import {
  browserFreezeFrame,
  browserOpenTab,
  browserSetBounds,
  browserSetVisible,
} from "@/lib/browser/browser-api"
import {
  browserProfileExists,
  DEFAULT_BROWSER_PROFILE_ID,
  getBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import { browserClose } from "@/lib/browser/browser-api"
import {
  browserHostsShowing,
  claimSurfaceCreation,
  forgetSurfaceCreation,
  getBrowserTabState,
  hasSurfaceClaim,
  markBrowserCreatePending,
  markBrowserHostShowing,
  markBrowserTabHidden,
  markBrowserTabShown,
  releaseBrowserTab,
  runSurfaceOp,
  setBrowserTabState,
  settleBrowserCreate,
  surfaceClaimIsCurrent,
  useBrowserBoundsResync,
  useBrowserCreateOutcome,
  useBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  requestNativeSurfaceReclaim,
  useFallbackOverlayOpen,
  useNativeSurfaceOccluded,
  useNativeSurfaceOcclusionPassive,
} from "@/lib/browser/native-surface-occlusion"
import type { Bounds, BrowserTabState } from "@/lib/browser/types"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { cn } from "@/lib/utils"

/**
 * True for a host rendered beside the workbench's content region rather than
 * in it — the transcript's side panel, portalled over whatever route is up.
 * The route only decides for hosts inside the region it swaps out (the file
 * column, CSS-hidden under a full-page route); one beside it is on screen
 * whatever the route.
 */
export const NativeSurfaceBesideRoute = createContext(false)

/** How often the host re-checks CSS visibility it cannot observe otherwise
 *  (a `visibility: hidden` ancestor toggled by the layout). One
 *  `checkVisibility()` call per tick. */
const VISIBILITY_POLL_MS = 500

/** Longest a hide waits on any one step of getting its freeze frame onto the
 *  screen. Both waits below are bounded by it because NOTHING may leave the
 *  hide unissued: frames do not arrive at all in a minimised window, and a
 *  hide that never happens leaves the page sitting over the overlay that
 *  asked for it, with keyboard focus never handed back. */
const FREEZE_PAINT_TIMEOUT_MS = 100

/** Resolve `work`, or give up after `FREEZE_PAINT_TIMEOUT_MS`. */
function bounded(work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
}

/**
 * Warm `url` up off screen, so the `<img>` that follows paints in the commit
 * it is added in rather than a few frames later. Best effort throughout — it
 * only makes the paint sooner, so an engine without `decode()`, a decode that
 * fails, and a decode that never settles are all simply "not warmed", never a
 * reason to skip the frame or to hold the hide up.
 */
async function decodeOffscreen(url: string): Promise<void> {
  if (typeof Image === "undefined") return
  try {
    const image = new Image()
    image.src = url
    if (typeof image.decode === "function") await bounded(image.decode())
  } catch {
    /* paint it cold */
  }
}

/** Resolve after the next paint — the second frame, since the first callback
 *  still runs before it. Bounded, so a window that paints nothing cannot
 *  strand the caller. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      resolve()
      return
    }
    const timer = setTimeout(resolve, FREEZE_PAINT_TIMEOUT_MS)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
}

function measure(el: HTMLElement): Bounds {
  const rect = el.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

function sameBounds(a: Bounds | null, b: Bounds): boolean {
  if (!a) return false
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  )
}

function elementVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true } as never)
  }
  return true
}

export interface NativeSurfaceHostProps {
  /** The backend's id of the surface (label-safe). */
  backendId: string
  /** Where the surface's state lives in the tab store: `browser:<backendId>`
   *  (the workspace tab id for a browser tab; a key of its own for a
   *  document guest hosted by a file tab). */
  storeKey: string
  /** Create the surface at these bounds; resolves to its first state. Keep
   *  the identity stable for the life of the mount (memoize it): a new
   *  identity only re-syncs, never re-creates. */
  create: (bounds: Bounds) => Promise<BrowserTabState>
  /** Tear the surface down when this host unmounts. A browser tab's surface
   *  belongs to its tab record and merely hides (the record outlives every
   *  host); a document guest belongs to the preview on screen and goes with
   *  it — the document comes back the same from disk. */
  destroyOnUnmount?: boolean
  /** Force-hide (e.g. while a DOM error page replaces the page). */
  hidden?: boolean
  className?: string
  /** Show a refused create as this host's one line of error text. Off when
   *  the caller shows it itself (from `useBrowserCreateOutcome`): a remote
   *  tab puts its placeholder back, with the reason, in the surface's place. */
  showCreateError?: boolean
  /** Shown in the slot while the create is on its way — worth saying when it
   *  takes a moment, as a remote tab's does (a tunnel to open, a probe). */
  pendingLabel?: string
}

/**
 * The placeholder a native webview is fitted to.
 *
 * The webview is a native view painted by the OS above the DOM at this
 * element's rect, so this component never renders page content itself. It
 * (1) creates the surface on first mount, (2) keeps the webview's bounds equal
 * to its own rect, and (3) hides the webview whenever the rect is not really
 * visible — the file column is CSS-hidden in conversation mode, an overlay
 * holds an occlusion lease, the tab is showing an error page — handing
 * keyboard focus back to the main webview first so the overlay gets Esc/Tab.
 */
export function NativeSurfaceHost({
  backendId,
  storeKey,
  create,
  destroyOnUnmount = false,
  hidden = false,
  className,
  showCreateError = true,
  pendingLabel,
}: NativeSurfaceHostProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const lastBoundsRef = useRef<Bounds | null>(null)
  const lastVisibleRef = useRef<boolean | null>(null)
  // Whichever host of this tab asked, the answer is every host's.
  const createOutcome = useBrowserCreateOutcome(storeKey)
  // The page's last frame, painted here while the surface is hidden under
  // an overlay (a data URL). Cleared once the surface is showing again — not
  // before, or the pane would flash blank between the two.
  const [frozen, setFrozen] = useState<string | null>(null)
  // Which hide a frame belongs to: one that lands after a later show or hide
  // is dropped rather than painted over the wrong state.
  const hideSeqRef = useRef(0)
  // The error page replacing the surface also replaces any frame: a frame
  // kept through an error would resurface, stale, when the error clears
  // under a still-open overlay. Adjusted during render on the prop change.
  const [wasHidden, setWasHidden] = useState(hidden)
  if (wasHidden !== hidden) {
    setWasHidden(hidden)
    if (hidden) setFrozen(null)
  }
  const occluded = useNativeSurfaceOccluded()
  const passiveOcclusion = useNativeSurfaceOcclusionPassive()
  const fallbackOverlay = useFallbackOverlayOpen()
  const view = useWorkspaceView()
  const route = useOptionalWorkbenchRoute()
  const besideRoute = useContext(NativeSurfaceBesideRoute)
  const routeVisible = besideRoute || (route ? route.isConversations : true)
  // The whole workspace surface is CSS-hidden under a full-page route.
  const hostHidden = useOverlayHostHidden()
  // Whether this tab has a page to leave a still of. A surface that has never
  // committed a document — just created, or still on its way to its first
  // page — has nothing to freeze, and hiding it would put an empty pane under
  // the toast that asked for it. A COMMITTED blank page is not one of those:
  // the empty tab's own page is a document like any other (the backend paints
  // it in the app's colours — see `browser::blank_page`), and so is the one a
  // popup's opener writes into. An overlay the user opened still gets its way
  // (they are looking at the overlay, not at the pane); a notice does not.
  const state = useBrowserTabState(storeKey)
  const showsDocument = state !== null && !state.error && !!state.url
  const noticeOnly = occluded && passiveOcclusion && !fallbackOverlay
  const occludedNow = occluded && (!noticeOnly || showsDocument)
  const onScreen = !hidden && routeVisible && !hostHidden
  const shouldShow = onScreen && !occludedNow && !fallbackOverlay
  // A page in its own window is not over this window's toast — it is not over
  // anything of ours at all — so a notice is no reason to take a whole window
  // off the screen. Overlays keep their say over it, as they always had.
  const windowShouldShow =
    onScreen && !(occluded && !noticeOnly) && !fallbackOverlay
  // Hidden ONLY because an overlay is open over it: the placeholder stays on
  // screen, so it is worth a freeze frame. The other reasons (error page,
  // full-page route, hidden column) take the placeholder off screen too.
  const overlayHide = onScreen && (occludedNow || fallbackOverlay)
  // A notice must not take the keyboard: the user did not ask for it, and
  // whatever they were typing into the page is still where they left it.
  // Everything else hands focus back so Esc and Tab reach the overlay.
  const handoffFocus = !noticeOnly

  // What this host last told the backend about visibility, kept in step with
  // the tab's count of hosts showing it (`markBrowserHostShowing`).
  const setLastVisible = useCallback(
    (next: boolean | null) => {
      const wasShowing = lastVisibleRef.current === true
      lastVisibleRef.current = next
      if (wasShowing !== (next === true)) {
        markBrowserHostShowing(storeKey, next === true)
      }
    },
    [storeKey]
  )

  // One pass: measure, push bounds if they moved, push visibility if it
  // flipped. Called from every signal that could change either.
  const sync = useCallback(() => {
    const el = ref.current
    if (!el) return
    // An owned window is not fitted to this element — the placeholder is
    // invisible by design — so only the "is this tab on screen" signals
    // apply, and there are no bounds to push.
    if (getBrowserTabState(storeKey)?.surface === "window") {
      if (lastVisibleRef.current !== windowShouldShow) {
        setLastVisible(windowShouldShow)
        // Another host still shows the tab: hiding it is not this one's call.
        if (!windowShouldShow && browserHostsShowing(storeKey) > 0) return
        void browserSetVisible(
          backendId,
          windowShouldShow,
          !windowShouldShow
        ).catch(() => {})
      }
      return
    }
    const bounds = measure(el)
    const visible =
      shouldShow && bounds.width > 0 && bounds.height > 0 && elementVisible(el)
    if (visible && !sameBounds(lastBoundsRef.current, bounds)) {
      lastBoundsRef.current = bounds
      void browserSetBounds(backendId, bounds).catch(() => {})
    }
    if (lastVisibleRef.current !== visible) {
      setLastVisible(visible)
      // Another host still shows the tab — the side panel over a full-page
      // route, while this one is the file column's, hidden under it: hiding
      // the page is not this one's call.
      if (!visible && browserHostsShowing(storeKey) > 0) return
      hideSeqRef.current += 1
      const seq = hideSeqRef.current
      if (visible) {
        // The frame goes once the native view is back — and only if this
        // show is still the latest request: an overlay closed and reopened
        // at once has a newer hide in flight, whose frame this answer must
        // not wipe from under it.
        void browserSetVisible(backendId, true, false)
          .catch(() => {})
          .finally(() => {
            if (hideSeqRef.current === seq) setFrozen(null)
          })
      } else if (
        !overlayHide ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        !elementVisible(el)
      ) {
        // Nothing worth a still: the placeholder is going off screen too.
        void browserSetVisible(backendId, false, handoffFocus, false).catch(
          () => {}
        )
      } else {
        void (async () => {
          // Paint the still UNDER the live native view, then hide. The view
          // covers the placeholder, so the frame costs nothing on screen
          // until the moment it is needed — and at that moment it is already
          // there. Hiding first and painting whatever the hide hands back
          // leaves the placeholder blank for a round trip, which is the
          // flash this whole mechanism exists to prevent.
          //
          // Every step re-checks the sequence: an overlay closed while this
          // was in flight has already shown the surface, and finishing the
          // hide would take the page away with nothing left over it.
          const frame = await browserFreezeFrame(backendId).catch(() => null)
          if (hideSeqRef.current !== seq) return
          if (frame) {
            const url = `data:${frame.mime};base64,${frame.data}`
            await decodeOffscreen(url)
            if (hideSeqRef.current !== seq) return
            setFrozen(url)
            await nextPaint()
            if (hideSeqRef.current !== seq) return
          }
          // The hide itself, asking for no frame of its own even when the one
          // above came back empty. `freeze_frame_core` captures under the
          // same conditions this would, so a second attempt answers the same
          // — except that if the first one came back empty by TIMING OUT, the
          // retry spends that budget again, and the page sits over the
          // just-opened overlay for twice as long as it ever did before.
          void browserSetVisible(backendId, false, handoffFocus, false).catch(
            () => {}
          )
        })()
      }
    }
  }, [
    backendId,
    handoffFocus,
    overlayHide,
    setLastVisible,
    shouldShow,
    storeKey,
    windowShouldShow,
  ])

  // Whether this tab currently has a live surface. Also the re-creation
  // signal: if the state goes away while this host is mounted — the tab was
  // released by the background unload just as the user switched to it — the
  // effect below runs again and loads the page instead of leaving a blank
  // pane behind.
  const loaded = state !== null

  // Create the surface once per tab record; adopted popups and re-mounts
  // already have one (the store knows about it). A record whose surface was
  // released (background unload) is "not loaded" again and gets a new one
  // here, at the URL the record was updated to.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (getBrowserTabState(storeKey)) {
      lastBoundsRef.current = null
      setLastVisible(null)
      sync()
      return
    }
    const token = claimSurfaceCreation(backendId)
    if (token === null) {
      sync()
      return
    }
    const bounds = measure(el)
    lastBoundsRef.current = bounds
    // The surface is created visible, at these bounds.
    setLastVisible(true)
    markBrowserCreatePending(storeKey)
    // Queued per tab id: a close issued for an earlier generation must reach
    // the backend before this create, never after it.
    runSurfaceOp(backendId, () => create(bounds))
      .then((next) => {
        if (!surfaceClaimIsCurrent(backendId, token)) {
          // Someone else claimed this id meanwhile: their own create is
          // already queued behind us, and closing here would land after it
          // and destroy THEIR surface. Only clean up when the id is
          // ownerless — the tab was closed while this was in flight.
          if (!hasSurfaceClaim(backendId)) {
            void runSurfaceOp(backendId, () => browserClose(backendId)).catch(
              () => {}
            )
          }
          return
        }
        // Seed, never overwrite. This answer was decided before the page had
        // begun to load, so it is the OLDEST state this tab will ever have —
        // and on WKWebView the answer to an `invoke` and the eval that
        // delivers an event are not ordered against each other (the same race
        // `TauriTransport.subscribe` works around), so a `browser://state`
        // for a page that has already committed can arrive first. Writing
        // this over it would put the tab back to `loading` with nothing left
        // to correct it: an empty tab's `about:blank` commits in
        // microseconds and then emits nothing ever again, which is exactly
        // the tab that used to spin for the rest of the session.
        if (!getBrowserTabState(storeKey)) setBrowserTabState(next)
        settleBrowserCreate(storeKey)
        // Nobody is showing the tab any more — its host went away while the
        // surface was being built, and the hide it sent on the way out found
        // no such tab yet. Hidden now, or it would stay painted over whatever
        // took its place. A host that is showing it syncs as usual.
        if (ref.current === null && browserHostsShowing(storeKey) === 0) {
          void browserSetVisible(backendId, false, false).catch(() => {})
          return
        }
        sync()
      })
      .catch((error: unknown) => {
        if (!surfaceClaimIsCurrent(backendId, token)) return
        forgetSurfaceCreation(backendId)
        settleBrowserCreate(storeKey, { error })
      })
    // Intentionally not re-run on `sync` identity changes: creation is a
    // one-shot per mount, the effect below handles every later sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendId, storeKey, create, loaded])

  // Geometry and visibility tracking for the life of the mount.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    schedule()
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null
    observer?.observe(el)
    window.addEventListener("resize", schedule)
    const poll = window.setInterval(sync, VISIBILITY_POLL_MS)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener("resize", schedule)
      window.clearInterval(poll)
    }
  }, [backendId, sync])

  // Layout-driven visibility flips (pane / mode / route) re-sync at once
  // instead of waiting for the poll.
  useEffect(() => {
    sync()
  }, [sync, view.mode, view.activePane, view.filesMaximized, routeVisible])

  // Something OTHER than this host moved the surface, so the bounds it last
  // pushed are no longer where the page is — and since the placeholder has
  // not moved, nothing it measures says so. Forget what was pushed and push
  // again. Raised when a web inspector closes: one that had been docked into
  // the window leaves the page filling it afterwards (see
  // `shim/macos.rs::prefer_detached_inspector`) with nothing in the layout
  // changing on the way back.
  const boundsResync = useBrowserBoundsResync(storeKey)
  const seenResyncRef = useRef(boundsResync)
  useEffect(() => {
    if (seenResyncRef.current === boundsResync) return
    seenResyncRef.current = boundsResync
    lastBoundsRef.current = null
    sync()
  }, [boundsResync, sync])

  // Mount = the tab is on screen; unmount = it is no longer (another tab took
  // the pane, the drawer closed, the panel went away). A browser tab's
  // surface hides, never dies — the record owns it, and the store keeps the
  // timestamps so the optional background unload knows how long a page has
  // been off screen. A document guest is torn down: it is the preview's, and
  // the preview is gone.
  useEffect(() => {
    markBrowserTabShown(storeKey)
    return () => {
      if (lastVisibleRef.current === true) {
        markBrowserHostShowing(storeKey, false)
      }
      lastVisibleRef.current = null
      hideSeqRef.current += 1
      markBrowserTabHidden(storeKey)
      if (destroyOnUnmount) {
        releaseBrowserTab(storeKey)
      } else if (browserHostsShowing(storeKey) === 0) {
        // Hidden only once no host shows the tab: another one still showing
        // it (the side panel and a pane at once) keeps it where it is.
        void browserSetVisible(backendId, false, false).catch(() => {})
      }
    }
  }, [backendId, destroyOnUnmount, storeKey])

  // Reaching for a page a notice is sitting on: a press or a wheel event only
  // reaches this element while the native view is hidden, so while THAT is
  // why it is hidden there is nothing else it can mean. The notice goes, the
  // lease with it, and the page is live again — at the cost of swallowing the
  // press that asked, which is what dismissing an overlay by clicking past it
  // costs everywhere else.
  const reclaim =
    noticeOnly && !shouldShow ? () => requestNativeSurfaceReclaim() : undefined

  return (
    // No inset: the page fills its slot to the edge, so nothing of the pane
    // behind it shows as a frame around it. A resize divider is a 1px box
    // whose line thickens to 5px CENTRED on it (`ui/resizable.tsx`), painting
    // (5-1)/2 = 2px into each neighbour — which a native view paints back
    // over, since it always paints above the DOM. So while a divider is
    // hovered or dragged its line reads 3px beside a page and 5px beside the
    // plain DOM above it. That is the whole cost, it lasts only as long as
    // the pointer is on the divider, and the resting 1px hairline — the state
    // it is in the rest of the time — covers its box exactly and never
    // overhung anything.
    <div
      ref={ref}
      data-browser-surface={backendId}
      onPointerDown={reclaim}
      onWheel={reclaim}
      className={cn(
        "relative h-full w-full min-h-0 min-w-0 bg-background",
        className
      )}
      aria-hidden
    >
      {frozen ? (
        // A data URL the backend just produced, shown for the life of an
        // overlay: nothing for next/image to optimise, load or cache.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frozen}
          alt=""
          draggable={false}
          data-browser-frozen-frame=""
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-left-top"
        />
      ) : null}
      {createOutcome?.kind === "failed" && showCreateError ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive">
          {String(createOutcome.error)}
        </div>
      ) : createOutcome?.kind === "pending" && pendingLabel ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {pendingLabel}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The surface host of a browser tab: the workspace tab record names the
 * backend id and the URL, and the surface is created with the preferences
 * read at that moment (a surface cannot change its inspector or its kind
 * after it exists, so a settings change applies to new tabs).
 */
export function BrowserSurfaceHost({
  tab,
  hidden = false,
  className,
  egress = null,
  showCreateError,
  pendingLabel,
}: {
  tab: BrowserWorkspaceTab
  /** Force-hide (e.g. while a DOM error page replaces the page). */
  hidden?: boolean
  className?: string
  /** The remote connection a remote tab's page goes through (see
   *  `browserOpenTab`); null for a tab of this computer. */
  egress?: number | null
  showCreateError?: boolean
  pendingLabel?: string
}) {
  const backendId = browserTabBackendId(tab.id)
  const initialUrl = tab.browser.initialUrl
  const profile = tab.browser.profile
  const folderId = tab.folderId
  const create = useCallback(
    (bounds: Bounds) => {
      const prefs = getBrowserPrefs()
      return browserOpenTab({
        tabId: backendId ?? "",
        url: initialUrl,
        bounds,
        folderId,
        surface: prefs.surfaceOverride,
        devtools: prefs.devtools,
        // The record is moved to the default profile when its own is
        // deleted; should a create run before that reaches this window, the
        // backend still must not recreate the deleted store.
        profile: browserProfileExists(prefs, profile)
          ? profile
          : DEFAULT_BROWSER_PROFILE_ID,
        egress,
      })
    },
    [backendId, egress, folderId, initialUrl, profile]
  )
  // A browser tab always has a backend id; anything else is not a browser
  // tab and gets no surface.
  if (!backendId) return null
  return (
    <NativeSurfaceHost
      backendId={backendId}
      storeKey={tab.id}
      create={create}
      hidden={hidden}
      className={className}
      showCreateError={showCreateError}
      pendingLabel={pendingLabel}
    />
  )
}

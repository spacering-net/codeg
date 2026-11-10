"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import { OverlayPortalContainerProvider } from "@/components/ui/overlay-portal-container"
import { attachRef } from "@/lib/attach-ref"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"
import { acquireNativeSurfaceOcclusion } from "@/lib/browser/native-surface-occlusion"

type DrawerContextProps = {
  hasSnapPoints: boolean
  modal: DrawerPrimitive.Root.Props["modal"]
  showSwipeHandle: boolean
  swipeDirection: NonNullable<DrawerPrimitive.Root.Props["swipeDirection"]>
  /** The popup's DOM is in (see `useDrawerLease`); the returned function is
   *  for when it goes. */
  attachPopup: (hostsPage: boolean) => () => void
}

const DrawerContext = React.createContext<DrawerContextProps | null>(null)

/**
 * How a drawer holding a built-in browser page gets the drawers it is stacked
 * on out of the way.
 *
 * Base UI stacks a drawer rendered anywhere under another one's root — inside
 * its content, or beside it, where the task detail sheet puts its transcript
 * drawer — in front of it, and fades the content of the one behind out. So the
 * page is in front of them too. But each of them still holds the lease that
 * hides native pages, and the page would never show: the transcript's browser
 * viewer over a transcript that is itself in a drawer (the task board's, the
 * canvas's, a session viewer's). Each drawer's root provides this to what it
 * renders; calling it lifts that drawer's lease, and every one below it, until
 * the returned function runs.
 */
const DrawerLeaseSuspension = React.createContext<(() => () => void) | null>(
  null
)

/**
 * One drawer's occlusion lease. A native browser surface would paint over the
 * drawer, so it holds one while its popup's DOM exists — unless it is the
 * drawer hosting such a surface (the transcript's browser viewer), which
 * instead lifts the leases of the drawers it is stacked on; or one of those is
 * stacked on it. Refs, not state: what the lease depends on changes in ref
 * callbacks, and the lease has to follow at once rather than a render later.
 */
function useDrawerLease() {
  const suspendBelow = React.useContext(DrawerLeaseSuspension)
  const leaseRef = React.useRef<(() => void) | null>(null)
  const holdingRef = React.useRef(false)
  const suspensionsRef = React.useRef(0)
  const syncLease = React.useCallback(() => {
    const hold = holdingRef.current && suspensionsRef.current === 0
    if (hold && !leaseRef.current) {
      leaseRef.current = acquireNativeSurfaceOcclusion("drawer")
    } else if (!hold && leaseRef.current) {
      leaseRef.current()
      leaseRef.current = null
    }
  }, [])
  const suspendLease = React.useCallback(() => {
    suspensionsRef.current += 1
    syncLease()
    const resumeBelow = suspendBelow?.()
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      suspensionsRef.current -= 1
      syncLease()
      resumeBelow?.()
    }
  }, [suspendBelow, syncLease])
  const attachPopup = React.useCallback(
    (hostsPage: boolean) => {
      holdingRef.current = !hostsPage
      syncLease()
      const resumeBelow = hostsPage ? suspendBelow?.() : undefined
      return () => {
        holdingRef.current = false
        syncLease()
        resumeBelow?.()
      }
    },
    [suspendBelow, syncLease]
  )
  return { attachPopup, suspendLease }
}

/**
 * The shape every side panel in the app shares: the task detail sheet and all
 * three session viewers.
 *
 * One constant rather than four copies because they STACK on each other — the
 * session viewer opens over the detail sheet, and a delegation viewer opens
 * over another one. Panels of differing widths in a stack read as a mistake:
 * the layer underneath juts out past the one on top on one side only. So the
 * width is not per-panel taste, it is a property of the stack, and there is
 * exactly one place to change it.
 *
 * `w-` and not just `max-w-`: the popup sizes itself from
 * `--drawer-content-width`, which the base classes set per swipe axis, so a
 * bare `max-w-` would have nothing to cap. tailwind-merge drops the base
 * `w-(--drawer-content-width,auto)` in favour of this one.
 */
const SIDE_PANEL_CONTENT_CLASS =
  "flex w-[calc(100%-1rem)] flex-col gap-0 p-0 sm:max-w-[36rem]"

function useDrawer() {
  const context = React.useContext(DrawerContext)

  if (!context) {
    throw new Error("useDrawer must be used within a Drawer.")
  }

  return context
}

/**
 * The closes that mean "something ambient dismissed the drawer" rather than
 * "the user asked for it". Only these are ever second-guessed below — a close
 * button, a swipe, a trigger press and an imperative close always go through.
 *
 * `escape-key` is the reason that matters for every drawer; the pointer ones
 * only reach here on a drawer that opted back into `disablePointerDismissal`
 * (upstream suppresses them entirely otherwise), which is why the guard below
 * covers all three rather than just Escape.
 */
const AMBIENT_DISMISS_REASONS: ReadonlySet<string> = new Set([
  "outside-press",
  "escape-key",
  "focus-out",
])

/**
 * Whether a modal Radix layer — a `Dialog`, an `AlertDialog`, a `Select`, a
 * `DropdownMenu` — is open anywhere on the page right now.
 *
 * Base UI and Radix keep separate dismissal stacks and neither one knows about
 * the other's layers. Base UI's own protection only reaches layers rendered
 * *inside* the drawer's React tree (it marks presses that pass through it as
 * `insideReactTree`), so a Radix layer rendered as a SIBLING of the drawer —
 * the task detail panel's diff `Dialog` and delete `AlertDialog` both are — is
 * invisible to it. A press inside one then reads as an outside press and takes
 * the drawer down with it, unmounting the very dialog being used. Escape is
 * worse still: Radix's layer stack routes it to the topmost layer only, but
 * Base UI never sees that stack, so one keypress closes both.
 *
 * Radix marks the situation for us. A layer with `disableOutsidePointerEvents`
 * writes `pointer-events: none` as an inline style on `body` for as long as it
 * is open, and restores it on unmount — the same signal
 * `useNestedLayerDismissGuard` reads for the Radix-on-Radix case. While it is
 * set, the drawer is not the layer the user is talking to.
 */
function radixModalLayerIsOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.body.style.pointerEvents === "none"
  )
}

/**
 * Escape cannot use the live reading above, because by the time it would run the
 * shield is already down.
 *
 * Radix listens for Escape on the document in the CAPTURE phase; Base UI listens
 * in the bubble phase. In between, Radix closes its layer and React — for which
 * a keydown is a discrete event — flushes that synchronously, unmounting the
 * layer and restoring `body`'s `pointer-events` before Base UI ever asks. (In
 * jsdom the flush is batched instead, so this is invisible to a component test;
 * it only shows up in a real engine.)
 *
 * So sample the shield in the capture phase too, ahead of Radix's own listener,
 * and hand that reading to the guard. The sample is keyed by the native event so
 * a stale one can never be mistaken for the current keypress.
 *
 * The listener is installed once for the whole app and refcounted across
 * drawers. Ordering holds because it is registered when a `Drawer` mounts, which
 * is always before a Radix layer inside or beside that drawer can open.
 */
let escapeProbeRefCount = 0
let lastEscape: { event: KeyboardEvent; shielded: boolean } | null = null

function sampleEscapeShield(event: KeyboardEvent) {
  if (event.key !== "Escape") {
    return
  }
  lastEscape = { event, shielded: radixModalLayerIsOpen() }
}

function useEscapeShieldProbe() {
  React.useEffect(() => {
    if (escapeProbeRefCount === 0) {
      document.addEventListener("keydown", sampleEscapeShield, true)
    }
    escapeProbeRefCount += 1
    return () => {
      escapeProbeRefCount -= 1
      if (escapeProbeRefCount === 0) {
        document.removeEventListener("keydown", sampleEscapeShield, true)
        lastEscape = null
      }
    }
  }, [])
}

/** Whether this close was really meant for a Radix layer sitting above us. */
function isShieldedDismissal(
  eventDetails: DrawerPrimitive.Root.ChangeEventDetails
): boolean {
  if (!AMBIENT_DISMISS_REASONS.has(eventDetails.reason)) {
    return false
  }
  if (eventDetails.reason === "escape-key") {
    return lastEscape?.event === eventDetails.event
      ? lastEscape.shielded
      : radixModalLayerIsOpen()
  }
  return radixModalLayerIsOpen()
}

function Drawer({
  // House style, and the reason this component exists: every drawer in the app
  // is non-modal. No backdrop, no scroll lock, no focus trap — the page behind
  // stays visible and interactive. Pass `modal` explicitly to opt a single
  // drawer back into the modal behaviour.
  modal = false,
  // The other half of that house style. Non-modal means the page behind stays
  // live, which also means EVERY press out there reads as an outside press —
  // a drawer opened to be consulted while working in the page could not
  // survive the first click, and Base UI additionally closes a non-modal
  // drawer on focus-out (`closeOnFocusOut: !disablePointerDismissal`). So
  // pointer dismissal is off by default; Escape, the close button, a swipe and
  // the trigger all still close (`escapeKey` is a separate switch upstream —
  // see `useDialogRoot`). Pass `disablePointerDismissal={false}` on a drawer
  // that genuinely wants press-outside-to-close, e.g. the mobile navigation
  // panels.
  disablePointerDismissal = true,
  onOpenChange,
  showSwipeHandle = false,
  snapPoints,
  swipeDirection = "down",
  ...props
}: DrawerPrimitive.Root.Props & {
  showSwipeHandle?: boolean
}) {
  const hasSnapPoints = snapPoints != null && snapPoints.length > 0
  const { attachPopup, suspendLease } = useDrawerLease()
  const contextValue = React.useMemo(
    () => ({
      hasSnapPoints,
      modal,
      showSwipeHandle,
      swipeDirection,
      attachPopup,
    }),
    [hasSnapPoints, modal, showSwipeHandle, swipeDirection, attachPopup]
  )

  useEscapeShieldProbe()

  const handleOpenChange = React.useCallback<
    NonNullable<DrawerPrimitive.Root.Props["onOpenChange"]>
  >(
    (nextOpen, eventDetails) => {
      // `cancel()` is read by the store before it dispatches the state change,
      // so the drawer stays open and the caller never hears about it.
      if (!nextOpen && isShieldedDismissal(eventDetails)) {
        eventDetails.cancel()
        return
      }
      onOpenChange?.(nextOpen, eventDetails)
    },
    [onOpenChange]
  )

  return (
    <DrawerContext.Provider value={contextValue}>
      <DrawerLeaseSuspension.Provider value={suspendLease}>
        <DrawerPrimitive.Root
          data-slot="drawer"
          modal={modal}
          disablePointerDismissal={disablePointerDismissal}
          onOpenChange={handleOpenChange}
          snapPoints={snapPoints}
          swipeDirection={swipeDirection}
          {...props}
        />
      </DrawerLeaseSuspension.Provider>
    </DrawerContext.Provider>
  )
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 min-h-dvh bg-black/80 opacity-[max(var(--drawer-overlay-min-opacity,0),calc(1-var(--drawer-swipe-progress)))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] select-none data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-snap-points:[--drawer-overlay-min-opacity:0.5] data-starting-style:opacity-0 data-swiping:duration-0 supports-backdrop-filter:backdrop-blur-xs supports-[-webkit-touch-callout:none]:absolute",
        className
      )}
      {...props}
    />
  )
}

function DrawerSwipeHandle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-swipe-handle"
      aria-hidden="true"
      className={cn(
        "relative z-10 flex shrink-0 cursor-grab transition-opacity duration-200 group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-[swipe-axis=x]/drawer-popup:h-full group-data-[swipe-axis=x]/drawer-popup:w-3 group-data-[swipe-axis=x]/drawer-popup:items-center group-data-[swipe-axis=y]/drawer-popup:h-3 group-data-[swipe-axis=y]/drawer-popup:w-full group-data-[swipe-axis=y]/drawer-popup:justify-center group-data-[swipe-direction=down]/drawer-popup:items-end group-data-[swipe-direction=left]/drawer-popup:order-last group-data-[swipe-direction=left]/drawer-popup:justify-start group-data-[swipe-direction=right]/drawer-popup:justify-end group-data-[swipe-direction=up]/drawer-popup:order-last group-data-[swipe-direction=up]/drawer-popup:items-start after:block after:shrink-0 after:rounded-full after:bg-muted group-data-[swipe-axis=x]/drawer-popup:after:h-[6.25rem] group-data-[swipe-axis=x]/drawer-popup:after:w-1.5 group-data-[swipe-axis=y]/drawer-popup:after:h-1.5 group-data-[swipe-axis=y]/drawer-popup:after:w-[6.25rem] active:cursor-grabbing",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  closeButtonClassName,
  showCloseButton = true,
  nativeSurfaceHost = false,
  ref,
  ...props
}: DrawerPrimitive.Popup.Props & {
  closeButtonClassName?: string
  showCloseButton?: boolean
  /** This drawer CONTAINS a built-in browser surface (the transcript's
   *  browser viewer): it must not take the lease that would hide it, and the
   *  drawers it is stacked on give theirs up while it is open. */
  nativeSurfaceHost?: boolean
}) {
  const { hasSnapPoints, modal, showSwipeHandle, swipeDirection, attachPopup } =
    useDrawer()
  const swipeAxis =
    swipeDirection === "down" || swipeDirection === "up" ? "y" : "x"
  // The host surface this drawer was opened from is hidden-but-mounted (the
  // workbench does that to the conversation surface when a full-page route
  // takes over). We portal to the body, so nothing the host did to its own
  // subtree reaches us — see `overlay-host-hidden.tsx`.
  const hostHidden = useOverlayHostHidden()
  const [popup, setPopup] = React.useState<HTMLDivElement | null>(null)
  // Own cleanup, not a bare `ref(node)` passthrough: React 19 runs a callback
  // ref's returned cleanup INSTEAD of re-invoking it with `null`, so handing the
  // caller's cleanup straight back would drop our own `setPopup(null)` and leave
  // the portal host pointing at a detached node.
  const setPopupRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setPopup(node)
      const detach = attachRef(ref, node)
      // The drawer's occlusion lease follows the popup's DOM.
      const detachLease = node ? attachPopup(nativeSurfaceHost) : undefined
      return () => {
        detachLease?.()
        setPopup(null)
        detach()
      }
    },
    [ref, nativeSurfaceHost, attachPopup]
  )

  return (
    <DrawerPortal data-slot="drawer-portal">
      {modal === true && (
        <DrawerOverlay
          data-snap-points={hasSnapPoints ? "" : undefined}
          className={
            hostHidden ? "conversation-tab-hidden invisible" : undefined
          }
        />
      )}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        data-modal={modal}
        // Borrowed wholesale from what the host does to its own subtree:
        // `invisible` (visibility, not display — the popup keeps its layout,
        // measured height and scroll position, so switching back restores it
        // untouched), `conversation-tab-hidden` to harden that against
        // descendants declaring their own `visibility: visible`, and `inert`
        // to take it out of the tab order and stop it swallowing clicks meant
        // for the route on top. Deliberately NOT a close: the surface behind
        // it is being preserved too.
        inert={hostHidden || undefined}
        className={cn(
          "pointer-events-none fixed inset-0 z-50 select-none data-[modal=true]:pointer-events-auto",
          hostHidden && "conversation-tab-hidden invisible"
        )}
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-popup"
          data-swipe-axis={swipeAxis}
          data-snap-points={hasSnapPoints ? "" : undefined}
          ref={setPopupRef}
          className={cn(
            // Base. Upstream draws its edge with `border-popover` (plus
            // `dark:border-border`), which is invisible in light mode — there
            // `--popover` and `--background` are both pure white. That is fine
            // for a modal drawer, whose backdrop dims the page behind it, but
            // every drawer here is non-modal: with nothing dimmed and no edge,
            // the panel dissolves into the page. So it gets the elevation the
            // repo's other floating surfaces use — `shadow-2xl ring-1` (see
            // `dialog.tsx` / `popover.tsx`) — instead of the border.
            "group/drawer-popup pointer-events-auto fixed z-50 m-(--drawer-inset,0px) flex h-(--drawer-content-height) max-h-(--drawer-content-max-height,none) min-h-0 w-(--drawer-content-width,auto) transform-[translate3d(var(--translate-x,0px),var(--translate-y,0px),0)_scale(var(--stack-scale))] flex-col rounded-4xl bg-popover text-sm text-popover-foreground shadow-2xl ring-1 ring-border transition-[transform,height,opacity,filter] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform outline-none select-none [--drawer-bleed-background:transparent] [--drawer-inset:--spacing(2)] [interpolate-size:allow-keywords]",
            // Nested.
            "data-nested-drawer-open:overflow-hidden data-nested-drawer-open:brightness-95",
            // Bleed.
            "after:pointer-events-none after:absolute after:bg-(--drawer-bleed-background,var(--color-popover)) data-[swipe-axis=x]:after:inset-y-0 data-[swipe-axis=x]:after:w-(--bleed) data-[swipe-axis=y]:after:inset-x-0 data-[swipe-axis=y]:after:h-(--bleed) data-[swipe-direction=down]:after:top-full data-[swipe-direction=left]:after:right-full data-[swipe-direction=right]:after:left-full data-[swipe-direction=up]:after:bottom-full",
            // Sizing.
            "[--drawer-content-height:var(--drawer-height,auto)] data-[swipe-axis=x]:[--drawer-content-width:75%] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-6rem)] data-[swipe-axis=y]:data-snap-points:[--drawer-content-height:100dvh] data-[swipe-axis=x]:sm:[--drawer-content-width:24rem]",
            // Stack.
            "[--bleed:3rem] [--peek:1rem] [--stack-height:var(--drawer-frontmost-height,var(--drawer-height,0px))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-scale-base:max(0,calc(1-(var(--nested-drawers)*var(--stack-step))))] [--stack-scale:clamp(0,calc(var(--stack-scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--stack-shrink:calc(1-var(--stack-scale))] [--stack-step:0.05]",
            // Transitions.
            "data-ending-style:transform-(--closed-transform) data-ending-style:opacity-[0.9999] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-nested-drawer-swiping:duration-0 data-ending-style:data-nested-drawer-swiping:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-starting-style:transform-(--closed-transform) data-swiping:duration-0 data-ending-style:data-swiping:duration-[calc(var(--drawer-swipe-strength)*400ms)]",
            // Axis: y.
            "data-[swipe-axis=y]:inset-x-0 data-[swipe-axis=y]:data-nested-drawer-open:h-(--stack-height)",
            // Axis: x.
            "data-[swipe-axis=x]:inset-y-0 data-[swipe-axis=x]:flex-row",
            // Direction: down.
            "data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:origin-bottom data-[swipe-direction=down]:[--closed-transform:translate3d(0,calc(100%+var(--drawer-inset,0px)+2px),0)] data-[swipe-direction=down]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-(var(--stack-shrink)*var(--stack-height)))]",
            // Direction: up.
            "data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:origin-top data-[swipe-direction=up]:[--closed-transform:translate3d(0,calc(-100%-var(--drawer-inset,0px)-2px),0)] data-[swipe-direction=up]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)+var(--stack-peek-offset)+(var(--stack-shrink)*var(--stack-height)))]",
            // Direction: left.
            "data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:origin-left data-[swipe-direction=left]:[--closed-transform:translate3d(calc(-100%-var(--drawer-inset,0px)-2px),0,0)] data-[swipe-direction=left]:[--translate-x:calc(var(--drawer-swipe-movement-x)+var(--stack-peek-offset)+(var(--stack-shrink)*100%))]",
            // Direction: right.
            "data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:origin-right data-[swipe-direction=right]:[--closed-transform:translate3d(calc(100%+var(--drawer-inset,0px)+2px),0,0)] data-[swipe-direction=right]:[--translate-x:calc(var(--drawer-swipe-movement-x)-var(--stack-peek-offset)-(var(--stack-shrink)*100%))]",
            className
          )}
          {...props}
        >
          {showSwipeHandle && <DrawerSwipeHandle />}
          <DrawerPrimitive.Content
            data-slot="drawer-content"
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain rounded-[inherit] transition-opacity duration-300 ease-[cubic-bezier(0.45,1.005,0,1.005)] select-text group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-swiping/drawer-popup:select-none"
            )}
          >
            {/* Nested layers portal into the popup rather than the body, so a
                press inside one is DOM-contained by the drawer. It has to be
                the popup and not the content: the popup carries a `transform`,
                which makes it the containing block for `fixed` descendants, and
                the content sits in between with `overflow-hidden` — portalling
                there would clip them. */}
            <OverlayPortalContainerProvider container={popup}>
              {children}
            </OverlayPortalContainerProvider>
            {showCloseButton && (
              <DrawerPrimitive.Close
                data-slot="drawer-close"
                className={cn("absolute top-4 right-4", closeButtonClassName)}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </DrawerPrimitive.Close>
            )}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex shrink-0 flex-col gap-0.5 p-4 pb-0 group-data-[swipe-axis=y]/drawer-popup:text-center md:gap-1.5 md:text-left",
        className
      )}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex shrink-0 flex-col gap-2 p-4 pt-0", className)}
      {...props}
    />
  )
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-balance text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  SIDE_PANEL_CONTENT_CLASS,
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerSwipeHandle,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}

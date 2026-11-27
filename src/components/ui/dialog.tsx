"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars"

import { Button } from "@/components/ui/button"
import { SKIP_FLOW_DIRECTION_CHECK } from "@/components/ui/scroll-area"
import { OverlayPortalContainerProvider } from "@/components/ui/overlay-portal-container"
import { useNestedLayerDismissGuard } from "@/hooks/use-nested-layer-dismiss-guard"
import { cn } from "@/lib/utils"
import { acquireNativeSurfaceOcclusionFor } from "@/lib/browser/native-surface-occlusion"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50",
        className
      )}
      {...props}
    />
  )
}

const CONTENT_SCROLLBARS = {
  theme: "os-theme-codeg",
  autoHide: "leave",
  clickScroll: true,
} satisfies PartialOptions["scrollbars"]

const scrolls = (overflow: string) =>
  overflow === "auto" || overflow === "scroll"

/** A wheel line or page in pixels, as the browser would scroll it. */
function wheelScale(event: WheelEvent, viewport: HTMLElement) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return viewport.clientHeight
  }
  return 1
}

/**
 * Gives a dialog that scrolls itself the conversation list's overlay scrollbar
 * (`os-theme-codeg`) instead of the platform's boxy one, which the rounded
 * corners also cut into.
 *
 * The content element is the viewport itself, so OverlayScrollbars wraps
 * nothing: each dialog keeps its own padding and layout (a grid or a flex
 * box, as it sets them). The bars go in `rail` — a `position: fixed` child
 * laid over the content's box — not in the content: anything absolutely
 * placed inside a scroller scrolls with it, and the library would put the
 * bars back from a scroll listener, a frame behind the compositor, so they
 * jumped about while scrolling. The rail moves only when the box resizes or
 * re-centres. Being the content's child, it still counts as inside for the
 * hover that shows the bars, the outside-press check and the scroll lock.
 *
 * A dialog that made itself `overflow-hidden` to scroll an inner part is left
 * alone: the viewport's overflow would override its own. Sideways, each keeps
 * what it had — `overflow-y-auto` lets a too-wide row scroll sideways too.
 */
function attachOverlayScrollbars(node: HTMLElement): (() => void) | null {
  const style = getComputedStyle(node)
  if (!scrolls(style.overflowY)) return null
  const x = scrolls(style.overflowX) ? "scroll" : "hidden"
  const rail = node.querySelector<HTMLElement>(
    ':scope > [data-slot="dialog-scrollbar-rail"]'
  )
  if (!rail || typeof ResizeObserver === "undefined") return null
  const placeRail = () => {
    const parent = node.offsetParent
    if (!parent) return
    // Offsets, not the box's client rect: they ignore the open animation's
    // scale, so the rail lands where the box settles.
    const origin = parent.getBoundingClientRect()
    rail.style.left = `${origin.left + node.offsetLeft}px`
    rail.style.top = `${origin.top + node.offsetTop}px`
    rail.style.width = `${node.offsetWidth}px`
    rail.style.height = `${node.offsetHeight}px`
  }
  let instance: OverlayScrollbars
  try {
    instance = OverlayScrollbars(
      {
        target: node,
        elements: { viewport: node },
        scrollbars: { slot: rail },
      },
      {
        scrollbars: CONTENT_SCROLLBARS,
        overflow: { x, y: "scroll" },
        ...(x === "hidden" ? { update: SKIP_FLOW_DIRECTION_CHECK } : {}),
      }
    )
  } catch {
    // No layout to measure (a test): the content scrolls natively.
    return null
  }
  placeRail()
  // The box re-centres when it resizes or the window does (its positioned
  // parent fills the window).
  const observer = new ResizeObserver(placeRail)
  observer.observe(node)
  if (node.offsetParent) observer.observe(node.offsetParent)
  // The library cancels a wheel over its bar and hands it on only to a host
  // that is the bar's parent; the rail is in between, so it is handed on
  // here, where the cancelled event bubbles to. (A fixed box's native wheel
  // would not reach the content anyway: it chains to the window.)
  const forwardWheel = (event: WheelEvent) => {
    const scale = wheelScale(event, node)
    node.scrollBy({
      left: x === "scroll" ? event.deltaX * scale : 0,
      top: event.deltaY * scale,
    })
  }
  rail.addEventListener("wheel", forwardWheel, { passive: true })
  return () => {
    rail.removeEventListener("wheel", forwardWheel)
    observer.disconnect()
    instance.destroy()
  }
}

function DialogContent({
  className,
  children,
  closeButtonClassName,
  showCloseButton = true,
  ref,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  closeButtonClassName?: string
  showCloseButton?: boolean
}) {
  // Without this, closing a nested Select/DropdownMenu by clicking elsewhere in
  // the dialog closes the dialog too.
  const {
    node,
    setNode,
    onPointerDownOutside: guardOutsidePress,
  } = useNestedLayerDismissGuard<HTMLDivElement>(ref)
  // A native browser surface would paint over this overlay, so it holds an
  // occlusion lease exactly while its DOM exists (this component stays mounted
  // with the dialog closed; only the primitive's content comes and goes).
  const contentRef = React.useCallback(
    (contentNode: HTMLDivElement | null) => {
      const detach = setNode(contentNode)
      const release = acquireNativeSurfaceOcclusionFor("dialog", true)
      const detachScrollbars = contentNode
        ? attachOverlayScrollbars(contentNode)
        : null
      return () => {
        detachScrollbars?.()
        release()
        if (typeof detach === "function") detach()
      }
    },
    [setNode]
  )
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          ref={contentRef}
          onPointerDownOutside={(event) => {
            onPointerDownOutside?.(event)
            guardOutsidePress(event)
          }}
          className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-background ring-border pointer-events-auto relative grid grid-cols-[minmax(0,1fr)] max-h-[calc(100dvh-2rem)] w-full max-w-md gap-6 overflow-y-auto rounded-4xl p-6 shadow-2xl ring-1 duration-100 outline-none",
            showCloseButton && "[&_[data-slot=dialog-header]]:pr-10",
            className
          )}
          {...props}
        >
          {/* Nested layers portal in here rather than to the body, so the
              scroll lock lets the wheel through to them. */}
          <OverlayPortalContainerProvider container={node}>
            {children}
          </OverlayPortalContainerProvider>
          {showCloseButton && (
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "absolute top-4 right-4 hover:text-destructive focus-visible:text-destructive",
                  closeButtonClassName
                )}
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          )}
          <div
            data-slot="dialog-scrollbar-rail"
            aria-hidden
            className="pointer-events-none fixed z-40"
          />
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("grid gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}

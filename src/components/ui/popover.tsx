"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { useOverlayPortalContainer } from "@/components/ui/overlay-portal-container"
import { useNestedLayerDismissGuard } from "@/hooks/use-nested-layer-dismiss-guard"
import { detectEnvironment } from "@/lib/transport/detect"
import { cn } from "@/lib/utils"
import { isWindowDragPress } from "@/lib/window-drag-region"

/** Closes the popover from its content: for the press Radix never hears
 *  the end of (see `PopoverContent`). */
const PopoverDismissContext = React.createContext<(() => void) | null>(null)

function Popover({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  // Its open state kept here, controlled or not, so the content can close
  // it as Radix itself would.
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : ownOpen
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next === open) return
      if (!controlled) setOwnOpen(next)
      onOpenChange?.(next)
    },
    [open, controlled, onOpenChange]
  )
  const dismiss = React.useCallback(() => setOpen(false), [setOpen])
  return (
    <PopoverDismissContext value={dismiss}>
      <PopoverPrimitive.Root
        data-slot="popover"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </PopoverDismissContext>
  )
}

/**
 * On the desktop, a press on a window-drag region outside the popover —
 * the blank of a top band — closes it as a press anywhere else does. Radix
 * closes a popover on the click that follows an outside press, and that
 * click never comes there: Tauri stops the press's `mousedown` and starts
 * the native window drag, which swallows the mouse-up. Not while a layer
 * over it (a menu opened from it) has the press: Radix leaves it open then.
 */
function useDismissOnWindowDrag(
  node: HTMLElement | null,
  dismiss: (() => void) | null
) {
  React.useEffect(() => {
    if (!node || !dismiss || detectEnvironment() !== "tauri") return
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (event.target instanceof Node && node.contains(event.target)) return
      if (node.style.pointerEvents === "none") return
      if (isWindowDragPress(event.composedPath())) dismiss()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true)
  }, [node, dismiss])
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ref,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Without this, closing a nested Select/DropdownMenu by clicking elsewhere in
  // the popover closes the popover too.
  const {
    node,
    setNode,
    onPointerDownOutside: guardOutsidePress,
  } = useNestedLayerDismissGuard<HTMLDivElement>(ref)
  useDismissOnWindowDrag(node, React.useContext(PopoverDismissContext))
  // Inside a modal Dialog this is the dialog's own content element, so the
  // content lands inside the scroll lock's whitelisted subtree and a wheel over
  // a long list actually scrolls it; inside a Drawer it is the drawer's popup.
  // `null` elsewhere = portal to the body.
  const container = useOverlayPortalContainer()
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        ref={setNode}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event)
          guardOutsidePress(event)
        }}
        className={cn(
          "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/5 flex flex-col gap-4 rounded-2xl p-4 text-sm shadow-2xl ring-1 duration-100 z-50 w-72 origin-(--radix-popover-content-transform-origin) outline-hidden",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("text-base font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}

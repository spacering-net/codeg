"use client"

import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { useOverlayPortalContainer } from "@/components/ui/overlay-portal-container"
import { cn } from "@/lib/utils"

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  )
}

function HoverCardContent({
  className,
  align = "start",
  side = "right",
  sideOffset = 8,
  collisionPadding = 12,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  // Same host as `Popover` uses — the dialog/drawer content when nested inside
  // one, the body otherwise. See `overlay-portal-container.tsx`.
  const container = useOverlayPortalContainer()
  // No `useNestedLayerDismissGuard` here (unlike `PopoverContent`): a hover card
  // holds read-only content with no nested Select/DropdownMenu to close, and it
  // is dismissed by the pointer leaving rather than by an outside press.
  return (
    <HoverCardPrimitive.Portal container={container ?? undefined}>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          // Surface + animation copied from `PopoverContent` so every floating
          // panel in the app reads as one family; only the padding is tighter
          // (this is an informational bubble, not a form).
          //
          // `max-h` + `overflow-y-auto` matter here: collision handling can
          // flip and shift the bubble but never shrinks it, so on a short window
          // a tall bubble would otherwise run off the bottom edge. `overflow-x`
          // is pinned hidden rather than left at `visible` — CSS promotes the
          // other axis to `auto` once one is, which would put a stray horizontal
          // scrollbar under content that merely wraps. Same pairing as
          // `SelectContent` / `DropdownMenuContent`.
          "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/5 rounded-2xl p-3 text-sm shadow-2xl ring-1 duration-100 z-50 w-72 max-h-(--radix-hover-card-content-available-height) origin-(--radix-hover-card-content-transform-origin) overflow-x-hidden overflow-y-auto outline-hidden",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }

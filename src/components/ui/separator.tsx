"use client"

import * as React from "react"
import { Separator as SeparatorPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        // Spelled out as `data-[orientation=…]`, not the `data-vertical:`
        // shorthand: that shorthand compiles to `[data-vertical]`, a BOOLEAN
        // attribute Radix never sets — it emits `data-orientation="vertical"`.
        // With the shorthand the rules matched nothing, so a separator got
        // neither its hairline width nor its height and rendered as a
        // zero-sized invisible box.
        //
        // Sizing via `h-full`/`w-full` rather than `self-stretch` leaves
        // `align-self` alone, so a caller that gives an explicit height (a
        // vertical rule between toolbar controls, say) still centres in the
        // row it sits in. `self-stretch` would pin it to the top instead.
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }

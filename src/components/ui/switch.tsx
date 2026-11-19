import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  /** `sm`: a row's own control, the height of a line of small text. */
  size?: "default" | "sm"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer inline-flex shrink-0 items-center rounded-full border border-transparent bg-muted-foreground/30 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=unchecked]:translate-x-0.5 rtl:data-[state=unchecked]:-translate-x-0.5",
          size === "sm"
            ? "size-3 data-[state=checked]:translate-x-3 rtl:data-[state=checked]:-translate-x-3"
            : "size-4 data-[state=checked]:translate-x-4 rtl:data-[state=checked]:-translate-x-4"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }

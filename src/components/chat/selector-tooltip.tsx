"use client"

import { cloneElement, useState, type ReactElement } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SelectorTooltipProps {
  /** The setting's name — "Model", "Mode", the config option's label. Nullable
   *  so a caller can drop the hint for the state where the chip already says it
   *  (a selected agent pill, a config row with a visible label) by passing
   *  `null` rather than branching around the whole element. */
  label?: string | null
  /** The blurb for the setting, when there is one. */
  description?: string | null
  /**
   * Force the hint closed while the selector's own popup is open. Only needed
   * for `Popover`-based selectors: a Radix `Popover` is non-modal, so the
   * trigger keeps receiving pointer events underneath its own panel and the
   * hint would crawl out from behind it. `DropdownMenu` (modal) and `Select`
   * (`disableOutsidePointerEvents`) both make the trigger unhoverable while
   * open, so those callers pass nothing.
   */
  suppressed?: boolean
  /**
   * The trigger is a disabled control — pass the same flag the trigger gets.
   * A disabled element dispatches no pointer events, so Radix can never open;
   * the browser's native `title`, which DOES show on a disabled control, is the
   * only mechanism left. Without this the hint silently vanishes exactly where
   * it is most needed (an unavailable agent pill is icon-only; a pinned folder
   * field can't be opened to inspect).
   */
  disabled?: boolean
  /** The trigger. Rendered `asChild`, so no wrapper element is introduced. */
  children: ReactElement<{ title?: string }>
}

/**
 * The hover hint on a selector chip (the agent settings chip, the agent pill,
 * the folder field), replacing the native `title`. Shared by the chat
 * composer, the automation editor and the task editor.
 *
 * Says what the chip IS, not what it currently holds — the value is already the
 * chip's own text, so repeating it here would just be a second copy under the
 * cursor.
 *
 * Hover-only, deliberately: Radix opens a tooltip on focus too, and every one
 * of these triggers hands focus BACK to itself when its menu closes — so
 * picking a model would leave a hint stranded over the composer. `onFocus`'s
 * `preventDefault()` suppresses that (Radix composes trigger handlers with
 * `checkForDefaultPrevented`, so a prevented event skips its internal open).
 * Nothing is lost for keyboard/AT users' orientation: every trigger keeps its
 * `aria-label`. (A `description` is mouse-only, which is why it carries colour,
 * not meaning.)
 *
 * ⚠️ Do NOT style a wrapped trigger on `data-[state=open]`. `TooltipTrigger`
 * sets its own `data-state` and spreads incoming props after it, so the tooltip
 * state lands on the DOM node and shadows the menu/popover trigger's. Drive
 * such styling from the React state that already owns the popup.
 *
 * The rendered tree shape is deliberately constant — the hint is switched off
 * by gating `open`, never by returning `children` bare. Swapping between the
 * two shapes remounts the trigger, and a pill that gains/loses its hint on
 * click (the agent selector) would drop keyboard focus mid-interaction.
 */
export function SelectorTooltip({
  label,
  description,
  suppressed = false,
  disabled = false,
  children,
}: SelectorTooltipProps) {
  const [open, setOpen] = useState(false)
  const hasHint = Boolean(label || description)
  const canShow = hasHint && !suppressed && !disabled
  // Drop a hint we can no longer honour, in render (React's documented
  // adjust-state-during-render pattern; it re-renders before committing).
  // Without this, an open hint whose trigger goes disabled/suppressed leaves
  // `open` latched: the controlled value is already pinned false, so Radix's
  // own close is de-duped away and never reaches us — and a disabled element
  // doesn't even emit the pointer-leave that would have triggered it. The
  // bubble would then reappear, unhovered, the moment the trigger came back.
  if (open && !canShow) setOpen(false)
  // `cloneElement` rather than a branch: same element type in, same element
  // type out, so the constant-tree invariant above still holds.
  const trigger = disabled
    ? cloneElement(children, {
        title: [label, description].filter(Boolean).join(" · ") || undefined,
      })
    : children
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip
        open={open && canShow}
        // Never bank an `open` we can't honour — the other half of the guard
        // above, for a request that arrives WHILE the trigger is suppressed or
        // disabled (a Popover is non-modal, so its trigger still takes hover).
        onOpenChange={(next) => setOpen(next && canShow)}
      >
        <TooltipTrigger asChild onFocus={(event) => event.preventDefault()}>
          {trigger}
        </TooltipTrigger>
        {hasHint ? (
          <TooltipContent side="top" className="max-w-64">
            {label ? (
              <div className={description ? "font-medium" : undefined}>
                {label}
              </div>
            ) : null}
            {description ? (
              <div className="break-words text-background/70">
                {description}
              </div>
            ) : null}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  )
}

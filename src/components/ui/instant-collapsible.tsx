"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { flushSync } from "react-dom"
import { useControllableState } from "@radix-ui/react-use-controllable-state"

// Drop-in replacement for ui/collapsible (Radix) used on the message hot
// path. Radix's Collapsible measures its content on every open-on-mount
// (disable animation → getBoundingClientRect → restore), which turns a
// history conversation full of expanded cards into a write-read-write forced
// layout storm inside one React commit — and nothing here ever consumed the
// measured --radix-collapsible-content-height. This version keeps the same
// component API, data attributes, and unmount-when-closed contract (with
// animate-out classes still playing via a lightweight exit presence) but
// never reads layout.

interface InstantCollapsibleContextValue {
  open: boolean
  disabled: boolean
  contentId: string
  onOpenToggle: () => void
}

const InstantCollapsibleContext =
  createContext<InstantCollapsibleContextValue | null>(null)

function useInstantCollapsible(component: string) {
  const context = useContext(InstantCollapsibleContext)
  if (!context) {
    throw new Error(`${component} must be used within Collapsible`)
  }
  return context
}

type CollapsibleProps = ComponentProps<"div"> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}

function Collapsible({
  open: openProp,
  defaultOpen,
  onOpenChange,
  disabled = false,
  children,
  ...props
}: CollapsibleProps) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: "Collapsible",
  })
  const contentId = useId()
  const onOpenToggle = useCallback(() => setOpen((prev) => !prev), [setOpen])
  const contextValue = useMemo(
    () => ({ open, disabled, contentId, onOpenToggle }),
    [open, disabled, contentId, onOpenToggle]
  )

  return (
    <div
      data-slot="collapsible"
      data-state={open ? "open" : "closed"}
      data-disabled={disabled ? "" : undefined}
      {...props}
    >
      <InstantCollapsibleContext.Provider value={contextValue}>
        {children}
      </InstantCollapsibleContext.Provider>
    </div>
  )
}

function CollapsibleTrigger({
  disabled,
  onClick,
  ...props
}: ComponentProps<"button">) {
  const context = useInstantCollapsible("CollapsibleTrigger")
  const isDisabled = disabled || context.disabled

  return (
    <button
      type="button"
      data-slot="collapsible-trigger"
      data-state={context.open ? "open" : "closed"}
      data-disabled={isDisabled ? "" : undefined}
      aria-controls={context.contentId}
      aria-expanded={context.open}
      disabled={isDisabled}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || isDisabled) return
        context.onOpenToggle()
      }}
    />
  )
}

function parseCssTimeListMs(value: string): number[] {
  return value.split(",").map((part) => {
    const trimmed = part.trim()
    if (!trimmed) return 0
    const num = Number.parseFloat(trimmed)
    if (Number.isNaN(num)) return 0
    return trimmed.endsWith("ms") ? num : num * 1000
  })
}

// Upper bound for the exit animation, in case animationend/animationcancel
// never fire (e.g. the node loses rendering mid-animation).
function exitTimeoutMs(styles: CSSStyleDeclaration): number {
  const durations = parseCssTimeListMs(styles.animationDuration || "0s")
  const delays = parseCssTimeListMs(styles.animationDelay || "0s")
  const longest = durations.reduce(
    (max, duration, index) =>
      Math.max(max, duration + (delays[index] ?? delays[0] ?? 0)),
    0
  )
  return longest + 100
}

function CollapsibleContent({ children, ...props }: ComponentProps<"div">) {
  const context = useInstantCollapsible("CollapsibleContent")
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const [present, setPresent] = useState(context.open)
  if (context.open && !present) {
    // Render-phase sync so opening mounts the content in this same pass.
    setPresent(true)
  }

  const open = context.open
  useEffect(() => {
    if (open) return
    const node = nodeRef.current
    // Already unmounted (was never open) — nothing to animate out.
    if (!node) return
    // data-state="closed" is committed at this point, so animate-out styles
    // are active. No exit animation (incl. jsdom, where animationName is "")
    // → unmount synchronously, matching Radix Presence.
    const styles = getComputedStyle(node)
    const animationName = styles.animationName
    if (!animationName || animationName === "none") {
      // Presence requires a post-commit DOM check; without an exit animation
      // the unmount must land in the same flush as the close (tests and
      // Radix Presence both rely on synchronous removal).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPresent(false)
      return
    }
    // tw-animate-css's `animate-out` defaults to `animation-fill-mode: none`,
    // so the moment the exit finishes the content snaps back to its resting
    // style (opacity 1, no slide) — and the unmount below lands in a later
    // task, after that frame paints. That one fully visible frame is the flash
    // on collapse. Hold the exit's last keyframe until removal instead, as
    // Radix Presence does. Don't unmount synchronously from the animationend
    // listener (flushSync): the node would be gone before React dispatches
    // the same event, so the content's own onAnimationEnd would never fire.
    const prevFillMode = node.style.animationFillMode
    node.style.animationFillMode = "forwards"
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setPresent(false)
    }
    const onAnimationDone = (event: AnimationEvent) => {
      // Child animations bubble; only the content's own exit counts.
      if (event.target !== node) return
      // A cancelled exit leaves no keyframe for `forwards` to hold, so the
      // content is already back at its resting style: unmount before that
      // paints. React has no onAnimationCancel for this to starve.
      if (event.type === "animationcancel") flushSync(finish)
      else finish()
    }
    node.addEventListener("animationend", onAnimationDone)
    node.addEventListener("animationcancel", onAnimationDone)
    const timeout = window.setTimeout(finish, exitTimeoutMs(styles))
    return () => {
      node.removeEventListener("animationend", onAnimationDone)
      node.removeEventListener("animationcancel", onAnimationDone)
      window.clearTimeout(timeout)
      // Reopened mid-exit: the node stays mounted, so hand back its own
      // fill mode for the enter animation.
      node.style.animationFillMode = prevFillMode
    }
  }, [open])

  if (!present) return null

  return (
    <div
      ref={nodeRef}
      data-slot="collapsible-content"
      data-state={open ? "open" : "closed"}
      id={context.contentId}
      {...props}
    >
      {children}
    </div>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }

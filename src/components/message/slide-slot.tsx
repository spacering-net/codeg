"use client"

import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A slot in a line of the conversation that slides open as its content
 * arrives and shut as it goes, so what is under it moves along instead of
 * jumping: a running command's last lines under its row, the running turn's
 * figures over the composer.
 *
 * `show` says whether the content belongs there; the caller keeps passing the
 * content while it does not, so the slot has something to close over (the
 * finished command's last lines, the turn's last figures). Opening plays only
 * when the content comes after the slot was mounted — a slot mounted open (a
 * row the virtual list brought back, a conversation opened mid-turn) shows its
 * content as it stands. Like `reply-fold-body`, it moves on a grid track, so
 * nothing reads layout; with chat animations off or reduced motion there is no
 * animation, and the slot opens and closes at once (globals.css).
 */
export function SlideSlot({
  show,
  children,
  className,
}: {
  show: boolean
  children: ReactNode
  className?: string
}) {
  const [present, setPresent] = useState(show)
  const [motion, setMotion] = useState<"enter" | "leave" | null>(null)
  if (show && !present) {
    setPresent(true)
    setMotion("enter")
  } else if (show && motion === "leave") {
    setMotion("enter")
  } else if (!show && present && motion !== "leave") {
    setMotion("leave")
  }

  const slotRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (motion !== "enter" || !slot) return
    // No slide to wait for: open as it stands.
    const name = getComputedStyle(slot).animationName
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!name || name === "none") setMotion(null)
  }, [motion])
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (motion !== "leave" || !slot) return
    const close = () => {
      setPresent(false)
      setMotion(null)
    }
    const styles = getComputedStyle(slot)
    if (!styles.animationName || styles.animationName === "none") {
      // Nothing to wait for: closed in the same flush, before it paints.
      close()
      return
    }
    const done = (event?: Event) => {
      // The content's own animations bubble up here; only the slot's counts.
      if (event && event.target !== slot) return
      close()
    }
    slot.addEventListener("animationend", done)
    slot.addEventListener("animationcancel", done)
    // Should neither fire — the slot stops being drawn mid-slide.
    const timer = window.setTimeout(
      done,
      Number.parseFloat(styles.animationDuration) * 1000 + 100
    )
    return () => {
      slot.removeEventListener("animationend", done)
      slot.removeEventListener("animationcancel", done)
      window.clearTimeout(timer)
    }
  }, [motion])

  if (!present) return null
  return (
    <div
      ref={slotRef}
      className={cn("slide-slot", className)}
      data-motion={motion ?? undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && motion === "enter") {
          setMotion(null)
        }
      }}
    >
      <div>{children}</div>
    </div>
  )
}

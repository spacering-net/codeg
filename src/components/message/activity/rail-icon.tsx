"use client"

import type { ComponentType, ReactNode, SVGProps } from "react"
import { CalendarClockIcon, FilePenLineIcon, ListTodoIcon } from "lucide-react"

import type { StepStatus } from "@/lib/activity/types"
import { cn } from "@/lib/utils"

export type ActivityIcon = ComponentType<SVGProps<SVGSVGElement>>

/**
 * A glyph is drawn over the whole ring, its 24-unit drawing scaled to the
 * middle by the viewBox: 12px of a 20px ring, 10px of a 16px one. Drawn in a
 * box of its own, the glyph and the ring each snapped to the device pixels
 * on their own — at 90% or 110% zoom a glyph sat half a pixel off its ring.
 */
const GLYPH_PAD = { md: 8, sm: 7.2 } as const

/**
 * Glyphs whose drawing is off the middle of its 24-unit box, by how far (the
 * paths' bounding box): the viewBox moves with it, so the drawing — not the
 * box — sits in the middle of the ring.
 */
const GLYPH_OFFSET = new Map<ActivityIcon, readonly [number, number]>([
  [FilePenLineIcon, [1, 0]],
  [CalendarClockIcon, [0.5, 0]],
  [ListTodoIcon, [0, -0.5]],
])

function glyphViewBox(icon: ActivityIcon, size: "md" | "sm"): string {
  const pad = GLYPH_PAD[size]
  const [dx, dy] = GLYPH_OFFSET.get(icon) ?? [0, 0]
  const side = 24 + pad * 2
  return `${dx - pad} ${dy - pad} ${side} ${side}`
}

/**
 * Sets a turning element's turn to the clock's, so every one is at the same
 * angle at the same moment, however long it has been in the page. The ring
 * at the foot of the steps is not one element for the life of a reply — it
 * moves from under the prose to the foot of the rail, into a group and out,
 * and the pending reply's gives way to the reply's own — and each new one
 * starting its turn from the top made the arc jump back as it took over.
 *
 * A ref, so it runs as the element is attached, before the page is drawn and
 * the animation starts; and one function for the module's life, so React does
 * not call it again on every render — moving the delay of a turn already
 * running would jump it.
 */
function turnInStep(periodMs: number) {
  return (element: HTMLElement | null) => {
    if (element && typeof performance !== "undefined") {
      element.style.animationDelay = `${-(performance.now() % periodMs)}ms`
    }
  }
}

/** One turn of `animate-spin`. */
const turningRingInStep = turnInStep(1000)
/** One turn of a running step's arc (`[animation-duration:1.5s]`). */
const runningArcInStep = turnInStep(1500)

/**
 * Ring colour by status, quiet by default: a finished step fades back to a
 * faint grey divider (`--activity-ring-done`), and only a failure (red) or
 * something waiting on the user (amber) takes a colour. A running step is
 * told apart by MOTION — an arc in the theme's colour turning on a light
 * track; on the red and rose presets that colour is the failure hue, and
 * only the turning arc against a whole red ring tells them apart. A pending
 * step keeps a dashed ring that turns slowly.
 */
const RING_CLASS: Record<StepStatus, string> = {
  succeeded: "border-activity-ring-done",
  pending: "border-dashed border-activity-ring",
  running: "border-activity-ring",
  awaiting: "border-tone-warning",
  failed: "border-tone-danger",
  rejected: "border-tone-danger",
  cancelled: "border-dashed border-activity-ring-done",
}

const ICON_CLASS: Record<StepStatus, string> = {
  succeeded: "text-muted-foreground",
  pending: "text-muted-foreground",
  running: "text-foreground/80",
  awaiting: "text-tone-warning",
  failed: "text-tone-danger",
  rejected: "text-tone-danger",
  cancelled: "text-muted-foreground/70",
}

/**
 * The status ring at the head of a row. The ring and the glyph are separate
 * layers so a running ring can turn without turning the glyph. `size="sm"`
 * is for rows inside an expanded group.
 */
export function RailIcon({
  icon: Icon,
  glyph,
  status,
  label,
  size = "md",
  className,
  iconClassName,
}: {
  icon?: ActivityIcon
  /** Drawn in the ring instead of `icon` — an agent's own logo. */
  glyph?: ReactNode
  status: StepStatus
  /** What the ring says to a screen reader, e.g. "command failed, exit 1".
   *  Without one the ring is decoration — the words beside it say it all. */
  label?: string
  size?: "md" | "sm"
  className?: string
  /** On `icon`, after its status colour (a hover that inks it in). */
  iconClassName?: string
}) {
  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        size === "md" ? "size-5" : "size-4",
        className
      )}
    >
      {/* The rest ring: the state's colour, fading to the finished tone when a
          running step settles (the tone is the only thing that changes). */}
      <span
        aria-hidden="true"
        data-ring={
          status === "succeeded" || status === "cancelled" ? "quiet" : undefined
        }
        className={cn(
          "absolute inset-0 rounded-full border-[0.5px] transition-[border-color] duration-500",
          RING_CLASS[status],
          // `animate-spin` survives the "chat animations off" switch on
          // purpose (see globals.css): a turning ring is the one cue left
          // that a step is still running. Reduced motion stops it; the row
          // then says "running" in words instead.
          status === "pending" &&
            "animate-spin [animation-duration:2.4s] motion-reduce:animate-none"
        )}
      />
      {/* A running step: a solid arc turning over the light track. A 0.5px
          dashed ring that turned could not be read as turning at this size. */}
      {status === "running" ? (
        <span
          aria-hidden="true"
          ref={runningArcInStep}
          className="absolute inset-0 animate-spin rounded-full border-[1.25px] border-transparent border-t-activity-ring-live [animation-duration:1.5s] motion-reduce:animate-none"
        />
      ) : null}
      {glyph ??
        (Icon ? (
          <Icon
            aria-hidden="true"
            viewBox={glyphViewBox(Icon, size)}
            className={cn(
              "absolute inset-0 size-full",
              ICON_CLASS[status],
              iconClassName
            )}
          />
        ) : null)}
    </span>
  )
}

/**
 * The turning mark of an agent at work: a ring like a step's with a quarter of
 * it turning in the theme's colour — at the foot of a live list's rail, or
 * under a reply whose list is not in view. Sized and placed by `className`.
 * Like a running ring it keeps turning with chat animations off and stops
 * under reduced motion; the header says "Working" in words either way. Two
 * plain elements, the turning one childless: a turning element is restyled
 * every frame, its children with it, and an SVG's turn also lays the page
 * out every frame — for as long as the reply streams.
 */
export function TurningRing({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative block", className)}>
      <span className="absolute inset-0 rounded-full border-[0.5px] border-activity-ring" />
      <span
        ref={turningRingInStep}
        className="absolute inset-0 animate-spin rounded-full border-[1.25px] border-transparent border-t-activity-ring-live motion-reduce:animate-none"
      />
    </span>
  )
}

/** The turning mark on its own, under a live reply whose steps are folded
 *  away (see `TurningRing`): placed for a 1.5rem slot, its centre on the
 *  rail's line. The same mark, for the reply's motion, as the ring at the
 *  foot of its steps. */
export function WorkingMark() {
  return (
    <div
      aria-hidden="true"
      className="relative h-6"
      data-marker="working"
      data-motion-key="working"
    >
      <TurningRing className="absolute start-0.5 top-1 size-4" />
    </div>
  )
}

/** The small dot that marks prose between steps, and explore group members. */
export function RailDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/50",
        className
      )}
    />
  )
}

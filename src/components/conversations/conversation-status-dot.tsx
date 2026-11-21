"use client"

import type { ReactNode } from "react"
import type { ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import type { BlockingPromptKind } from "@/lib/blocking-prompts"
import { cn } from "@/lib/utils"

type ConversationStatusDotSize = "xs" | "sm" | "md"

interface ConversationStatusDotProps {
  status?: ConversationStatus | null
  size?: ConversationStatusDotSize
  className?: string
  title?: string
  children?: ReactNode
  /**
   * The connection is parked on a decision and cannot move until the user acts
   * (see `conversation-attention`). It outranks `status`: a session waiting on
   * an answer is ALSO `in_progress`, and drawing it in the running amber is the
   * exact confusion this mark exists to remove — a blocked session and a busy
   * one are indistinguishable today.
   *
   * Distinguishing it by hue alone would not work: the dot is 6–8px and amber
   * is already taken, so a fourth colour is a colour-blindness coin flip at that
   * size. So the mark changes SHAPE and MOTION as well as colour — a violet fill
   * inside a violet outline that breathes. Legible in greyscale, survives every
   * theme, and reads as "here, and waiting" rather than "finished" or "working".
   *
   * Both additions are chosen to compose with the callers' own geometry: an
   * `outline` (which takes no box, so a placed dot's offsets are untouched) and
   * an opacity pulse (transform-free, so it never re-runs the sidebar
   * virtualizer's layout). A pseudo-element halo or a `relative` wrapper would
   * both have collided with the `absolute` positioning some callers pass in
   * `className`.
   */
  attention?: BlockingPromptKind | null
}

const SIZE_CLASS: Record<ConversationStatusDotSize, string> = {
  xs: "h-1 w-1",
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
}

const FALLBACK_COLOR = "bg-gray-400 dark:bg-gray-500"

/** Violet for every blocking kind. One mark, one meaning — WHICH of the three
 *  prompts it is belongs in the `title` and on the card the user opens, not in a
 *  colour a 6px dot cannot deliver. */
const ATTENTION_COLOR = "bg-violet-500 dark:bg-violet-400"

const ATTENTION_RING =
  "outline outline-1 outline-offset-1 outline-violet-500/60 dark:outline-violet-400/60 animate-pulse motion-reduce:animate-none"

export function ConversationStatusDot({
  status,
  size = "md",
  className,
  title,
  children,
  attention,
}: ConversationStatusDotProps) {
  const colorClass = attention
    ? ATTENTION_COLOR
    : (status && STATUS_COLORS[status]) || FALLBACK_COLOR
  return (
    <span
      // The kind is on the DOM so a test (and CSS, if one is ever needed) can
      // tell a permission prompt from a question without reading the colour.
      data-attention={attention ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        SIZE_CLASS[size],
        colorClass,
        attention && ATTENTION_RING,
        className
      )}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      {children}
    </span>
  )
}

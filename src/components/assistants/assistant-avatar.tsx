"use client"

import { UserRound } from "lucide-react"

import { monogramFor } from "@/lib/assistant-avatar"
import type { AssistantAvatar as AssistantAvatarValue } from "@/lib/types"
import type { AssistantAvatarColor } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The disc a monogram or emoji avatar sits on, per palette key — one
 *  treatment per theme. Literal strings so Tailwind can see them. */
const DISC_CLASSES: Record<AssistantAvatarColor, string> = {
  slate:
    "bg-slate-500/15 text-slate-700 dark:bg-slate-400/20 dark:text-slate-200",
  red: "bg-red-500/15 text-red-700 dark:bg-red-400/20 dark:text-red-200",
  orange:
    "bg-orange-500/15 text-orange-700 dark:bg-orange-400/20 dark:text-orange-200",
  amber:
    "bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-200",
  green:
    "bg-green-500/15 text-green-700 dark:bg-green-400/20 dark:text-green-200",
  teal: "bg-teal-500/15 text-teal-700 dark:bg-teal-400/20 dark:text-teal-200",
  sky: "bg-sky-500/15 text-sky-700 dark:bg-sky-400/20 dark:text-sky-200",
  blue: "bg-blue-500/15 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200",
  violet:
    "bg-violet-500/15 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200",
  pink: "bg-pink-500/15 text-pink-700 dark:bg-pink-400/20 dark:text-pink-200",
}

/** Solid swatches for the colour picker, same keys. */
export const SWATCH_CLASSES: Record<AssistantAvatarColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
}

export interface AssistantAvatarProps {
  /** `null` draws the generic assistant glyph (an id nothing here knows). */
  avatar: AssistantAvatarValue | null | undefined
  /** The name a monogram is drawn from. */
  name: string
  /** Pixel size of the (round) avatar. */
  size: number
  className?: string
}

/** An assistant's avatar: its monogram, emoji or picture on a round disc. */
export function AssistantAvatar({
  avatar,
  name,
  size,
  className,
}: AssistantAvatarProps) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45) }
  if (!avatar) {
    return (
      <span
        data-slot="assistant-avatar"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          className
        )}
        style={style}
        aria-hidden
      >
        <UserRound style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    )
  }
  if (avatar.kind === "image") {
    return (
      // A data URL from the API: next/image has nothing to optimise here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        data-slot="assistant-avatar"
        src={avatar.data_url}
        alt=""
        draggable={false}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    )
  }
  const glyph = avatar.kind === "emoji" ? avatar.emoji : monogramFor(name)
  if (!glyph) {
    // A monogram with no name to draw it from — only a new assistant before
    // its name is typed: the generic figure, on the colour already chosen.
    return (
      <span
        data-slot="assistant-avatar"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full",
          DISC_CLASSES[avatar.color] ?? DISC_CLASSES.slate,
          className
        )}
        style={style}
        aria-hidden
      >
        <UserRound style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    )
  }
  return (
    <span
      data-slot="assistant-avatar"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none",
        DISC_CLASSES[avatar.color] ?? DISC_CLASSES.slate,
        className
      )}
      style={
        avatar.kind === "emoji"
          ? { ...style, fontSize: Math.round(size * 0.55) }
          : style
      }
      aria-hidden
    >
      {glyph}
    </span>
  )
}

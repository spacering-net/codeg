"use client"

import { UserRound } from "lucide-react"

import { isEmojiGlyph, monogramFor } from "@/lib/assistant-avatar"
import type { AvatarTextColor, DiscAvatar } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The disc a monogram or emoji avatar sits on, per palette key — one
 *  treatment per theme. Literal strings so Tailwind can see them. The
 *  collaboration settings' ten, then the faces' colours an assistant's
 *  text avatar takes (each the palette step its face is drawn in). */
const DISC_CLASSES: Record<AvatarTextColor, string> = {
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
  black:
    "bg-neutral-900/15 text-neutral-900 dark:bg-neutral-200/20 dark:text-neutral-100",
  brown:
    "bg-amber-800/15 text-amber-900 dark:bg-amber-600/25 dark:text-amber-200",
  yellow:
    "bg-yellow-400/25 text-yellow-800 dark:bg-yellow-300/20 dark:text-yellow-100",
  purple:
    "bg-violet-500/15 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200",
  magenta:
    "bg-fuchsia-500/15 text-fuchsia-700 dark:bg-fuchsia-400/20 dark:text-fuchsia-200",
  gray: "bg-slate-400/20 text-slate-600 dark:bg-slate-500/25 dark:text-slate-200",
}

/** A length given in px at 100% zoom, as rem (app zoom scales the root font
 *  size). */
function rem(px: number): string {
  return `${px / 16}rem`
}

export interface AssistantAvatarProps {
  /** `null` draws the generic assistant glyph (an id nothing here knows). */
  avatar: DiscAvatar | null | undefined
  /** The name a monogram is drawn from. */
  name: string
  /** Size of the (round) avatar, in px at 100% zoom: drawn in rem, so it
   *  grows and shrinks with the app zoom like the text beside it. */
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
  const style = {
    width: rem(size),
    height: rem(size),
    fontSize: rem(Math.round(size * 0.45)),
  }
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
        <UserRound
          style={{ width: rem(size * 0.55), height: rem(size * 0.55) }}
        />
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
        // `max-w-none`: an image's base `max-width: 100%` would squeeze it
        // into a box narrower than its size (the discs above just overflow).
        className={cn(
          "max-w-none shrink-0 rounded-full object-cover",
          className
        )}
        style={{ width: rem(size), height: rem(size) }}
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
        <UserRound
          style={{ width: rem(size * 0.5), height: rem(size * 0.5) }}
        />
      </span>
    )
  }
  return (
    <span
      data-slot="assistant-avatar"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none",
        avatar.kind === "emoji" && isEmojiGlyph(glyph) && "font-emoji",
        DISC_CLASSES[avatar.color] ?? DISC_CLASSES.slate,
        className
      )}
      style={
        avatar.kind === "emoji"
          ? { ...style, fontSize: rem(Math.round(size * 0.55)) }
          : style
      }
      aria-hidden
    >
      {glyph}
    </span>
  )
}

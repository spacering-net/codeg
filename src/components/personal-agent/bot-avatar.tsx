"use client"

/**
 * An assistant's avatar (10.6): a shape codeg draws, in one of eleven
 * colours, with two capsule eyes — or, for the assistants made before, the
 * executor configs' monogram, emoji or picture, drawn as they always were.
 * A new assistant's face comes from its uid (`defaultBotFace`), the same way
 * the backend picks it, so the page can show it before it is made.
 *
 * Still for now: the eyes' states and their motion come with the roster
 * (1.7).
 */

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import type {
  AssistantAvatar as AssistantAvatarValue,
  BotAvatar as BotAvatarValue,
  BotColor,
  BotShape,
} from "@/lib/types"
import { cn } from "@/lib/utils"

export const BOT_SHAPES: readonly BotShape[] = [
  "blob",
  "pebble",
  "squircle",
  "pill",
  "wedge",
  "hexagon",
  "cloud",
  "drop",
  "bean",
  "egg",
  "shield",
  "burst",
]

export const BOT_COLORS: readonly BotColor[] = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "magenta",
  "gray",
]

/** The shapes and colours a new assistant is given by default (as the
 *  backend's `DEFAULT_SHAPES` / `DEFAULT_COLORS`). */
const DEFAULT_SHAPES: readonly BotShape[] = [
  "blob",
  "pebble",
  "squircle",
  "pill",
  "cloud",
  "drop",
  "bean",
  "egg",
]
const DEFAULT_COLORS: readonly BotColor[] = BOT_COLORS.filter(
  (c) => c !== "black"
)

/** FNV-1a, 32 bits, over the uid's UTF-8 bytes (a uid is ASCII hex). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The face an assistant with `uid` gets by default. */
export function defaultBotFace(uid: string): BotAvatarValue {
  const h = fnv1a(uid)
  return {
    kind: "face",
    shape:
      DEFAULT_SHAPES[
        Math.floor(h / DEFAULT_COLORS.length) % DEFAULT_SHAPES.length
      ],
    color: DEFAULT_COLORS[h % DEFAULT_COLORS.length],
  }
}

/** A fresh uid: 32 lowercase hex digits, as the backend makes them. */
export function newBotUid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Each colour's body, tuned once for the light theme and once for the
 *  dark one so it stands off either background; literal strings so
 *  Tailwind sees them. */
const BODY: Record<BotColor, string> = {
  black: "fill-neutral-900 dark:fill-neutral-200",
  brown: "fill-amber-800 dark:fill-amber-600",
  red: "fill-red-500 dark:fill-red-400",
  orange: "fill-orange-500 dark:fill-orange-400",
  yellow: "fill-yellow-400 dark:fill-yellow-300",
  green: "fill-green-500 dark:fill-green-400",
  teal: "fill-teal-500 dark:fill-teal-400",
  blue: "fill-blue-500 dark:fill-blue-400",
  purple: "fill-violet-500 dark:fill-violet-400",
  magenta: "fill-fuchsia-500 dark:fill-fuchsia-400",
  gray: "fill-slate-400 dark:fill-slate-500",
}

/** The eyes: light on the darker bodies, dark on the light ones. */
const EYES: Record<BotColor, string> = {
  black: "fill-white dark:fill-neutral-900",
  brown: "fill-white",
  red: "fill-white",
  orange: "fill-neutral-900",
  yellow: "fill-neutral-900",
  green: "fill-white dark:fill-neutral-900",
  teal: "fill-white dark:fill-neutral-900",
  blue: "fill-white",
  purple: "fill-white",
  magenta: "fill-white",
  gray: "fill-neutral-900 dark:fill-white",
}

/** The shapes, in a 100 × 100 box. */
const PATHS: Record<BotShape, string> = {
  blob: "M50 6C74 6 94 22 94 48C94 76 76 94 50 94C22 94 6 78 6 50C6 24 26 6 50 6Z",
  pebble:
    "M52 10C78 10 96 28 92 54C88 80 68 92 46 90C22 88 6 72 8 48C10 24 28 10 52 10Z",
  squircle:
    "M50 8C84 8 92 16 92 50C92 84 84 92 50 92C16 92 8 84 8 50C8 16 16 8 50 8Z",
  pill: "M30 18H70C86 18 96 32 96 50C96 68 86 82 70 82H30C14 82 4 68 4 50C4 32 14 18 30 18Z",
  wedge:
    "M50 8C56 8 60 12 64 19L93 74C97 82 92 90 83 90H17C8 90 3 82 7 74L36 19C40 12 44 8 50 8Z",
  hexagon:
    "M30 10H70C74 10 77 12 79 15L95 44C97 48 97 52 95 56L79 85C77 88 74 90 70 90H30C26 90 23 88 21 85L5 56C3 52 3 48 5 44L21 15C23 12 26 10 30 10Z",
  cloud:
    "M28 86C14 86 4 76 4 63C4 51 12 42 23 40C25 24 37 12 53 12C68 12 80 22 83 36C93 39 97 49 96 60C95 75 84 86 70 86H28Z",
  drop: "M50 4C62 22 88 42 88 62C88 82 71 96 50 96C29 96 12 82 12 62C12 42 38 22 50 4Z",
  bean: "M34 10C52 10 56 26 70 26C86 26 96 40 94 58C92 78 76 92 54 92C26 92 6 74 6 48C6 26 18 10 34 10Z",
  egg: "M50 6C72 6 88 34 88 58C88 80 71 94 50 94C29 94 12 80 12 58C12 34 28 6 50 6Z",
  shield:
    "M50 6L88 18C90 19 92 21 92 24V48C92 72 74 88 52 95C51 95.5 49 95.5 48 95C26 88 8 72 8 48V24C8 21 10 19 12 18L50 6Z",
  burst:
    "M50 4L60 16L75 9L78 25L94 27L88 42L98 54L84 62L88 78L72 78L66 93L52 84L38 93L32 78L16 78L20 62L4 54L14 42L8 27L24 25L27 9L42 16Z",
}

function rem(px: number): string {
  return `${px / 16}rem`
}

export interface BotAvatarProps {
  avatar: BotAvatarValue | AssistantAvatarValue | null | undefined
  name: string
  /** In px at 100% zoom. */
  size: number
  /** The primary assistant: a star at the foot. */
  star?: boolean
  className?: string
}

/** An assistant's face, or its executor-config avatar. */
export function BotAvatar({
  avatar,
  name,
  size,
  star,
  className,
}: BotAvatarProps) {
  if (!avatar || avatar.kind !== "face") {
    return (
      <AssistantAvatar
        avatar={avatar as AssistantAvatarValue | null | undefined}
        name={name}
        size={size}
        className={className}
      />
    )
  }
  const { shape, color } = avatar
  return (
    <span
      data-slot="bot-avatar"
      data-bot-shape={shape}
      data-bot-color={color}
      role="img"
      aria-label={name}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: rem(size), height: rem(size) }}
    >
      <svg viewBox="0 0 100 100" className="size-full" aria-hidden>
        <path d={PATHS[shape] ?? PATHS.blob} className={BODY[color]} />
        <rect
          x="34"
          y="36"
          width="9"
          height="20"
          rx="4.5"
          className={EYES[color]}
        />
        <rect
          x="57"
          y="36"
          width="9"
          height="20"
          rx="4.5"
          className={EYES[color]}
        />
      </svg>
      {star ? (
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="absolute -end-0.5 -bottom-0.5 size-[38%] fill-amber-400 stroke-background stroke-[3] [paint-order:stroke]"
        >
          <path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z" />
        </svg>
      ) : null}
    </span>
  )
}

"use client"

/**
 * An assistant's avatar is its state (10.6): a shape codeg draws, in one of
 * eleven colours, with two capsule eyes whose look says what it is doing —
 * or, for the assistants made before, the executor configs' monogram, emoji
 * or picture, drawn as they always were, its state then only in a ring
 * round it and the dot. A new assistant's face comes from its uid
 * (`defaultBotFace`), the same way the backend picks it, so the page can
 * show it before it is made.
 *
 * - **Looks.** idle: calm, blinking every 2.8–5.5 s (a double blink one
 *   time in seven), half the time a glance left, right or up instead, held
 *   0.5–0.9 s; thinking: eyes up, wandering; working: eyes down and
 *   focused, the body bobbing; waiting: eyes on you, breathing; stuck:
 *   drowsy, lids half down; done: eyes curved into a smile, a hop; failed:
 *   eyes drooping; sleeping: eyes shut, breathing slowly, "z z z" rising.
 *   A new look comes through a blink.
 * - **Alive only when told.** A face is still unless it is given a `look`:
 *   the roster, the title and the status line pass one; a face on a card
 *   or a system line stays put. The idle scheduler pauses while the window
 *   is hidden; under reduced motion every look rests in its still pose.
 * - **The dot.** Orange while it waits on the owner (ringed in the colour
 *   under it, `--pa-dot-ring`), blue while something is unread — always
 *   blue, whatever the accent colour. At the bottom end; on the primary,
 *   whose star is there, at the top end.
 */

import { useEffect, useState } from "react"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import type {
  AssistantAvatar as AssistantAvatarValue,
  BotAvatar as BotAvatarValue,
  BotColor,
  BotLook,
  BotShape,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import type { RosterDot } from "./roster-order"

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

/** The eyes: light on the darker bodies, dark on the light ones (as the
 *  text colour, so filled capsules and stroked arcs both take it). */
const EYES: Record<BotColor, string> = {
  black: "text-white dark:text-neutral-900",
  brown: "text-white",
  red: "text-white",
  orange: "text-neutral-900",
  yellow: "text-neutral-900",
  green: "text-white dark:text-neutral-900",
  teal: "text-white dark:text-neutral-900",
  blue: "text-white",
  purple: "text-white",
  magenta: "text-white",
  gray: "text-neutral-900 dark:text-white",
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

/** How long a blink keeps the lids down. */
const BLINK_MS = 120
/** A new look shows this far into the blink that brings it. */
const LOOK_SWAP_MS = 90
/** Below this size the "z z z" would be specks. */
const Z_MIN_SIZE = 20

/** The eyes' centres in the 100 × 100 box. */
const EYE_X = [38.5, 61.5] as const
const EYE_Y = 46

type Glance = "left" | "right" | "up"

const GLANCE_SHIFT: Record<Glance, string> = {
  left: "translate(-4px, 0px)",
  right: "translate(4px, 0px)",
  up: "translate(0px, -4px)",
}

/** Where the eyes sit for a look (moved as a whole, in box units). */
const EYES_AT: Record<BotLook, number> = {
  idle: 0,
  thinking: -7,
  working: 6,
  waiting: 0,
  stuck: 3,
  done: 0,
  failed: 5,
  sleeping: 5,
}

function capsule(cx: number, w: number, h: number, key: string) {
  return (
    <rect
      key={key}
      x={cx - w / 2}
      y={EYE_Y - h / 2}
      width={w}
      height={h}
      rx={w / 2}
      fill="currentColor"
    />
  )
}

/** One look's eyes. */
function eyesOf(look: BotLook) {
  switch (look) {
    case "thinking":
      return EYE_X.map((cx, i) => capsule(cx, 8.5, 17, `e${i}`))
    case "working":
      return EYE_X.map((cx, i) => capsule(cx, 8, 12, `e${i}`))
    case "waiting":
      return EYE_X.map((cx, i) => capsule(cx, 10, 21, `e${i}`))
    case "stuck":
      // Lids half down: the lower half of each eye, its top flat.
      return EYE_X.map((cx, i) => (
        <path
          key={`e${i}`}
          d={`M${cx - 4.5} ${EYE_Y} H${cx + 4.5} V${EYE_Y + 5.5} A4.5 4.5 0 0 1 ${cx - 4.5} ${EYE_Y + 5.5} Z`}
          fill="currentColor"
        />
      ))
    case "done":
      // Curved up into a smile.
      return EYE_X.map((cx, i) => (
        <path
          key={`e${i}`}
          d={`M${cx - 6} ${EYE_Y + 3} Q${cx} ${EYE_Y - 7} ${cx + 6} ${EYE_Y + 3}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={4.5}
          strokeLinecap="round"
        />
      ))
    case "failed":
      // Drooping: tilted in at the top.
      return EYE_X.map((cx, i) => (
        <rect
          key={`e${i}`}
          x={cx - 4}
          y={EYE_Y - 6.5}
          width={8}
          height={13}
          rx={4}
          fill="currentColor"
          transform={`rotate(${i === 0 ? 18 : -18} ${cx} ${EYE_Y})`}
        />
      ))
    case "sleeping":
      // Shut: two arcs curving down.
      return EYE_X.map((cx, i) => (
        <path
          key={`e${i}`}
          d={`M${cx - 5.5} ${EYE_Y} Q${cx} ${EYE_Y + 5.5} ${cx + 5.5} ${EYE_Y}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          strokeLinecap="round"
        />
      ))
    case "idle":
    default:
      return EYE_X.map((cx, i) => capsule(cx, 9, 20, `e${i}`))
  }
}

/** The ring round a picture, an emoji or a monogram, by look: the state it
 *  has no eyes to show. */
const RING: Partial<Record<BotLook, string>> = {
  thinking: "pa-face-ring border-primary/60",
  working: "pa-face-ring border-primary/70",
  waiting: "border-orange-500/70",
  stuck: "border-orange-500/70",
  done: "border-emerald-500/70",
  failed: "border-red-500/70",
}

export interface BotAvatarProps {
  avatar: BotAvatarValue | AssistantAvatarValue | null | undefined
  name: string
  /** In px at 100% zoom. */
  size: number
  /** The primary assistant: a star at the foot. */
  star?: boolean
  className?: string
  /** What it is doing (`viewOf` in `roster-order`). A face given one is
   *  alive — it blinks, glances, moves with the look; one given none stays
   *  still in the idle pose. */
  look?: BotLook
  /** Waiting on the owner (orange) or something unread (blue). */
  dot?: RosterDot
  /** The full accessible name — who and how it is ("Nova, working,
   *  unread"); the name alone when left out. */
  label?: string
}

/** An assistant's face, or its executor-config avatar. */
export function BotAvatar(props: BotAvatarProps) {
  const { avatar } = props
  if (!avatar || avatar.kind !== "face") return <PictureAvatar {...props} />
  return <FaceAvatar {...props} face={avatar} />
}

function Dot({
  dot,
  size,
  star,
}: {
  dot: RosterDot | undefined
  size: number
  star?: boolean
}) {
  if (!dot) return null
  const px = Math.min(12, Math.max(6, size * 0.27))
  return (
    <span
      aria-hidden
      data-bot-dot={dot}
      className={cn(
        "absolute -end-0.5 rounded-full shadow-[0_0_0_2px_var(--pa-dot-ring)]",
        star ? "-top-0.5" : "-bottom-0.5",
        dot === "waiting" ? "bg-orange-500" : "bg-blue-500"
      )}
      style={{ width: rem(px), height: rem(px) }}
    />
  )
}

/** A picture, an emoji or a monogram: drawn as it always was; its state,
 *  when it has one to show, a ring round it and the dot. */
function PictureAvatar({
  avatar,
  name,
  size,
  className,
  look,
  dot,
  label,
  star,
}: BotAvatarProps) {
  const plain = (
    <AssistantAvatar
      avatar={avatar as AssistantAvatarValue | null | undefined}
      name={name}
      size={size}
      className={look || dot ? undefined : className}
    />
  )
  if (!look && !dot) return plain
  const ring = look ? RING[look] : undefined
  return (
    <span
      data-slot="bot-avatar"
      data-bot-look={look}
      role="img"
      aria-label={label ?? name}
      className={cn(
        "pa-face relative inline-flex shrink-0",
        look === "sleeping" && "opacity-70",
        className
      )}
      style={{ width: rem(size), height: rem(size) }}
    >
      {plain}
      {ring ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-0.5 rounded-full border-2",
            ring
          )}
        />
      ) : null}
      <Dot dot={dot} size={size} star={star} />
    </span>
  )
}

function FaceAvatar({
  face,
  name,
  size,
  star,
  className,
  look,
  dot,
  label,
}: BotAvatarProps & { face: Extract<BotAvatarValue, { kind: "face" }> }) {
  const reduced = useReducedMotion()
  const alive = look != null && !reduced
  const target: BotLook = look ?? "idle"

  // A new look comes through a blink: the lids close, the look changes
  // behind them, they open. Without motion it changes at once.
  const [shown, setShown] = useState<BotLook>(target)
  const [pending, setPending] = useState<BotLook>(target)
  const [swapBlink, setSwapBlink] = useState(false)
  if (pending !== target) {
    setPending(target)
    if (alive) setSwapBlink(true)
    else setShown(target)
  }
  useEffect(() => {
    if (!alive) return
    const swap = setTimeout(() => setShown(pending), LOOK_SWAP_MS)
    const open = setTimeout(() => setSwapBlink(false), LOOK_SWAP_MS + BLINK_MS)
    return () => {
      clearTimeout(swap)
      clearTimeout(open)
    }
  }, [pending, alive])
  const displayed: BotLook = alive ? shown : target

  // At rest it blinks now and then, or glances about — while the window is
  // seen.
  const idle = alive && displayed === "idle"
  const [idleBlink, setIdleBlink] = useState(false)
  const [glance, setGlance] = useState<Glance | null>(null)
  useEffect(() => {
    if (!idle) return
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let gone = false
    const later = (ms: number, then: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t)
        if (!gone) then()
      }, ms)
      timers.add(t)
    }
    const blink = (then: () => void) => {
      setIdleBlink(true)
      later(BLINK_MS, () => {
        setIdleBlink(false)
        then()
      })
    }
    const next = () => later(2800 + Math.random() * 2700, act)
    const act = () => {
      if (typeof document !== "undefined" && document.hidden) {
        next()
        return
      }
      if (Math.random() < 0.5) {
        const dirs: Glance[] = ["left", "right", "up"]
        setGlance(dirs[Math.floor(Math.random() * dirs.length)] ?? "left")
        later(500 + Math.random() * 400, () => {
          setGlance(null)
          next()
        })
      } else {
        blink(() => {
          if (Math.random() < 0.14) later(140, () => blink(next))
          else next()
        })
      }
    }
    next()
    return () => {
      gone = true
      for (const t of timers) clearTimeout(t)
      setIdleBlink(false)
      setGlance(null)
    }
  }, [idle])

  const blinking = alive && (swapBlink || (idle && idleBlink))
  const { shape, color } = face
  return (
    <span
      data-slot="bot-avatar"
      data-bot-shape={shape}
      data-bot-color={color}
      data-bot-look={look ? displayed : undefined}
      data-blink={blinking ? "" : undefined}
      role="img"
      aria-label={label ?? name}
      className={cn("pa-face relative inline-flex shrink-0", className)}
      style={{ width: rem(size), height: rem(size) }}
    >
      <svg
        viewBox="0 0 100 100"
        className="size-full"
        overflow="visible"
        aria-hidden
      >
        <g className="pa-face-body">
          <path d={PATHS[shape] ?? PATHS.blob} className={BODY[color]} />
          <g transform={`translate(0 ${EYES_AT[displayed]})`}>
            <g
              className="pa-face-gaze"
              style={
                idle && glance ? { transform: GLANCE_SHIFT[glance] } : undefined
              }
            >
              <g className={cn("pa-face-lids", EYES[color])}>
                {eyesOf(displayed)}
              </g>
            </g>
          </g>
        </g>
        {displayed === "sleeping" && size >= Z_MIN_SIZE ? (
          <g
            aria-hidden
            className="fill-muted-foreground"
            fontWeight={700}
            fontFamily="inherit"
          >
            {[
              { x: 76, y: 14, s: 18, d: 0 },
              { x: 86, y: 4, s: 22, d: 1 },
              { x: 96, y: -6, s: 26, d: 2 },
            ].map((z) => (
              <text
                key={z.d}
                className="pa-face-z"
                x={z.x}
                y={z.y}
                fontSize={z.s}
                style={{
                  animationDelay: `calc(var(--motion-breathe) * ${z.d * 0.4})`,
                }}
              >
                z
              </text>
            ))}
          </g>
        ) : null}
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
      <Dot dot={dot} size={size} star={star} />
    </span>
  )
}

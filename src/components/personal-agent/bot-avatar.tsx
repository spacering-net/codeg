"use client"

/**
 * An assistant's avatar is its state (10.6): one of the thirteen things
 * codeg draws (`bot-shapes.ts` — the primary's ring, twelve things a coder
 * works with), a solid in one of eleven colours with two eyes on its face,
 * turning as a whole with what it is doing — or, for the assistants made
 * before, the executor configs' monogram, emoji or picture, drawn as they
 * always were, its state then only in a ring round it and the dot. Under
 * 32px it is drawn small (no edge lines, larger eyes). A new assistant's
 * face comes from its uid (`defaultBotFace`), the same way the backend picks
 * it, so the page can show it before it is made.
 *
 * - **Looks.** idle: at rest, blinking every 2.8–5.5 s (a double blink one
 *   time in seven), half the time a glance left, right or up instead, held
 *   0.5–0.9 s; thinking: looking up and about, its head wandering; working:
 *   eyes down and narrowed, nodding over its work, bobbing (the ring's star
 *   running round its band); waiting: turned to face you, breathing deep;
 *   stuck: drowsy, lids half down, swaying; done: eyes curved into a smile,
 *   a turn round and two hops; failed: eyes drooping, a shake of the head;
 *   sleeping: eyes shut, leaning back, breathing slowly, "z z z" rising. A
 *   new look comes through a blink.
 * - **The pointer.** A face that is alive notices the pointer coming over
 *   it — or over what it is the face of, a row or a tile marked
 *   `data-pa-face-host`: it perks up with a little hop — asleep, it wakes
 *   — and turns, whole, toward the pointer while it stays (its eyes a
 *   little ahead), settling back once it leaves.
 * - **Alive only when told.** A face is still unless it is given a `look`:
 *   the roster, the title and the status line pass one; a face on a card
 *   or a system line stays put, its drawing made once per shape, look and
 *   size. A face that moves is drawn by one frame loop for all
 *   (`bot-face-motion`), only while its pose changes; the idle scheduler
 *   pauses while the window is hidden; under reduced motion every look
 *   rests in its still pose.
 * - **The dot.** Orange while it waits on the owner (ringed in the colour
 *   under it, `--pa-dot-ring`), blue while something is unread — always
 *   blue, whatever the accent colour. At the bottom end; on the primary,
 *   whose star is there, at the top end.
 */

import {
  useCallback,
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import type {
  AssistantAvatar as AssistantAvatarValue,
  BotAvatar as BotAvatarValue,
  BotColor,
  BotLook,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { startFaceMotion, type FaceMotion } from "./bot-face-motion"
import { addFaceTones, defineFace } from "./bot-face-page"
import {
  ART_BOX,
  DEFAULT_SHAPES,
  SMALL_FACE_BELOW,
  colorOf,
  restFace,
  shapeOf,
} from "./bot-shapes"
import type { RosterDot } from "./roster-order"

export { BOT_SHAPES } from "./bot-shapes"

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

/** The colours a new assistant is given by default (as the backend's
 *  `DEFAULT_COLORS`): all but black, the primary's. */
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

/** What the primary assistant starts with (10.6): the black ring — the
 *  SpaceRing mark. */
export const PRIMARY_FACE: BotAvatarValue = {
  kind: "face",
  shape: "ring",
  color: "black",
}

/** The face an assistant was given by default — what [Reset] in the face
 *  editor goes back to; `null` for one with no uid to tell it by. */
export function defaultFaceOf(
  bot: { kind: "primary" | "worker"; uid: string | null } | null
): BotAvatarValue | null {
  if (!bot) return null
  if (bot.kind === "primary") return PRIMARY_FACE
  return bot.uid ? defaultBotFace(bot.uid) : null
}

/** A fresh uid: 32 lowercase hex digits, as the backend makes them. */
export function newBotUid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Each colour's body, tuned once for the light theme and once for the
 *  dark one so it stands off either background; literal strings so
 *  Tailwind sees them. The owner's bubbles in an assistant's conversation
 *  take the same steps (`--pa-body` in globals.css). */
export const FACE_BODY: Record<BotColor, string> = {
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
 *  text colour, so filled capsules and stroked arcs both take it). The
 *  words on the owner's bubbles take the same (`--pa-eyes`). */
export const FACE_EYES: Record<BotColor, string> = {
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

function rem(px: number): string {
  return `${px / 16}rem`
}

/** How long a blink keeps the lids down. */
const BLINK_MS = 120
/** A new look shows this far into the blink that brings it. */
const LOOK_SWAP_MS = 90
/** Below this size the "z z z" would be specks. */
const Z_MIN_SIZE = 20
/** The room round a face's box its drawing has, in the box's units: the
 *  highest it goes — a hop at its peak on a perk at its peak, the last z
 *  of its sleep on its way up — is some 45 above it, the z's some 25 past
 *  its side. */
const FACE_ROOM = 60

type Glance = "left" | "right" | "up"

/** Where a glance at rest moves the eyes, on the face (up is +). */
const GLANCE_AT: Record<Glance, readonly [number, number]> = {
  left: [-14, 0],
  right: [14, 0],
  up: [0, 12],
}

/** The drawing's 512 box in the face's 100 one. */
const ART_SCALE = 100 / ART_BOX

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

/** The pointer over a face that is alive — or over what it is the face of,
 *  a row or a tile marked `data-pa-face-host`: whether it is there, and how
 *  many times it came over (each a perk of the body); where it is goes to
 *  `aim` once a frame at most — from the face's middle, in its sizes (at
 *  least 60px), `null` once it leaves. A touch is not a pointer that
 *  hovers. */
function useFaceHover(
  ref: RefObject<HTMLElement | null>,
  on: boolean,
  aim: (ptr: readonly [number, number] | null) => void
): { over: boolean; perks: number } {
  const [over, setOver] = useState(false)
  const [perks, setPerks] = useState(0)
  useEffect(() => {
    const face = ref.current
    if (!on || !face) return
    const host = face.closest<HTMLElement>("[data-pa-face-host]") ?? face
    let frame = 0
    let at: { x: number; y: number } | null = null
    const send = () => {
      frame = 0
      if (!at) return
      const r = face.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const unit = Math.max(r.width, 60)
      aim([
        (at.x - (r.left + r.width / 2)) / unit,
        (at.y - (r.top + r.height / 2)) / unit,
      ])
    }
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return
      at = { x: e.clientX, y: e.clientY }
      if (!frame) frame = requestAnimationFrame(send)
    }
    const enter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return
      setOver(true)
      setPerks((n) => n + 1)
      move(e)
    }
    const leave = () => {
      at = null
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      setOver(false)
      aim(null)
    }
    host.addEventListener("pointerenter", enter)
    host.addEventListener("pointermove", move)
    host.addEventListener("pointerleave", leave)
    return () => {
      host.removeEventListener("pointerenter", enter)
      host.removeEventListener("pointermove", move)
      host.removeEventListener("pointerleave", leave)
      if (frame) cancelAnimationFrame(frame)
      setOver(false)
      aim(null)
    }
  }, [ref, on, aim])
  return { over, perks }
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
  // What moves it while it is alive (`bot-face-motion`).
  const motion = useRef<FaceMotion | null>(null)
  const aim = useCallback(
    (ptr: readonly [number, number] | null) => motion.current?.aim(ptr),
    []
  )
  // The pointer over it (`useFaceHover`): asleep, it wakes up for it, turns
  // to the pointer, and goes back to sleep once it leaves.
  const rootRef = useRef<HTMLSpanElement>(null)
  const { over, perks } = useFaceHover(rootRef, alive, aim)
  const target: BotLook =
    over && look === "sleeping" ? "idle" : (look ?? "idle")

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
  const watching = over && displayed !== "sleeping"
  const shownGlance = idle && !watching ? glance : null

  const id = useId()
  const base = `pa-face-${id.replace(/[^\w-]/g, "")}`
  const shape = shapeOf(face.shape)
  const color = colorOf(face.color)
  const small = size < SMALL_FACE_BELOW
  // Its drawing at rest (the page's, `bot-face-page`), still in the look it
  // shows; alive, in the look it first showed — from then on what moves it
  // draws it (`bot-face-motion`), so a render never puts back a pose it has
  // moved on from.
  const [firstLook] = useState(displayed)
  const drawnLook = alive ? firstLook : displayed
  useInsertionEffect(() => {
    addFaceTones()
    defineFace(shape, drawnLook, small)
  }, [shape, drawnLook, small])
  const html = useMemo(
    () => ({ __html: restFace(shape, drawnLook, small) }),
    [shape, drawnLook, small]
  )
  const artRef = useRef<SVGGElement>(null)
  // Whether it has been moved since its drawing was last the page's.
  const moved = useRef(false)
  useEffect(() => {
    const el = artRef.current
    if (!alive || !el) return
    const m = startFaceMotion(el, base)
    motion.current = m
    moved.current = true
    return () => {
      m.dispose()
      if (motion.current === m) motion.current = null
    }
  }, [alive, base])
  // No longer moved (reduced motion asked for mid-turn): back to the
  // drawing the page has for it, which a render does not write again when
  // it has not changed.
  useEffect(() => {
    const el = artRef.current
    if (alive || !el || !moved.current) return
    moved.current = false
    el.innerHTML = html.__html
  }, [alive, html])
  useEffect(() => {
    motion.current?.set(
      {
        shape,
        small,
        look: displayed,
        glance: shownGlance ? GLANCE_AT[shownGlance] : null,
      },
      drawnLook
    )
  }, [alive, base, shape, small, displayed, shownGlance, drawnLook])

  return (
    <span
      ref={rootRef}
      data-slot="bot-avatar"
      data-bot-shape={shape}
      data-bot-color={color}
      data-bot-small={small ? "" : undefined}
      data-bot-look={look ? displayed : undefined}
      data-blink={blinking ? "" : undefined}
      data-glance={shownGlance ?? undefined}
      data-hover={watching ? "" : undefined}
      data-perk={alive && perks > 0 ? (perks % 2 ? "a" : "b") : undefined}
      role="img"
      aria-label={label ?? name}
      className={cn("pa-face relative inline-flex shrink-0", className)}
      style={{ width: rem(size), height: rem(size) }}
    >
      {/* Its 100 × 100 box with room round it on every side, laid over the
          face so the face sits as ever: its hops and stretches, and the z's
          of its sleep, reach well past the box, and WebKit cuts an animated
          SVG off at its own edges on screen, whatever its overflow — so the
          edges are where nothing is drawn. Never in the pointer's way. */}
      <svg
        viewBox={`${-FACE_ROOM} ${-FACE_ROOM} ${100 + 2 * FACE_ROOM} ${100 + 2 * FACE_ROOM}`}
        className="pointer-events-none absolute max-w-none"
        data-pa-tone={color}
        // Inline, so a parent's rule for the icons in it (a card head's
        // `[&_svg]:size-3.5`) never resizes it.
        style={{
          left: `${-FACE_ROOM}%`,
          top: `${-FACE_ROOM}%`,
          width: `${100 + 2 * FACE_ROOM}%`,
          height: `${100 + 2 * FACE_ROOM}%`,
        }}
        overflow="visible"
        aria-hidden
      >
        <g className="pa-face-body">
          <g className="pa-face-perk">
            <g
              ref={artRef}
              className="pa-face-art"
              transform={`scale(${ART_SCALE})`}
              dangerouslySetInnerHTML={html}
            />
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

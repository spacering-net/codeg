/**
 * The thirteen things an assistant can be drawn as (10.6): the ring — the
 * SpaceRing mark, the primary's — and twelve things a coder works with: a
 * terminal, braces, a shield, a chip, a bug, a pointer, a gear, a code
 * file, a magnifier, a package, a rocket and a mug. Each is a solid seen in
 * three quarters, its side showing at the lower left and lit from the top
 * left, as the ring of the mark is; it turns as a whole — toward the
 * pointer, with what it is doing — and its two eyes sit on its face, turned
 * with it.
 *
 * A drawing is SVG markup in a 512 × 512 box, made for a pose (where its
 * face points, where its eyes look, how open they are). It is flat-coloured:
 * every paint is one of a colour's tones (`faceTones`), the colour's own
 * palette step in each theme, a lighter and a deeper one made from it. The
 * page paints by CSS variables (`faceToneCss`, a class per tone), so either
 * theme follows without a drawing made again; the PNGs handed to the
 * desktop (`personal-agent-avatar-png`) by the light theme's hex — one
 * drawing serves both.
 *
 * Under 32px a face is drawn small: no edge lines, no thin strokes on it,
 * its ring's band thicker, its eyes larger — so a roster row's face reads.
 *
 * Cost: the outlines are made once per shape; a drawing projects them and
 * writes the sides of a part in a path or two (a dented one's back to front,
 * a path per run of like-lit sides), so a pose costs some tens of elements.
 * A face at rest is drawn once per shape, look and size for the whole page
 * (`restBody`, `restFace`: a `<use>` of it and the face's own eyes); only a
 * face that turns is drawn again, by itself (`bot-face-motion`).
 */

import type { BotColor, BotLook, BotShape } from "@/lib/types"

/** The box a shape is drawn in. */
export const ART_BOX = 512

/** Below this size, in px, a face is drawn small. */
export const SMALL_FACE_BELOW = 32

/** The shapes, the primary's first. */
export const BOT_SHAPES: readonly BotShape[] = [
  "ring",
  "terminal",
  "braces",
  "shield",
  "chip",
  "bug",
  "cursor",
  "gear",
  "file",
  "magnifier",
  "package",
  "rocket",
  "mug",
]

/** The shapes a new assistant is given by default: all but the ring, the
 *  primary's (as the backend's `DEFAULT_SHAPES`, in the same order). */
export const DEFAULT_SHAPES: readonly BotShape[] = BOT_SHAPES.filter(
  (s) => s !== "ring"
)

/** The shapes the assistants had before these, each to the one it is now
 *  drawn as (the backend reads them the same way). */
const RENAMED: Readonly<Record<string, BotShape>> = {
  stand: "terminal",
  donut: "braces",
  gummy: "shield",
  tape: "chip",
  nut: "bug",
  magnet: "cursor",
  set_square: "file",
  cookie: "magnifier",
  frame: "package",
  watch: "rocket",
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** The shape a face is drawn as: its own, the one an old name became, or —
 *  for a name codeg never drew — the terminal. */
export function shapeOf(name: string): BotShape {
  if ((BOT_SHAPES as readonly string[]).includes(name)) return name as BotShape
  return has(RENAMED, name) ? RENAMED[name] : "terminal"
}

// ── colour ──────────────────────────────────────────────────────────────

/** Each colour's own palette step, light theme and dark (tailwind's, as
 *  `FACE_BODY` in bot-avatar.tsx names them). */
const BASE: Readonly<Record<BotColor, readonly [string, string]>> = {
  black: ["#171717", "#e5e5e5"],
  brown: ["#92400e", "#d97706"],
  red: ["#ef4444", "#f87171"],
  orange: ["#f97316", "#fb923c"],
  yellow: ["#facc15", "#fde047"],
  green: ["#22c55e", "#4ade80"],
  teal: ["#14b8a6", "#2dd4bf"],
  blue: ["#3b82f6", "#60a5fa"],
  purple: ["#8b5cf6", "#a78bfa"],
  magenta: ["#d946ef", "#e879f9"],
  gray: ["#94a3b8", "#64748b"],
}

export const FACE_COLORS = Object.keys(BASE) as BotColor[]

/** A colour codeg draws: itself, or blue for one it does not. */
export function colorOf(name: string): BotColor {
  return has(BASE, name) ? (name as BotColor) : "blue"
}

export type FaceTheme = "light" | "dark"

/** The paints a face is drawn with, each one of its colour's tones. */
export const TONE_ROLES = [
  "body",
  "side",
  "sideLit",
  "rim",
  "edge",
  "edgeLit",
  "edgeDark",
  "wall",
  "star",
  "starShade",
  "lit",
  "dark",
  "screen",
  "decoDark",
  "decoLit",
  "decoLit2",
  "glare",
  "eyeBody",
  "eyeScreen",
  "eyeHole",
  "eyeFloat",
] as const
export type ToneRole = (typeof TONE_ROLES)[number]

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function mix(a: string, b: string, t: number): string {
  const x = hex(a)
  const y = hex(b)
  return (
    "#" +
    x
      .map((v, i) =>
        Math.round(v + (y[i] - v) * t)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  )
}

function luminance(c: string): number {
  const f = (v: number) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const [r, g, b] = hex(c)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** The contrast ratio of two colours (WCAG). */
export function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** The eyes: a dark grey, or near white where dark grey would not read. */
export const EYE_DARK = "#3a3f47"
export const EYE_LIGHT = "#f6f7f9"
function eyeOn(ground: string): string {
  return contrast(ground, EYE_DARK) >= contrast(ground, EYE_LIGHT)
    ? EYE_DARK
    : EYE_LIGHT
}

/** A colour's paints in a theme: from its own step, a lighter tone and a
 *  deeper one (a very dark colour's "deeper" is a step lighter, so its
 *  side still shows). */
export function faceTones(
  color: BotColor,
  theme: FaceTheme
): Readonly<Record<ToneRole, string>> {
  const b = BASE[colorOf(color)][theme === "dark" ? 1 : 0]
  const l = mix(b, "#ffffff", 0.5)
  const d =
    luminance(b) < 0.03 ? mix(b, "#ffffff", 0.22) : mix(b, "#000000", 0.38)
  const lit = mix(l, b, 0.25)
  const dark = mix(d, b, 0.3)
  const screen = mix(l, "#ffffff", theme === "dark" ? 0.35 : 0.55)
  return {
    body: b,
    side: mix(b, d, 0.55),
    sideLit: mix(b, l, 0.35),
    rim: mix(b, l, 0.65),
    edge: mix(b, l, 0.6),
    edgeLit: mix(lit, l, 0.6),
    edgeDark: mix(dark, l, 0.6),
    wall: mix(l, b, 0.35),
    star: mix(l, "#ffffff", 0.45),
    starShade: d,
    lit,
    dark,
    screen,
    decoDark: mix(d, "#000000", 0.15),
    decoLit: mix(l, "#ffffff", 0.3),
    decoLit2: mix(l, b, 0.5),
    glare: "#ffffff",
    eyeBody: eyeOn(b),
    eyeScreen: eyeOn(screen),
    // In the ring's open hole, on the page: dark grey on a light page, the
    // colour as light on a dark one.
    eyeHole: theme === "dark" ? mix(l, "#ffffff", 0.6) : EYE_DARK,
    eyeFloat: theme === "dark" ? EYE_LIGHT : EYE_DARK,
  }
}

const KEBAB = Object.fromEntries(
  TONE_ROLES.map((r) => [
    r,
    r.replace(/[A-Z0-9]/g, (c) => `-${c}`).toLowerCase(),
  ])
) as Record<ToneRole, string>

/** The stylesheet the page paints faces with: each colour's tones as
 *  variables on `[data-pa-tone]`, once per theme, and a class per tone for
 *  a fill (`pa-f-…`) and a stroke (`pa-s-…`). */
export function faceToneCss(): string {
  const vars = (color: BotColor, theme: FaceTheme) => {
    const t = faceTones(color, theme)
    return TONE_ROLES.map((r) => `--pa-k-${KEBAB[r]}:${t[r]}`).join(";")
  }
  let css = ""
  for (const c of FACE_COLORS) {
    css += `[data-pa-tone="${c}"]{${vars(c, "light")}}`
    css += `.dark [data-pa-tone="${c}"]{${vars(c, "dark")}}`
  }
  for (const r of TONE_ROLES) {
    const k = KEBAB[r]
    css += `.pa-f-${k}{fill:var(--pa-k-${k})}.pa-s-${k}{stroke:var(--pa-k-${k})}`
  }
  return css
}

/** How a drawing is painted: by the page's tone classes, or in a theme's
 *  hex (`faceTones`) for a picture of it. */
export type FacePaint = "css" | Readonly<Record<ToneRole, string>>

function fillOf(p: FacePaint, r: ToneRole): string {
  return p === "css" ? `class="pa-f-${KEBAB[r]}"` : `fill="${p[r]}"`
}
function strokeOf(p: FacePaint, r: ToneRole): string {
  return p === "css"
    ? `fill="none" class="pa-s-${KEBAB[r]}"`
    : `fill="none" stroke="${p[r]}"`
}
function bothOf(p: FacePaint, r: ToneRole): string {
  return p === "css"
    ? `class="pa-f-${KEBAB[r]} pa-s-${KEBAB[r]}"`
    : `fill="${p[r]}" stroke="${p[r]}"`
}

// ── space ───────────────────────────────────────────────────────────────

/** A direction in the drawing's space: x right, y down (as the page's), z
 *  toward the viewer. */
export type V3 = readonly [number, number, number]
type Pt = readonly [number, number]

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
/** Turned about the upright axis. */
const rotY = (a: V3, t: number): V3 => [
  a[0] * Math.cos(t) + a[2] * Math.sin(t),
  a[1],
  -a[0] * Math.sin(t) + a[2] * Math.cos(t),
]

/** The light, from the top left and in front. */
const LIGHT = norm([-0.55, -0.65, 0.5])

/** A face's plane: its right (`u`) and its up (`v`), for the way it points. */
function frame(n: V3): { u: V3; v: V3 } {
  const up: V3 = [0, -1, 0]
  let v = add(up, scale(n, -dot(up, n)))
  if (Math.hypot(v[0], v[1], v[2]) < 1e-3) v = [0, 0, -1]
  v = norm(v)
  return { u: norm(cross(n, v)), v }
}

type Fmt = (v: number) => number
const fine: Fmt = (v) => Math.round(v * 10) / 10
const coarse: Fmt = (v) => Math.round(v)

function pathOf(xs: readonly number[], ys: readonly number[], f: Fmt): string {
  let d = `M${f(xs[0])} ${f(ys[0])}`
  for (let i = 1; i < xs.length; i++) d += `L${f(xs[i])} ${f(ys[i])}`
  return d + "Z"
}

function pathPts(pts: readonly Pt[], f: Fmt, closed = true): string {
  let d = ""
  for (let i = 0; i < pts.length; i++) {
    d += `${i ? "L" : "M"}${f(pts[i][0])} ${f(pts[i][1])}`
  }
  return closed ? d + "Z" : d
}

/** The convex hull of points (monotone chain). */
function hull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cr = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: Pt[] = []
  const hi: Pt[] = []
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0)
      lo.pop()
    lo.push(q)
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0)
      hi.pop()
    hi.push(q)
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}

// ── pose ────────────────────────────────────────────────────────────────

/** How a face is posed: where it points (`n`), where its eyes look on it
 *  (`gx` right, `gy` up, in the box's units), how open they are, and where
 *  round its band the ring's star is (radians). */
export interface FacePose {
  n: V3
  gx: number
  gy: number
  open: number
  star: number
}

/** The ring as the mark lies: 30° off the page, the far side of its inner
 *  wall showing at the top right. */
const TILT = (30 * Math.PI) / 180
const RING_N: V3 = norm([
  0.5 * Math.sin(TILT),
  -0.866 * Math.sin(TILT),
  Math.cos(TILT),
])
/** The rest: three quarters, the side showing at the lower left. */
const ICON_N: V3 = norm([0.22, -0.3, 1])

/** Each look's turn, from the ring's rest (another shape turns as much
 *  from its own). */
const LOOK_N: Readonly<Record<BotLook, V3>> = {
  idle: RING_N,
  thinking: norm(add(RING_N, [0.12, -0.16, 0])),
  working: norm(add(RING_N, [-0.03, 0.14, 0])),
  waiting: norm([0.06, -0.12, 1]),
  stuck: norm(add(RING_N, [0.04, 0.1, 0])),
  failed: norm(add(RING_N, [0, 0.14, 0])),
  done: RING_N,
  sleeping: norm(add(RING_N, [0, -0.42, 0])),
}

/** Where each look's eyes are on the face (up is +). */
const LOOK_GAZE: Readonly<Record<BotLook, Pt>> = {
  idle: [0, 0],
  thinking: [14, 22],
  working: [0, -16],
  waiting: [0, 0],
  stuck: [0, -12],
  failed: [0, -18],
  done: [0, 0],
  sleeping: [0, -8],
}

const STAR_AT = (-118 * Math.PI) / 180
/** A done face turns round once; a failed one shakes its head once. */
export const DONE_SPIN_S = 0.8
const FAILED_SHAKE_S = 1

/** Whether a look's pose still changes `t` seconds into it. */
export function isMoving(look: BotLook, t: number): boolean {
  if (look === "thinking" || look === "working") return true
  if (look === "done") return t < DONE_SPIN_S
  if (look === "failed") return t < FAILED_SHAKE_S
  return false
}

/** Whether a look turns the face at once rather than easing to it (a
 *  spin, a shake). */
export function isSnapping(look: BotLook, t: number): boolean {
  return (
    (look === "done" && t < DONE_SPIN_S) ||
    (look === "failed" && t < FAILED_SHAKE_S)
  )
}

/** How far off the pointer is (in the face's sizes) for the face to turn
 *  to it all the way. */
const PTR_FULL = 1.8
/** How far it turns to the pointer: what is added to its facing. */
const PTR_TURN = 0.56
/** How far its eyes go ahead of the turn, across and up (ring units). */
const PTR_EYES: Pt = [22, 18]

/**
 * A face's pose `t` seconds into a look. `ptr`: the pointer from its
 * middle, in its own sizes (or `null`) — it turns toward it, its eyes a
 * little ahead. `glance`: its eyes moved, as a glance at rest moves them.
 */
export function poseAt(
  shape: BotShape | string,
  look: BotLook,
  t: number,
  ptr: Pt | null = null,
  glance: Pt | null = null
): FacePose {
  const rest = shapeOf(shape) === "ring" ? RING_N : ICON_N
  const turn = LOOK_N[look] ?? RING_N
  let n = norm(add(turn, [rest[0] - RING_N[0], rest[1] - RING_N[1], 0]))
  const at = LOOK_GAZE[look] ?? LOOK_GAZE.idle
  let gx = at[0]
  let gy = at[1]
  let star = STAR_AT
  if (look === "thinking") {
    n = norm(add(n, [0.07 * Math.sin(t * 1.3), 0.04 * Math.sin(t * 2.1), 0]))
    gx += 10 * Math.sin(t * 1.3)
  } else if (look === "working") {
    star += t * 2.4
    n = norm(add(n, [0, 0.05 * Math.sin(t * 5), 0]))
  } else if (look === "failed" && t < FAILED_SHAKE_S) {
    n = rotY(n, Math.sin(t * 22) * 0.3 * (1 - t / FAILED_SHAKE_S))
  } else if (look === "done" && t < DONE_SPIN_S) {
    n = rotY(n, (t / DONE_SPIN_S) * 2 * Math.PI)
  }
  if (glance) {
    gx += glance[0]
    gy += glance[1]
  }
  if (ptr && look !== "sleeping") {
    const d = Math.hypot(ptr[0], ptr[1]) || 1
    const reach = Math.min(1, d / PTR_FULL)
    const ux = (ptr[0] / d) * reach
    const uy = (ptr[1] / d) * reach
    n = norm(add(n, [ux * PTR_TURN, uy * PTR_TURN, 0]))
    gx += ux * PTR_EYES[0]
    gy -= uy * PTR_EYES[1]
  }
  return { n, gx, gy, open: 1, star }
}

// ── eyes ────────────────────────────────────────────────────────────────

/** Where a shape's eyes are on its face: their middle (`a` right, `b` up),
 *  how far apart, and their size against the ring's. */
interface EyeAt {
  a: number
  b: number
  sep: number
  k: number
}

/** The two eyes for a look, on the face's plane (`to` places a point of
 *  it), in their paint; a group of their own, which the page blinks. */
function eyesMarkup(
  look: BotLook,
  pose: FacePose,
  at: EyeAt,
  small: boolean,
  to: (a: number, b: number) => Pt,
  role: ToneRole,
  paint: FacePaint,
  f: Fmt
): string {
  const k = (small ? 1.28 : 1) * at.k
  const sep = at.sep * (small ? 1.05 : 1)
  let rx = 21 * k
  let ry = 40 * k
  if (look === "waiting") {
    rx *= 1.06
    ry *= 1.06
  }
  const steps = small ? 6 : 12
  let out = ""
  for (const side of [-1, 1]) {
    const a0 = at.a + side * sep + pose.gx * at.k
    const b0 = at.b + pose.gy * at.k
    if (look === "done" || look === "sleeping") {
      // Curved up into a smile, or shut: an arc each.
      const pts: Pt[] = []
      for (let i = 0; i <= steps; i++) {
        const t = -1 + (2 * i) / steps
        const bow = ry * 0.35 * (1 - t * t)
        const b = look === "done" ? b0 + bow - ry * 0.1 : b0 - bow + ry * 0.1
        pts.push(to(a0 + t * rx * 1.4, b))
      }
      out +=
        `<path d="${pathPts(pts, f, false)}" ${strokeOf(paint, role)} ` +
        `stroke-width="${f(rx * 0.95)}" stroke-linecap="round" stroke-linejoin="round"/>`
      continue
    }
    const pts: Pt[] = []
    const arc = steps + 4
    if (look === "stuck") {
      // Lids half down: the lower half of each eye, its top flat.
      const hh = Math.max(0, ry - rx)
      pts.push(to(a0 - rx, b0), to(a0 + rx, b0))
      for (let i = 0; i <= arc; i++) {
        const t = (Math.PI * i) / arc
        pts.push(to(a0 + rx * Math.cos(t), b0 - hh - rx * Math.sin(t)))
      }
    } else {
      let h = ry * pose.open
      if (look === "working") h *= 0.58
      else if (look === "failed") h *= 0.72
      else if (look === "thinking") h *= 0.88
      h = Math.max(h, rx * 0.2)
      // Its ends round; shorter than it is wide, it flattens.
      const cap = Math.min(rx, h)
      const hh = h - cap
      // Drooping when failed: each leaned in at the top.
      const lean = look === "failed" ? (-side * 18 * Math.PI) / 180 : 0
      const c = Math.cos(lean)
      const s = Math.sin(lean)
      const put = (da: number, db: number) =>
        pts.push(to(a0 + da * c + db * s, b0 - da * s + db * c))
      for (let i = 0; i <= arc; i++) {
        const t = Math.PI + (Math.PI * i) / arc
        put(rx * Math.cos(t), hh - cap * Math.sin(t))
      }
      for (let i = 0; i <= arc; i++) {
        const t = (Math.PI * i) / arc
        put(rx * Math.cos(t), -hh - cap * Math.sin(t))
      }
    }
    out += `<path d="${pathPts(pts, f)}" ${fillOf(paint, role)}/>`
  }
  return `<g class="pa-face-lids">${out}</g>`
}

// ── the ring ────────────────────────────────────────────────────────────

/** The band's outer radius, inner radius and depth; drawn small, its band
 *  is wider and its eyes have more room. */
const RING_R = 224
const RING_RI = 198
const RING_H = 92
const RING_RI_SMALL = 180
const RING_H_SMALL = 90
const RING_EYES: EyeAt = { a: 0, b: 22, sep: 62, k: 1 }

function drawRing(
  pose: FacePose,
  small: boolean,
  id: string,
  paint: FacePaint,
  f: Fmt
): string {
  let n = pose.n
  const back = n[2] < 0
  if (back) n = scale(n, -1)
  const { u, v } = frame(n)
  const ri = small ? RING_RI_SMALL : RING_RI
  const hh = (small ? RING_H_SMALL : RING_H) / 2
  const steps = small ? 48 : 72
  const circle = (rho: number, depth: number): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i < steps; i++) {
      const t = (2 * Math.PI * i) / steps
      const c = rho * Math.cos(t)
      const s = rho * Math.sin(t)
      out.push([
        256 + n[0] * depth + u[0] * c + v[0] * s,
        256 + n[1] * depth + u[1] * c + v[1] * s,
      ])
    }
    return out
  }
  const fo = circle(RING_R, hh)
  const bo = circle(RING_R, -hh)
  const fi = circle(ri, hh)
  const bi = circle(ri, -hh)
  const outline = pathPts(hull(fo.concat(bo)), f)
  const frontOuter = pathPts(fo, f)
  const frontInner = pathPts(fi, f)
  const backInner = pathPts(bi, f)
  // The band's face and its outer side, the hole see-through.
  let o =
    `<path fill-rule="evenodd" d="${outline}${frontInner}" ${fillOf(paint, "body")}/>` +
    `<path fill-rule="evenodd" d="${outline}${frontOuter}" ${fillOf(paint, "side")}/>`
  if (!small) {
    // A light edge where the face turns into the side, kept inside the
    // band's outline.
    o +=
      `<clipPath id="${id}-o"><path d="${outline}"/></clipPath>` +
      `<path d="${frontOuter}" ${strokeOf(paint, "rim")} stroke-width="7" clip-path="url(#${id}-o)"/>`
  }
  // Through the hole: the lit inner wall from the near rim to the far one
  // (the eyes go over it, `faceEyes`).
  o +=
    `<clipPath id="${id}-h"><path d="${frontInner}"/></clipPath>` +
    `<path fill-rule="evenodd" d="${frontInner}${backInner}" ${fillOf(paint, "wall")} clip-path="url(#${id}-h)"/>`
  if (!small && !back) o += ringStar(pose.star, n, u, v, hh, paint, f)
  return o
}

/** The four-point star on the band's outer side, lying on its surface (so
 *  it turns and foreshortens with it), a shadow under it away from the
 *  light. */
function ringStar(
  angle: number,
  n: V3,
  u: V3,
  v: V3,
  hh: number,
  paint: FacePaint,
  f: Fmt
): string {
  const m = add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle)))
  if (m[2] < 0.06) return ""
  const t = cross(n, m)
  const ro = hh * 2 * 0.3
  const at = (p: number, q: number, lift: number): Pt => [
    256 + m[0] * (RING_R + lift) + n[0] * p + t[0] * q,
    256 + m[1] * (RING_R + lift) + n[1] * p + t[1] * q,
  ]
  const tips: Pt[] = [
    [ro, 0],
    [0, ro],
    [-ro, 0],
    [0, -ro],
  ]
  const k = 0.16
  const star = (lift: number) => {
    const p0 = at(tips[0][0], tips[0][1], lift)
    let d = `M${f(p0[0])} ${f(p0[1])}`
    for (let i = 0; i < 4; i++) {
      const a = tips[i]
      const b = tips[(i + 1) % 4]
      const q = at((a[0] + b[0]) * k, (a[1] + b[1]) * k, lift)
      const e = at(b[0], b[1], lift)
      d += `Q${f(q[0])} ${f(q[1])} ${f(e[0])} ${f(e[1])}`
    }
    return d + "Z"
  }
  const lp = dot(LIGHT, n)
  const lq = dot(LIGHT, t)
  const sx = -(lq * t[0] + lp * n[0]) * 3
  const sy = -(lq * t[1] + lp * n[1]) * 3
  return (
    `<path d="${star(0)}" ${fillOf(paint, "starShade")} fill-opacity=".55" transform="translate(${f(sx)} ${f(sy)})"/>` +
    `<path d="${star(2)}" ${fillOf(paint, "star")}/>`
  )
}

// ── the twelve: outlines on a face's plane (a right, b up; ±220 or so) ────

const TAU = Math.PI * 2

function arcPts(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  steps = 16
): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)])
  }
  return out
}

function roundRect(w: number, h: number, r: number, cx = 0, cy = 0): Pt[] {
  const x = w / 2 - r
  const y = h / 2 - r
  // As many steps round a corner as it is large.
  const k = Math.max(2, Math.min(7, Math.round(r / 7)))
  return [
    ...arcPts(cx + x, cy + y, r, 0, Math.PI / 2, k),
    ...arcPts(cx - x, cy + y, r, Math.PI / 2, Math.PI, k),
    ...arcPts(cx - x, cy - y, r, Math.PI, 1.5 * Math.PI, k),
    ...arcPts(cx + x, cy - y, r, 1.5 * Math.PI, TAU, k),
  ]
}

function circlePts(r: number, cx = 0, cy = 0, steps = 48): Pt[] {
  return arcPts(cx, cy, r, 0, TAU, steps).slice(0, -1)
}

function ellipsePts(rx: number, ry: number, cx = 0, cy = 0, steps = 40): Pt[] {
  return Array.from(
    { length: steps },
    (_, i): Pt => [
      cx + rx * Math.cos((TAU * i) / steps),
      cy + ry * Math.sin((TAU * i) / steps),
    ]
  )
}

function polarPts(fn: (t: number) => number, steps: number): Pt[] {
  return Array.from({ length: steps }, (_, i): Pt => {
    const t = (TAU * i) / steps
    const r = fn(t)
    return [r * Math.cos(t), r * Math.sin(t)]
  })
}

/** A polygon with its corners rounded by `r` (a point it bends at by
 *  less than 20° is no corner, and stays as it is). */
function roundPoly(pts: readonly Pt[], r: number, steps = 5): Pt[] {
  const out: Pt[] = []
  const to = (a: Pt, b: Pt, d: number): Pt => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const k = Math.min(d, l / 2) / l
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  }
  const straight = Math.cos((20 * Math.PI) / 180)
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % pts.length]
    const ax = p1[0] - p0[0]
    const ay = p1[1] - p0[1]
    const bx = p2[0] - p1[0]
    const by = p2[1] - p1[1]
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (!la || !lb) continue
    if ((ax * bx + ay * by) / (la * lb) > straight) {
      out.push(p1)
      continue
    }
    const a = to(p1, p0, r)
    const b = to(p1, p2, r)
    for (let j = 0; j <= steps; j++) {
      const t = j / steps
      const w0 = (1 - t) * (1 - t)
      const w1 = 2 * (1 - t) * t
      const w2 = t * t
      out.push([
        w0 * a[0] + w1 * p1[0] + w2 * b[0],
        w0 * a[1] + w1 * p1[1] + w2 * b[1],
      ])
    }
  }
  return out
}

/** A smooth curve through points (Catmull-Rom). */
function spline(pts: readonly Pt[], per = 8): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let j = 0; j < per; j++) {
      const t = j / per
      const t2 = t * t
      const t3 = t2 * t
      const c = (a: number, b: number, cc: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + cc) * t +
          (2 * a - 5 * b + 4 * cc - d) * t2 +
          (-a + 3 * b - 3 * cc + d) * t3)
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** A line of width `w` along `pts`, round at its ends, as an outline. */
function strokeOutline(pts: readonly Pt[], w: number): Pt[] {
  const left: Pt[] = []
  const right: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    let dx = b[0] - a[0]
    let dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    dx /= l
    dy /= l
    left.push([pts[i][0] - (dy * w) / 2, pts[i][1] + (dx * w) / 2])
    right.push([pts[i][0] + (dy * w) / 2, pts[i][1] - (dx * w) / 2])
  }
  const end = pts[pts.length - 1]
  const pe = pts[pts.length - 2]
  const st = pts[0]
  const ps = pts[1]
  const ae = Math.atan2(end[1] - pe[1], end[0] - pe[0])
  const as = Math.atan2(st[1] - ps[1], st[0] - ps[0])
  return [
    ...left,
    ...arcPts(
      end[0],
      end[1],
      w / 2,
      ae + Math.PI / 2,
      ae - Math.PI / 2,
      6
    ).slice(1, -1),
    ...right.reverse(),
    ...arcPts(st[0], st[1], w / 2, as + Math.PI / 2, as - Math.PI / 2, 6).slice(
      1,
      -1
    ),
  ]
}

const mirror = (pts: readonly Pt[]): Pt[] =>
  pts.map(([a, b]): Pt => [-a, b]).reverse()

/** A solid piece: its outline, its front (`z`), its depth and its tone. */
interface Part {
  pts: Pt[]
  z: number
  d: number
  tone: "body" | "lit" | "dark"
}
/** Something drawn on a part's front: a patch or a line. */
interface Deco {
  pts: Pt[]
  z: number
  fill?: ToneRole
  stroke?: ToneRole
  w?: number
  closed?: boolean
}
interface IconSpec {
  parts: Part[]
  deco: Deco[]
  /** Its eyes: on its body, on a screen on it, or (braces) in the air
   *  between its parts, on the page. */
  eyes: EyeAt & { on: "body" | "screen" | "float" }
}

type Icon = Exclude<BotShape, "ring">

const ICONS: Readonly<Record<Icon, () => IconSpec>> = {
  terminal: () => ({
    parts: [{ pts: roundRect(380, 300, 52), z: 0, d: 80, tone: "body" }],
    deco: [
      { pts: roundRect(326, 206, 26, 0, -30), z: 0, fill: "screen" },
      ...[-140, -106, -72].map(
        (x): Deco => ({
          pts: circlePts(11, x, 108, 16),
          z: 0,
          fill: "decoDark",
        })
      ),
      {
        pts: [
          [-128, -82],
          [-104, -100],
          [-128, -118],
        ],
        z: 0,
        stroke: "eyeScreen",
        w: 12,
      },
      {
        pts: [
          [-92, -118],
          [-60, -118],
        ],
        z: 0,
        stroke: "eyeScreen",
        w: 12,
      },
    ],
    eyes: { a: 20, b: -14, sep: 56, k: 0.92, on: "screen" },
  }),
  braces: () => {
    const c = spline(
      [
        [-120, 178],
        [-168, 150],
        [-168, 52],
        [-214, 0],
        [-168, -52],
        [-168, -150],
        [-120, -178],
      ],
      8
    )
    return {
      parts: [
        { pts: strokeOutline(c, 40), z: 0, d: 70, tone: "body" },
        {
          pts: strokeOutline(
            c.map(([a, b]): Pt => [-a, b]),
            40
          ),
          z: 0,
          d: 70,
          tone: "body",
        },
      ],
      deco: [],
      eyes: { a: 0, b: 10, sep: 56, k: 1, on: "float" },
    }
  },
  shield: () => {
    const out = [
      ...spline(
        [
          [-170, 168],
          [-84, 186],
          [0, 198],
          [84, 186],
          [170, 168],
        ],
        6
      ),
      ...spline(
        [
          [170, 168],
          [166, 40],
          [134, -82],
          [64, -162],
          [0, -208],
        ],
        8
      ).slice(1),
      ...spline(
        [
          [0, -208],
          [-64, -162],
          [-134, -82],
          [-166, 40],
          [-170, 168],
        ],
        8
      ).slice(1, -1),
    ]
    const pts = roundPoly(out, 18, 3)
    return {
      parts: [{ pts, z: 0, d: 72, tone: "body" }],
      deco: [
        {
          pts: pts.map(([a, b]): Pt => [a * 0.8, b * 0.8 + 4]),
          z: 0,
          stroke: "decoLit",
          w: 9,
          closed: true,
        },
      ],
      eyes: { a: 0, b: 40, sep: 58, k: 0.95, on: "body" },
    }
  },
  chip: () => {
    const pins: Part[] = []
    for (const i of [-1.5, -0.5, 0.5, 1.5]) {
      for (const [w, h, x, y] of [
        [30, 70, i * 56, 166],
        [30, 70, i * 56, -166],
        [70, 30, 166, i * 56],
        [70, 30, -166, i * 56],
      ]) {
        pins.push({
          pts: roundRect(w, h, 10, x, y),
          z: -12,
          d: 30,
          tone: "lit",
        })
      }
    }
    return {
      parts: [
        ...pins,
        { pts: roundRect(286, 286, 40), z: 0, d: 60, tone: "body" },
      ],
      deco: [
        { pts: roundRect(184, 184, 22), z: 0, fill: "screen" },
        { pts: circlePts(10, -112, -112, 12), z: 0, fill: "decoDark" },
      ],
      eyes: { a: 0, b: 6, sep: 46, k: 0.85, on: "screen" },
    }
  },
  bug: () => {
    const legs: Part[] = []
    for (const [y, dy] of [
      [60, 50],
      [0, 0],
      [-60, -50],
    ]) {
      const l = spline(
        [
          [-90, y],
          [-160, y + dy * 0.5],
          [-190, y + dy * 1.2 - 20],
        ],
        5
      )
      legs.push(
        { pts: strokeOutline(l, 20), z: -30, d: 24, tone: "dark" },
        {
          pts: strokeOutline(mirror(l).reverse(), 20),
          z: -30,
          d: 24,
          tone: "dark",
        }
      )
    }
    const ant = spline(
      [
        [-24, 168],
        [-50, 205],
        [-86, 214],
      ],
      5
    )
    return {
      parts: [
        ...legs,
        { pts: strokeOutline(ant, 14), z: -10, d: 20, tone: "dark" },
        {
          pts: strokeOutline(mirror(ant).reverse(), 14),
          z: -10,
          d: 20,
          tone: "dark",
        },
        { pts: ellipsePts(62, 50, 0, 140, 32), z: -6, d: 60, tone: "dark" },
        { pts: ellipsePts(130, 150, 0, -18, 48), z: 0, d: 74, tone: "body" },
      ],
      deco: [
        {
          pts: [
            [0, 112],
            [0, -150],
          ],
          z: 0,
          stroke: "decoDark",
          w: 8,
        },
      ],
      eyes: { a: 0, b: 48, sep: 54, k: 0.95, on: "body" },
    }
  },
  cursor: () => {
    const raw: Pt[] = [
      [0, 0],
      [0, -16.4],
      [3.9, -12.6],
      [6.7, -19],
      [9.4, -17.8],
      [6.6, -11.6],
      [11.8, -11.6],
    ]
    const pts = raw.map(([x, y]): Pt => [(x - 5.4) * 23, (y + 9.3) * 23])
    return {
      parts: [{ pts: roundPoly(pts, 18), z: 0, d: 70, tone: "body" }],
      deco: [],
      eyes: { a: -52, b: 16, sep: 30, k: 0.78, on: "body" },
    }
  },
  gear: () => ({
    parts: [
      {
        pts: polarPts(
          (t) => 168 + 30 * Math.max(-1, Math.min(1, Math.cos(8 * t) * 2.4)),
          192
        ),
        z: 0,
        d: 70,
        tone: "body",
      },
    ],
    deco: [
      {
        pts: circlePts(112, 0, 0, 48),
        z: 0,
        stroke: "decoLit",
        w: 8,
        closed: true,
      },
    ],
    eyes: { a: 0, b: 8, sep: 52, k: 0.95, on: "body" },
  }),
  file: () => ({
    parts: [
      {
        pts: roundPoly(
          [
            [-145, 200],
            [70, 200],
            [150, 120],
            [150, -200],
            [-145, -200],
          ],
          28
        ),
        z: 0,
        d: 64,
        tone: "body",
      },
    ],
    deco: [
      {
        pts: roundPoly(
          [
            [70, 200],
            [70, 120],
            [150, 120],
          ],
          10
        ),
        z: 0,
        fill: "decoLit",
      },
      { pts: roundRect(130, 22, 11, -40, -74), z: 0, fill: "decoDark" },
      { pts: roundRect(180, 22, 11, -15, -114), z: 0, fill: "decoLit2" },
      { pts: roundRect(96, 22, 11, -57, -154), z: 0, fill: "decoDark" },
    ],
    eyes: { a: 0, b: 50, sep: 54, k: 0.9, on: "body" },
  }),
  magnifier: () => ({
    parts: [
      {
        pts: strokeOutline(
          [
            [62, -58],
            [172, -176],
          ],
          62
        ),
        z: -8,
        d: 50,
        tone: "dark",
      },
      { pts: circlePts(146, -30, 40, 64), z: 0, d: 64, tone: "body" },
    ],
    deco: [
      { pts: circlePts(112, -30, 40, 64), z: 0, fill: "screen" },
      {
        pts: arcPts(-30, 40, 86, 1.95, 2.75, 8),
        z: 0,
        stroke: "glare",
        w: 12,
      },
    ],
    eyes: { a: -30, b: 30, sep: 46, k: 0.86, on: "screen" },
  }),
  package: () => ({
    parts: [
      { pts: roundRect(320, 250, 24, 0, -40), z: 0, d: 80, tone: "body" },
      { pts: roundRect(352, 74, 18, 0, 120), z: 8, d: 36, tone: "lit" },
    ],
    deco: [
      { pts: roundRect(60, 250, 4, 0, -40), z: 0, fill: "decoLit2" },
      { pts: roundRect(60, 74, 4, 0, 120), z: 8, fill: "decoDark" },
    ],
    eyes: { a: 0, b: -40, sep: 76, k: 0.9, on: "body" },
  }),
  rocket: () => {
    const body: Pt[] = [
      ...spline(
        [
          [0, 215],
          [62, 150],
          [86, 40],
          [80, -110],
        ],
        8
      ),
      [64, -140],
      [-64, -140],
      ...spline(
        [
          [-80, -110],
          [-86, 40],
          [-62, 150],
          [0, 215],
        ],
        8
      ).slice(0, -1),
    ]
    const fin: Pt[] = [
      [78, -20],
      [150, -110],
      [150, -165],
      [72, -130],
    ]
    return {
      parts: [
        {
          pts: spline(
            [
              [-36, -150],
              [-30, -200],
              [0, -236],
              [30, -200],
              [36, -150],
            ],
            6
          ),
          z: -16,
          d: 20,
          tone: "lit",
        },
        { pts: roundPoly(fin, 16), z: -10, d: 40, tone: "dark" },
        { pts: roundPoly(mirror(fin), 16), z: -10, d: 40, tone: "dark" },
        { pts: body, z: 0, d: 76, tone: "body" },
      ],
      deco: [
        { pts: circlePts(56, 0, 42, 32), z: 0, fill: "screen" },
        { pts: roundRect(128, 16, 8, 0, -96), z: 0, fill: "decoDark" },
      ],
      eyes: { a: 0, b: 44, sep: 26, k: 0.62, on: "screen" },
    }
  },
  mug: () => {
    const steam = (x: number) =>
      strokeOutline(
        spline(
          [
            [x, 210],
            [x + 24, 180],
            [x, 150],
            [x + 24, 120],
          ],
          5
        ),
        18
      )
    return {
      parts: [
        { pts: steam(-30), z: -20, d: 16, tone: "lit" },
        { pts: steam(50), z: -20, d: 16, tone: "lit" },
        {
          pts: strokeOutline(
            arcPts(120, -10, 74, Math.PI / 2 + 0.2, -Math.PI / 2 - 0.2, 16),
            40
          ),
          z: -6,
          d: 56,
          tone: "body",
        },
        {
          pts: roundPoly(
            [
              [-170, 92],
              [130, 92],
              [114, -170],
              [-154, -170],
            ],
            34
          ),
          z: 0,
          d: 80,
          tone: "body",
        },
      ],
      deco: [{ pts: roundRect(300, 30, 15, -20, 70), z: 0, fill: "decoLit" }],
      eyes: { a: -20, b: -30, sep: 58, k: 0.95, on: "body" },
    }
  },
}

/** An outline made ready to draw: counter-clockwise, each edge's outward
 *  normal on the plane. */
interface Outline {
  a: number[]
  b: number[]
  na: number[]
  nb: number[]
  /** No dent in it: its sides never cover each other. */
  convex: boolean
}

/** Parts at one depth, of one thickness and tone (a chip's pins, a bug's
 *  legs), apart from each other: drawn as one — their sides together, then
 *  their faces — and what is drawn on their front after them. */
interface Batch {
  outlines: Outline[]
  z: number
  d: number
  tone: Part["tone"]
  deco: Deco[]
}

const prepared = new Map<Icon, { batches: Batch[]; eyes: IconSpec["eyes"] }>()

function outline(points: readonly Pt[]): Outline {
  let pts = points
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i]
    const e = pts[(i + 1) % pts.length]
    area += s[0] * e[1] - e[0] * s[1]
  }
  if (area < 0) pts = pts.slice().reverse()
  const na: number[] = []
  const nb: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const ea = pts[j][0] - pts[i][0]
    const eb = pts[j][1] - pts[i][1]
    const l = Math.hypot(ea, eb) || 1
    na.push(eb / l)
    nb.push(-ea / l)
  }
  let convex = true
  for (let i = 0; i < pts.length && convex; i++) {
    const j = (i + 1) % pts.length
    // A bend inward of a degree or so does not show.
    if (na[i] * nb[j] - nb[i] * na[j] < -0.02) convex = false
  }
  return { a: pts.map((q) => q[0]), b: pts.map((q) => q[1]), na, nb, convex }
}

function prepare(shape: Icon) {
  let p = prepared.get(shape)
  if (p) return p
  const spec = ICONS[shape]()
  const batches: Batch[] = []
  for (const part of spec.parts.slice().sort((x, y) => x.z - y.z)) {
    const last = batches[batches.length - 1]
    if (
      last &&
      last.z === part.z &&
      last.d === part.d &&
      last.tone === part.tone
    ) {
      last.outlines.push(outline(part.pts))
    } else {
      batches.push({
        outlines: [outline(part.pts)],
        z: part.z,
        d: part.d,
        tone: part.tone,
        deco: [],
      })
    }
  }
  // Each mark goes on the frontmost batch at its depth, after it.
  for (const dc of spec.deco) {
    for (let i = batches.length - 1; i >= 0; i--) {
      if (batches[i].z === dc.z) {
        batches[i].deco.push(dc)
        break
      }
    }
  }
  p = { batches, eyes: spec.eyes }
  prepared.set(shape, p)
  return p
}

/** The twelve are drawn a little inside the box, as the ring fills it. */
const ICON_SCALE = 0.94
const EDGE_OF: Readonly<Record<Part["tone"], ToneRole>> = {
  body: "edge",
  lit: "edgeLit",
  dark: "edgeDark",
}

function drawIcon(
  shape: Icon,
  pose: FacePose,
  small: boolean,
  paint: FacePaint,
  f: Fmt
): string {
  const spec = prepare(shape)
  let n = pose.n
  const back = n[2] < 0
  if (back) n = scale(n, -1)
  const { u, v } = frame(n)
  const S = ICON_SCALE
  const uL = dot(u, LIGHT)
  const vL = dot(v, LIGHT)
  const on = (a: number, b: number, z: number): Pt => [
    256 + S * (n[0] * z + u[0] * a + v[0] * b),
    256 + S * (n[1] * z + u[1] * a + v[1] * b),
  ]
  let o = ""
  for (const batch of spec.batches) {
    const bx = -S * n[0] * batch.d
    const by = -S * n[1] * batch.d
    const bz = -S * n[2] * batch.d
    // Each outline's front, projected; the sides that face the viewer,
    // each lit by how it turns to the light. A batch's outlines are apart,
    // and a dentless one's sides never cover each other: all those go in
    // two paths, the lit and the others; a dented one's back to front, a
    // run of like-lit ones a path.
    const fronts: { x: number[]; y: number[] }[] = []
    let lit = ""
    let shade = ""
    for (const ol of batch.outlines) {
      const len = ol.a.length
      const x: number[] = new Array(len)
      const y: number[] = new Array(len)
      const z: number[] = new Array(len)
      for (let i = 0; i < len; i++) {
        const a = ol.a[i]
        const b = ol.b[i]
        x[i] = 256 + S * (n[0] * batch.z + u[0] * a + v[0] * b)
        y[i] = 256 + S * (n[1] * batch.z + u[1] * a + v[1] * b)
        z[i] = S * (n[2] * batch.z + u[2] * a + v[2] * b)
      }
      fronts.push({ x, y })
      const quad = (i: number) => {
        const j = (i + 1) % len
        return (
          `M${f(x[i])} ${f(y[i])}L${f(x[j])} ${f(y[j])}` +
          `L${f(x[j] + bx)} ${f(y[j] + by)}L${f(x[i] + bx)} ${f(y[i] + by)}Z`
        )
      }
      const quads: { z: number; i: number; lit: boolean }[] = []
      for (let i = 0; i < len; i++) {
        if (u[2] * ol.na[i] + v[2] * ol.nb[i] <= 0.002) continue
        const isLit = uL * ol.na[i] + vL * ol.nb[i] > 0.3
        if (ol.convex) {
          if (isLit) lit += quad(i)
          else shade += quad(i)
        } else {
          quads.push({
            z: (z[i] + z[(i + 1) % len]) / 2 + bz / 2,
            i,
            lit: isLit,
          })
        }
      }
      quads.sort((p, q) => p.z - q.z)
      let run = ""
      let runLit = false
      for (const q of quads) {
        if (run && q.lit !== runLit) {
          o += sides(run, runLit, paint)
          run = ""
        }
        runLit = q.lit
        run += quad(q.i)
      }
      if (run) o += sides(run, runLit, paint)
    }
    if (shade) o += sides(shade, false, paint)
    if (lit) o += sides(lit, true, paint)
    const face = fronts.map((fr) => pathOf(fr.x, fr.y, f)).join("")
    o += `<path d="${face}" ${fillOf(paint, batch.tone)}/>`
    if (!small) {
      o += `<path d="${face}" ${strokeOf(paint, EDGE_OF[batch.tone])} stroke-width="${f(6 * S)}" stroke-linejoin="round"/>`
    }
    if (back) continue
    for (const dc of batch.deco) {
      if (small && dc.stroke) continue
      const pts = dc.pts.map(([a, b]) => on(a, b, dc.z + 0.5))
      if (dc.fill) {
        o += `<path d="${pathPts(pts, f)}" ${fillOf(paint, dc.fill)}/>`
      } else if (dc.stroke) {
        o +=
          `<path d="${pathPts(pts, f, !!dc.closed)}" ${strokeOf(paint, dc.stroke)} ` +
          `stroke-width="${f((dc.w ?? 8) * S)}" stroke-linecap="round" stroke-linejoin="round"/>`
      }
    }
  }
  return o
}

/** A run of a part's sides: filled and edged in one tone, so no seam shows
 *  between them. */
function sides(d: string, lit: boolean, paint: FacePaint): string {
  return `<path d="${d}" ${bothOf(paint, lit ? "sideLit" : "side")} stroke-width="1.2" stroke-linejoin="round"/>`
}

// ── drawings ────────────────────────────────────────────────────────────

/** A face's eyes for a pose, on its face as its drawing (`faceBody`) lies:
 *  a group of their own (`pa-face-lids`, which the page blinks) — the
 *  ring's seen only through its hole (`id`'s clip). None while its back is
 *  turned. */
export function faceEyes(
  shape: BotShape | string,
  look: BotLook,
  pose: FacePose,
  small: boolean,
  id: string,
  paint: FacePaint = "css"
): string {
  const s = shapeOf(shape)
  const f = small ? coarse : fine
  const n = pose.n
  const ring = s === "ring"
  let eyes = `<g class="pa-face-lids"/>`
  if (n[2] >= 0) {
    const { u, v } = frame(n)
    if (ring) {
      const hh = (small ? RING_H_SMALL : RING_H) / 2
      const to = (a: number, b: number): Pt => [
        256 + n[0] * hh + u[0] * a + v[0] * b,
        256 + n[1] * hh + u[1] * a + v[1] * b,
      ]
      eyes = eyesMarkup(look, pose, RING_EYES, small, to, "eyeHole", paint, f)
    } else {
      const e = prepare(s).eyes
      const S = ICON_SCALE
      const to = (a: number, b: number): Pt => [
        256 + S * (n[0] + u[0] * a + v[0] * b),
        256 + S * (n[1] + u[1] * a + v[1] * b),
      ]
      const role: ToneRole =
        e.on === "float"
          ? "eyeFloat"
          : e.on === "screen"
            ? "eyeScreen"
            : "eyeBody"
      eyes = eyesMarkup(look, pose, e, small, to, role, paint, f)
    }
  }
  return ring ? `<g clip-path="url(#${id}-h)">${eyes}</g>` : eyes
}

/** A face's drawing for a pose but its eyes, as SVG markup in the 512 box.
 *  `id` names its clip paths (unique per drawing on a page). */
export function faceBody(
  shape: BotShape | string,
  pose: FacePose,
  small: boolean,
  id: string,
  paint: FacePaint = "css"
): string {
  const s = shapeOf(shape)
  const f = small ? coarse : fine
  return s === "ring"
    ? drawRing(pose, small, id, paint, f)
    : drawIcon(s, pose, small, paint, f)
}

/** A face's whole drawing for a pose: its body, its eyes over it. */
export function faceMarkup(
  shape: BotShape | string,
  look: BotLook,
  pose: FacePose,
  small: boolean,
  id: string,
  paint: FacePaint = "css"
): string {
  return (
    faceBody(shape, pose, small, id, paint) +
    faceEyes(shape, look, pose, small, id, paint)
  )
}

/** A look's still pose. */
export function restPose(shape: BotShape | string, look: BotLook): FacePose {
  return poseAt(shape, look, 0)
}

/**
 * A face at rest is drawn once for the page per shape, look and size: its
 * body under this id (`restBody`, which the page keeps among its
 * definitions), each face a `<use>` of it with its own eyes over it
 * (`restFace`) — a long list of faces is a few elements each.
 */
export function restId(
  shape: BotShape | string,
  look: BotLook,
  small: boolean
): string {
  return `pa-face-def-${shapeOf(shape)}-${look}-${small ? "s" : "f"}`
}

const restBodies = new Map<string, string>()
const restEyes = new Map<string, string>()

/** The body of a face at rest, its ids from `restId`. */
export function restBody(
  shape: BotShape | string,
  look: BotLook,
  small: boolean
): string {
  const id = restId(shape, look, small)
  let body = restBodies.get(id)
  if (body == null) {
    body = faceBody(shape, restPose(shape, look), small, id)
    restBodies.set(id, body)
  }
  return body
}

/** Whether a pose has its look's body at rest: only its eyes moved. */
export function isRestBody(
  shape: BotShape | string,
  look: BotLook,
  pose: FacePose
): boolean {
  const rest = restPose(shape, look)
  const k = (p: FacePose) =>
    `${p.n[0].toFixed(3)},${p.n[1].toFixed(3)},${p.n[2].toFixed(3)},${p.star.toFixed(2)}`
  return k(rest) === k(pose)
}

/** A face at rest: its look's body (`restBody`, defined on the page) and
 *  its eyes — where `pose` has them, or at rest. */
export function restFace(
  shape: BotShape | string,
  look: BotLook,
  small: boolean,
  pose?: FacePose
): string {
  const id = restId(shape, look, small)
  let eyes = pose ? null : restEyes.get(id)
  if (eyes == null) {
    eyes = faceEyes(shape, look, pose ?? restPose(shape, look), small, id)
    if (!pose) restEyes.set(id, eyes)
  }
  return `<use href="#${id}"/>${eyes}`
}

/** A pose as a key: two poses with one key draw the same. */
export function poseKey(p: FacePose): string {
  return (
    `${p.n[0].toFixed(3)},${p.n[1].toFixed(3)},${p.n[2].toFixed(3)},` +
    `${p.gx.toFixed(1)},${p.gy.toFixed(1)},${p.open.toFixed(2)},${p.star.toFixed(2)}`
  )
}

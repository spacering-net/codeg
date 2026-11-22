/**
 * The thirteen things an assistant can be drawn as (10.6): a ring — the
 * SpaceRing mark, the primary's — and twelve playful things with a ring or
 * a hole in them, its eyes in the hole or on its body.
 *
 * Each is drawn in a 512 × 512 box as a small tree of SVG nodes, in two
 * colours only: the assistant's (`$b`) and the one that reads on it (`$c`,
 * white or near black, as its eyes are), its lit surfaces the colour under
 * a white veil (`$w` at an opacity), its holes see-through. One tree serves
 * the page (`bot-avatar.tsx`, the colours as CSS variables so both themes
 * follow) and the PNGs handed to the desktop (`personal-agent-avatar-png`,
 * the light theme's colours as hex), so the two never drift apart.
 *
 * Every shape comes in two drawings: the full one, for 32px and up, and a
 * small one for less — its textures, its inner wall and its thin lines gone,
 * its bands thicker, its hole a touch smaller and its eyes larger — so a
 * roster row's face still reads.
 *
 * Its parts that move while it works carry a class (`pa-face-spin`,
 * `pa-face-steam`, …); globals.css moves them, and the whole body for the
 * shapes that move as one.
 */

import type { BotShape } from "@/lib/types"

/** A paint: the assistant's colour, the one that reads on it, or white. */
export type Paint = "$b" | "$c" | "$w"

export interface SvgNode {
  /** The element's name. */
  t: string
  /** Its attributes, as SVG spells them (`fill-opacity`, `class`). */
  a: Record<string, string | number>
  c?: SvgNode[]
}

/** Where the eyes are and how they look: in the box's units. */
export interface FaceEyes {
  /** On its body (in the colour that reads on it), in its hole (in its own
   *  colour, seen through), or on a screen painted in the colour that reads
   *  on it (in its own colour, as a display shows them). */
  on: "body" | "hole" | "screen"
  /** The two eyes' centres across, and their centre down. */
  x: readonly [number, number]
  y: number
  /** Half an eye's width and height. */
  rx: number
  ry: number
  /** Their lean, in degrees. */
  tilt: number
  /** Where they can be seen — the hole, or the face of the body they are
   *  on: shapes only, each with its own transform (a clip path holds no
   *  group). */
  window: SvgNode[]
  /** How far they wander, as a share of a face's whole sweep: a small hole
   *  lets them go less far. */
  move: number
}

export interface FaceArt {
  body: SvgNode[]
  eyes: FaceEyes
}

/** The box a shape is drawn in. */
export const ART_BOX = 512

/** The shapes, the primary's first. */
export const BOT_SHAPES: readonly BotShape[] = [
  "ring",
  "stand",
  "donut",
  "gummy",
  "tape",
  "gear",
  "nut",
  "mug",
  "magnet",
  "set_square",
  "cookie",
  "frame",
  "watch",
]

/** The shapes a new assistant is given by default: all but the ring, the
 *  primary's (as the backend's `DEFAULT_SHAPES`, in the same order). */
export const DEFAULT_SHAPES: readonly BotShape[] = BOT_SHAPES.filter(
  (s) => s !== "ring"
)

// ── geometry ────────────────────────────────────────────────────────────

function el(t: string, a: SvgNode["a"], ...c: SvgNode[]): SvgNode {
  return c.length ? { t, a, c } : { t, a }
}

function circle(r: number, a: SvgNode["a"] = {}, cx = 0, cy = 0): SvgNode {
  return el("circle", { cx, cy, r, ...a })
}

function path(d: string, a: SvgNode["a"] = {}): SvgNode {
  return el("path", { d, ...a })
}

function g(a: SvgNode["a"], ...c: SvgNode[]): SvgNode {
  return el("g", a, ...c)
}

const n1 = (v: number) => Math.round(v * 10) / 10

/** A closed outline from its radius at each angle. */
function polar(r: (t: number) => number, n = 180): string {
  const pts: string[] = []
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n
    pts.push(`${n1(r(t) * Math.cos(t))} ${n1(r(t) * Math.sin(t))}`)
  }
  return `M${pts.join("L")}Z`
}

function poly(pts: readonly (readonly [number, number])[]): string {
  return `M${pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join("L")}Z`
}

function regular(n: number, r: number, rot = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (2 * Math.PI * i) / n
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number]
  })
}

/** An ellipse leaning `rot` degrees, as a path. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number, rot = 30) {
  const a = (rot * Math.PI) / 180
  const p1 = [cx + rx * Math.cos(a), cy + rx * Math.sin(a)]
  const p2 = [cx - rx * Math.cos(a), cy - rx * Math.sin(a)]
  return (
    `M${n1(p1[0]!)} ${n1(p1[1]!)}A${n1(rx)} ${n1(ry)} ${rot} 1 0 ${n1(p2[0]!)} ${n1(p2[1]!)}` +
    `A${n1(rx)} ${n1(ry)} ${rot} 1 0 ${n1(p1[0]!)} ${n1(p1[1]!)}Z`
  )
}

/** A seeded generator, so the sprinkles fall the same way every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The SpaceRing mark: its band, the far inner wall seen through it (the
 *  crescent) and the dot on its outer face. */
const RING_OUTER =
  "M447.95 366.91A221.8 192.09 30 0 1 159.82 422.36A221.8 192.09 30 0 1 63.78 145.11A221.8 192.09 30 0 1 351.91 89.66A221.8 192.09 30 0 1 447.95 366.91Z"
const RING_INNER =
  "M416.77 323.09A172.89 149.73 30 0 0 341.91 106.98A172.89 149.73 30 0 0 117.32 150.2A172.89 149.73 30 0 0 192.18 366.31A172.89 149.73 30 0 0 416.77 323.09Z"
const RING_DOT =
  "M188.32 413A20 10 30 0 0 176 394.34A20 10 30 0 0 153.68 393A20 10 30 0 0 166 411.66A20 10 30 0 0 188.32 413Z"
const RING_CRESCENT =
  "M134.69 146.1A160.53 137.37 30 0 1 411.63 305.99A172.89 149.73 30 0 0 134.69 146.1Z"

/** A ring lying as the mark lies: 30° from the page. Round things drawn in
 *  it (a circle of radius r at the origin) come out as the mark's ellipse. */
const LIE = "translate(256 256) rotate(30) scale(1 .866)"

type Id = (name: string) => string

function mask(id: string, content: SvgNode[], x = -400, w = 800): SvgNode {
  return el(
    "mask",
    { id, maskUnits: "userSpaceOnUse", x, y: x, width: w, height: w },
    ...content
  )
}

/** `inner` seen only inside `outer` and outside `hole` (black). */
function holed(
  id: string,
  outer: SvgNode,
  hole: SvgNode,
  inner: SvgNode[],
  x = -400,
  w = 800
): SvgNode[] {
  return [mask(id, [outer, hole], x, w), g({ mask: `url(#${id})` }, ...inner)]
}

/** The far inner wall seen through a round hole of radius h: a crescent
 *  of the colour, parted from the band by a gap, as the mark draws it. */
function innerWall(id: string, h: number): SvgNode[] {
  return [
    mask(id, [
      circle(h * 0.9, { fill: "#fff" }),
      circle(h * 1.02, { fill: "#000" }, 0, h * 0.32),
    ]),
    g({ mask: `url(#${id})` }, circle(h, { fill: "$b" })),
  ]
}

/** A bounding box for a part that turns round the origin. */
function anchor(r: number): SvgNode {
  return circle(r, { fill: "none" })
}

// ── the eyes in a round hole ────────────────────────────────────────────

function holeEyes(h: number, small: boolean, transform = LIE): FaceEyes {
  return small
    ? {
        on: "hole",
        x: [218, 294],
        y: 262,
        rx: 23,
        ry: 40,
        tilt: -10,
        window: [circle(h, { transform })],
        move: 0.45,
      }
    : {
        on: "hole",
        x: [208, 294],
        y: 288,
        rx: 22,
        ry: 38,
        tilt: -10,
        window: [circle(h, { transform })],
        move: 0.45,
      }
}

// ── the shapes ──────────────────────────────────────────────────────────

type Builder = (small: boolean, id: Id) => FaceArt

const ring: Builder = (small) => {
  const body = small
    ? [
        path(
          RING_OUTER +
            ellipsePath(267.04, 236.65, 172.89 * 0.84, 149.73 * 0.84),
          { "fill-rule": "evenodd", fill: "$b" }
        ),
      ]
    : [
        path(RING_OUTER + RING_INNER + RING_DOT, {
          "fill-rule": "evenodd",
          fill: "$b",
        }),
        path(RING_CRESCENT, { fill: "$b" }),
      ]
  return {
    body,
    eyes: {
      on: "hole",
      x: small ? [198, 304] : [200, 300],
      y: small ? 268 : 270,
      rx: small ? 36 : 27,
      ry: small ? 62 : 50,
      tilt: -12,
      window: [path(RING_INNER)],
      move: 0.8,
    },
  }
}

const stand: Builder = (small) => {
  const upright =
    "translate(256 236) rotate(60) scale(.86) translate(-256 -256)"
  const band = small
    ? [
        path(
          RING_OUTER +
            ellipsePath(267.04, 236.65, 172.89 * 0.82, 149.73 * 0.82),
          { "fill-rule": "evenodd", fill: "$b" }
        ),
      ]
    : [
        path(RING_OUTER + RING_INNER + RING_DOT, {
          "fill-rule": "evenodd",
          fill: "$b",
        }),
        path(RING_CRESCENT, { fill: "$b" }),
      ]
  const fh = small ? 40 : 30
  const foot = (x: number, cls: string) =>
    el("rect", {
      x,
      y: 428 - fh / 2,
      width: 64,
      height: fh,
      rx: fh / 2,
      fill: "$b",
      class: cls,
    })
  return {
    body: [
      foot(168, "pa-face-step-a"),
      foot(280, "pa-face-step-b"),
      g({ transform: upright }, ...band),
    ],
    eyes: {
      on: "hole",
      x: small ? [208, 304] : [214, 298],
      y: small ? 246 : 250,
      rx: small ? 34 : 27,
      ry: small ? 60 : 50,
      tilt: 0,
      window: [path(RING_INNER, { transform: upright })],
      move: 0.8,
    },
  }
}

const DONUT_GLAZE = polar(
  (t) => 188 + 10 * Math.sin(7 * t) + (Math.sin(5 * t + 1) > 0.82 ? 26 : 0)
)

const DONUT_SPRINKLES: SvgNode[] = (() => {
  const rnd = seeded(3)
  return Array.from({ length: 16 }, (_, i) => {
    const t = (2 * Math.PI * (i + rnd() * 0.6)) / 16
    const r = 135 + rnd() * 45
    const x = r * Math.cos(t)
    const y = r * Math.sin(t)
    return el("rect", {
      x: n1(x - 17),
      y: n1(y - 5.5),
      width: 34,
      height: 11,
      rx: 5.5,
      fill: "$c",
      "fill-opacity": 0.85,
      transform: `rotate(${Math.round(rnd() * 180)} ${n1(x)} ${n1(y)})`,
    })
  })
})()

const donut: Builder = (small, id) => {
  const R = 222
  const h = small ? 96 : 104
  const glaze = g(
    { class: "pa-face-roll" },
    anchor(R),
    path(DONUT_GLAZE + polar(() => h + 6), {
      "fill-rule": "evenodd",
      fill: "$b",
    }),
    ...(small ? [] : DONUT_SPRINKLES)
  )
  return {
    body: [
      g(
        { transform: LIE },
        ...holed(
          id("band"),
          circle(R, { fill: "#fff" }),
          circle(h, { fill: "#000" }),
          [
            circle(R, { fill: "$b" }),
            circle(R, { fill: "$w", "fill-opacity": 0.5 }),
            glaze,
          ]
        ),
        ...(small ? [] : innerWall(id("wall"), h))
      ),
    ],
    eyes: holeEyes(h, small),
  }
}

const GUMMY_EDGE = polar((t) => 212 + 10 * Math.cos(14 * t), 280)

const GUMMY_SUGAR: SvgNode[] = (() => {
  const rnd = seeded(2)
  return Array.from({ length: 54 }, () => {
    const t = rnd() * 2 * Math.PI
    const r = 120 + rnd() * 84
    const x = r * Math.cos(t)
    const y = r * Math.sin(t)
    return el("rect", {
      x: n1(x - 4.5),
      y: n1(y - 4.5),
      width: 9,
      height: 9,
      fill: "$w",
      "fill-opacity": 0.9,
      transform: `rotate(45 ${n1(x)} ${n1(y)})`,
    })
  })
})()

const gummy: Builder = (small, id) => {
  const h = small ? 102 : 112
  const inner: SvgNode[] = [
    circle(224, { fill: "$b" }),
    path(polar(() => 168) + polar(() => h), {
      "fill-rule": "evenodd",
      fill: "$w",
      "fill-opacity": 0.4,
    }),
  ]
  if (!small) {
    inner.push(
      ...GUMMY_SUGAR,
      path("M-160 -110A200 200 0 0 1 90 -185", {
        fill: "none",
        stroke: "$w",
        "stroke-opacity": 0.6,
        "stroke-width": 16,
        "stroke-linecap": "round",
      })
    )
  }
  return {
    body: [
      g(
        { transform: LIE },
        ...holed(
          id("band"),
          path(GUMMY_EDGE, { fill: "#fff" }),
          circle(h, { fill: "#000" }),
          inner
        ),
        ...(small ? [] : innerWall(id("wall"), h))
      ),
    ],
    eyes: holeEyes(h, small),
  }
}

const tape: Builder = (small, id) => {
  const R = 214
  const h = small ? 110 : 118
  const core = small ? 136 : 142
  const inner: SvgNode[] = [circle(R, { fill: "$b" })]
  if (!small) {
    for (let r = core + 16; r < R; r += 16) {
      inner.push(
        circle(r, {
          fill: "none",
          stroke: "$w",
          "stroke-opacity": 0.4,
          "stroke-width": 4,
        })
      )
    }
  }
  // Where the tape's last turn ends: it goes round as the roll turns.
  inner.push(
    g(
      { class: "pa-face-reel" },
      anchor(R),
      path(`M${R - 34} 0H${R + 4}`, {
        stroke: "$w",
        "stroke-opacity": 0.7,
        "stroke-width": small ? 12 : 8,
        "stroke-linecap": "round",
      })
    ),
    circle(core, { fill: "$w", "fill-opacity": 0.55 })
  )
  // Its loose end hangs from the roll's side, cut in a zigzag, its sticky
  // back a shade lighter.
  const tw = small ? 64 : 54
  const zig =
    `L${Math.round(462 - tw * 0.25)} 428L${Math.round(462 - tw * 0.5)} 446` +
    `L${Math.round(462 - tw * 0.75)} 428L${462 - tw} 446`
  const tail = `M462 250V446${zig}V250Z`
  return {
    body: [
      g(
        { class: "pa-face-pull" },
        path(tail, { fill: "$b" }),
        path(tail, { fill: "$w", "fill-opacity": 0.35 })
      ),
      g(
        { transform: LIE },
        ...holed(
          id("band"),
          circle(R, { fill: "#fff" }),
          circle(h, { fill: "#000" }),
          inner
        ),
        ...(small ? [] : innerWall(id("wall"), h))
      ),
    ],
    eyes: holeEyes(h, small),
  }
}

const GEAR_TEETH = polar((t) => 200 + (Math.cos(10 * t) > 0.15 ? 26 : -2), 400)
const GEAR_TEETH_SMALL = polar(
  (t) => 200 + (Math.cos(8 * t) > 0.15 ? 34 : -2),
  400
)

const gear: Builder = (small, id) => {
  const h = small ? 96 : 104
  return {
    body: [
      g(
        { transform: LIE },
        g(
          { class: "pa-face-spin" },
          anchor(234),
          ...holed(
            id("band"),
            path(small ? GEAR_TEETH_SMALL : GEAR_TEETH, { fill: "#fff" }),
            circle(h, { fill: "#000" }),
            [
              circle(260, { fill: "$b" }),
              ...(small
                ? []
                : [
                    circle(150, {
                      fill: "none",
                      stroke: "$w",
                      "stroke-opacity": 0.35,
                      "stroke-width": 8,
                    }),
                  ]),
            ]
          )
        ),
        ...(small ? [] : innerWall(id("wall"), h))
      ),
    ],
    eyes: holeEyes(h, small),
  }
}

const NUT_OUTLINE = poly(regular(6, 228, Math.PI / 6))

const nut: Builder = (small, id) => {
  const h = small ? 92 : 100
  const turning = g(
    { class: "pa-face-tighten" },
    anchor(228),
    ...holed(
      id("band"),
      path(NUT_OUTLINE, { fill: "#fff" }),
      circle(h, { fill: "#000" }),
      [
        path(NUT_OUTLINE, { fill: "$b" }),
        ...(small
          ? []
          : [
              circle(196, {
                fill: "none",
                stroke: "$w",
                "stroke-opacity": 0.35,
                "stroke-width": 8,
              }),
            ]),
      ]
    )
  )
  const parts: SvgNode[] = [turning]
  if (!small) {
    parts.push(...innerWall(id("wall"), h))
    // The thread on the wall.
    const threads: SvgNode[] = []
    for (let y = -96; y < -40; y += 18) {
      threads.push(
        path(`M${-h} ${y}Q0 ${y - 22} ${h} ${y}`, {
          fill: "none",
          stroke: "$w",
          "stroke-opacity": 0.5,
          "stroke-width": 6,
        })
      )
    }
    parts.push(
      mask(id("thread"), [
        circle(h * 0.9, { fill: "#fff" }),
        circle(h * 1.02, { fill: "#000" }, 0, h * 0.32),
      ]),
      g({ mask: `url(#${id("thread")})` }, ...threads)
    )
  }
  const eyes = holeEyes(h, small)
  return {
    body: [g({ transform: LIE }, ...parts)],
    eyes: small ? eyes : { ...eyes, x: [210, 296] },
  }
}

const MUG_BODY =
  "M104 190H368V392C368 432 340 456 300 456H172C132 456 104 432 104 392Z"

const mug: Builder = (small) => {
  const lean = "rotate(-6 256 300)"
  const parts: SvgNode[] = [
    path("M352 236C452 230 462 380 352 376", {
      fill: "none",
      stroke: "$b",
      "stroke-width": small ? 58 : 44,
      "stroke-linecap": "round",
    }),
    path(MUG_BODY, { fill: "$b" }),
    el("ellipse", { cx: 236, cy: 190, rx: 132, ry: 34, fill: "$b" }),
    el("ellipse", {
      cx: 236,
      cy: 192,
      rx: 112,
      ry: 24,
      fill: "$c",
      "fill-opacity": 0.55,
    }),
  ]
  if (!small) {
    parts.push(
      path("M126 222V380", {
        stroke: "$w",
        "stroke-opacity": 0.35,
        "stroke-width": 14,
        "stroke-linecap": "round",
      }),
      ...[196, 252].map((x, i) =>
        path(`M${x} 150C${x - 22} 120 ${x + 22} 100 ${x} 66`, {
          fill: "none",
          stroke: "$b",
          "stroke-opacity": 0.6,
          "stroke-width": 12,
          "stroke-linecap": "round",
          class: i ? "pa-face-steam pa-face-steam-late" : "pa-face-steam",
        })
      )
    )
  }
  return {
    body: [g({ transform: lean }, ...parts)],
    eyes: {
      on: "body",
      x: small ? [196, 282] : [196, 280],
      y: small ? 316 : 312,
      rx: small ? 28 : 22,
      ry: small ? 50 : 40,
      tilt: -6,
      window: [path(MUG_BODY, { transform: lean })],
      move: 0.8,
    },
  }
}

const MAGNET_U =
  "M120 90V270C120 345 181 406 256 406C331 406 392 345 392 270V90"

const magnet: Builder = (small) => {
  const lean = "rotate(-10 256 256)"
  const tip = (x: number) => [
    el("rect", { x, y: 56, width: 104, height: 70, fill: "$c" }),
    el("rect", {
      x,
      y: 56,
      width: 104,
      height: 70,
      fill: "$b",
      "fill-opacity": 0.25,
    }),
    el("rect", {
      x,
      y: 56,
      width: 104,
      height: 70,
      fill: "none",
      stroke: "$b",
      "stroke-width": 10,
    }),
  ]
  const parts: SvgNode[] = [
    path(MAGNET_U, {
      fill: "none",
      stroke: "$b",
      "stroke-width": small ? 116 : 104,
    }),
    ...tip(68),
    ...tip(340),
  ]
  if (!small) {
    parts.push(
      path("M92 160V270", {
        stroke: "$w",
        "stroke-opacity": 0.35,
        "stroke-width": 14,
        "stroke-linecap": "round",
      })
    )
  }
  const sparks = g(
    { class: "pa-face-spark" },
    ...["M220 40L240 70", "M256 30V64", "M292 40L272 70"].map((d) =>
      path(d, {
        stroke: "$b",
        "stroke-width": small ? 16 : 10,
        "stroke-linecap": "round",
      })
    )
  )
  return {
    body: [sparks, g({ transform: lean }, ...parts)],
    eyes: {
      on: "body",
      x: small ? [218, 304] : [222, 300],
      y: 398,
      rx: small ? 27 : 21,
      ry: small ? 44 : 38,
      tilt: -10,
      // The foot of the U, where they are.
      window: [
        path("M62 270A194 194 0 0 0 450 270H336A80 80 0 0 1 176 270Z", {
          transform: lean,
        }),
      ],
      move: 0.4,
    },
  }
}

const SQUARE_OUTER = poly([
  [70, 70],
  [70, 450],
  [450, 450],
])

const setSquare: Builder = (small, id) => {
  const hole = small
    ? poly([
        [136, 212],
        [136, 396],
        [320, 396],
      ])
    : poly([
        [132, 214],
        [132, 396],
        [314, 396],
      ])
  const inner: SvgNode[] = [el("rect", { width: 512, height: 512, fill: "$b" })]
  if (!small) {
    for (let i = 0, y = 96; y < 440; i++, y += 22) {
      inner.push(
        path(`M50 ${y}H${i % 2 ? 80 : 96}`, {
          stroke: "$c",
          "stroke-opacity": 0.6,
          "stroke-width": 6,
        })
      )
    }
    inner.push(
      path("M140 150L400 420", {
        stroke: "$w",
        "stroke-opacity": 0.3,
        "stroke-width": 10,
      })
    )
  }
  return {
    body: holed(
      id("body"),
      path(SQUARE_OUTER, {
        fill: "#fff",
        stroke: "#fff",
        "stroke-width": 40,
        "stroke-linejoin": "round",
      }),
      path(hole, {
        fill: "#000",
        stroke: "#000",
        "stroke-width": 24,
        "stroke-linejoin": "round",
      }),
      inner,
      0,
      512
    ),
    eyes: {
      on: "hole",
      x: small ? [172, 218] : [168, 212],
      y: 352,
      rx: small ? 21 : 18,
      ry: small ? 36 : 34,
      tilt: 0,
      window: [path(hole)],
      move: 0.4,
    },
  }
}

const STAR = poly(
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? 235 : 130
    const a = -Math.PI / 2 + (Math.PI * i) / 5
    return [r * Math.cos(a), r * Math.sin(a)] as const
  })
)

const cookie: Builder = (small, id) => {
  const hr = small ? 92 : 88
  const place = "translate(256 262) rotate(-8) scale(1 .92)"
  const inner: SvgNode[] = [
    path(STAR, {
      fill: "$b",
      stroke: "$b",
      "stroke-width": 40,
      "stroke-linejoin": "round",
    }),
  ]
  if (!small) {
    // Its icing, piped round its edge.
    inner.push(
      path(STAR, {
        fill: "none",
        stroke: "$c",
        "stroke-opacity": 0.7,
        "stroke-width": 10,
        "stroke-dasharray": "26 18",
        "stroke-linejoin": "round",
        transform: "scale(.8)",
      })
    )
  }
  return {
    body: [
      g(
        { transform: place },
        g(
          { class: "pa-face-twist" },
          anchor(255),
          ...holed(
            id("body"),
            path(STAR, {
              fill: "#fff",
              stroke: "#fff",
              "stroke-width": 40,
              "stroke-linejoin": "round",
            }),
            circle(hr, { fill: "#000" }),
            inner
          )
        ),
        ...(small ? [] : innerWall(id("wall"), hr))
      ),
    ],
    eyes: {
      on: "hole",
      x: small ? [222, 290] : [226, 286],
      y: small ? 266 : 268,
      rx: small ? 22 : 18,
      ry: small ? 38 : 32,
      tilt: 0,
      window: [circle(hr, { transform: place })],
      move: 0.45,
    },
  }
}

const frame: Builder = (small, id) => {
  const t = small ? 92 : 72
  const lean = "rotate(-8 256 256)"
  const inner: SvgNode[] = [el("rect", { width: 512, height: 512, fill: "$b" })]
  if (!small) {
    inner.push(
      path("M70 80L142 152M442 80L370 152M70 432L142 360M442 432L370 360", {
        stroke: "$w",
        "stroke-opacity": 0.35,
        "stroke-width": 6,
      }),
      el("rect", {
        x: 96,
        y: 106,
        width: 320,
        height: 300,
        rx: 14,
        fill: "none",
        stroke: "$w",
        "stroke-opacity": 0.35,
        "stroke-width": 6,
      })
    )
  }
  const window = {
    x: 70 + t,
    y: 80 + t,
    width: 372 - 2 * t,
    height: 352 - 2 * t,
    rx: 8,
  }
  return {
    body: [
      g(
        { transform: lean },
        ...holed(
          id("body"),
          el("rect", {
            x: 70,
            y: 80,
            width: 372,
            height: 352,
            rx: 26,
            fill: "#fff",
          }),
          el("rect", { ...window, fill: "#000" }),
          inner,
          0,
          512
        ),
        // The wire it hangs by, and its nail.
        path("M256 40L200 80M256 40L312 80", {
          fill: "none",
          stroke: "$b",
          "stroke-width": small ? 14 : 8,
          "stroke-linecap": "round",
        }),
        circle(small ? 14 : 10, { fill: "$b" }, 256, 40)
      ),
    ],
    eyes: {
      on: "hole",
      x: small ? [212, 300] : [210, 300],
      y: 262,
      rx: small ? 28 : 24,
      ry: small ? 48 : 44,
      tilt: -8,
      window: [el("rect", { ...window, transform: lean })],
      move: 0.6,
    },
  }
}

const watch: Builder = (small) => {
  const sw = small ? 172 : 156
  const l = 256 - sw / 2
  const r = 256 + sw / 2
  const straps = [
    `M${l} 140V64Q${l} 30 ${l + 34} 30H${r - 34}Q${r} 30 ${r} 64V140Z`,
    `M${l} 372V448Q${l} 482 ${l + 34} 482H${r - 34}Q${r} 482 ${r} 448V372Z`,
  ]
  const parts: SvgNode[] = [
    ...straps.map((d) => path(d, { fill: "$b" })),
    ...straps.map((d) => path(d, { fill: "$w", "fill-opacity": 0.42 })),
  ]
  if (!small) parts.push(circle(9, { fill: "$b" }, 256, 440))
  // The keeper: a loop round the lower strap, in the full colour — its ring.
  parts.push(
    el("rect", {
      x: l - 12,
      y: small ? 404 : 408,
      width: sw + 24,
      height: small ? 30 : 24,
      rx: 12,
      fill: "$b",
    }),
    el("rect", {
      x: 400,
      y: small ? 214 : 220,
      width: small ? 32 : 26,
      height: small ? 70 : 58,
      rx: 12,
      fill: "$b",
    })
  )
  if (!small) {
    parts.push(
      el("rect", { x: 402, y: 300, width: 18, height: 34, rx: 8, fill: "$b" })
    )
  }
  const screen = { x: 126, y: 148, width: 256, height: 216, rx: 70 }
  parts.push(
    el("rect", { x: 100, y: 122, width: 308, height: 268, rx: 92, fill: "$b" }),
    el("rect", { ...screen, fill: "$c" }),
    // A mark running round the screen's edge while it works.
    el("rect", {
      x: 146,
      y: 168,
      width: 216,
      height: 176,
      rx: 54,
      fill: "none",
      stroke: "$b",
      "stroke-width": 10,
      "stroke-linecap": "round",
      "stroke-dasharray": "152 540",
      class: "pa-face-progress",
    })
  )
  return {
    body: parts,
    eyes: {
      on: "screen",
      x: small ? [210, 302] : [212, 300],
      y: 258,
      rx: small ? 31 : 26,
      ry: small ? 52 : 46,
      tilt: 0,
      window: [el("rect", screen)],
      move: 0.8,
    },
  }
}

const BUILDERS: Record<BotShape, Builder> = {
  ring,
  stand,
  donut,
  gummy,
  tape,
  gear,
  nut,
  mug,
  magnet,
  set_square: setSquare,
  cookie,
  frame,
  watch,
}

/** A shape's drawing; one codeg no longer draws (a face saved before) is
 *  drawn as the donut. `id` makes its masks' ids, unique per face. */
export function faceArt(
  shape: BotShape | string,
  small: boolean,
  id: Id
): FaceArt {
  const build = Object.prototype.hasOwnProperty.call(BUILDERS, shape)
    ? BUILDERS[shape as BotShape]
    : BUILDERS.donut
  return build(small, id)
}

/** Below this size, in px, a face is drawn small. */
export const SMALL_FACE_BELOW = 32

// ── the eyes ────────────────────────────────────────────────────────────

/** The looks a face's eyes take (as `BotLook`). */
export type EyeLook =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "stuck"
  | "done"
  | "failed"
  | "sleeping"

function capsule(cx: number, cy: number, w: number, h: number): SvgNode {
  return el("rect", {
    x: n1(cx - w / 2),
    y: n1(cy - h / 2),
    width: n1(w),
    height: n1(h),
    rx: n1(Math.min(w, h) / 2),
    fill: "currentColor",
  })
}

/** The two eyes for a look, in the box's units, in `currentColor`; leaned
 *  as the shape leans them. `squint` shuts them to that share (a blink). */
export function eyeNodes(
  eyes: Pick<FaceEyes, "x" | "y" | "rx" | "ry" | "tilt">,
  look: EyeLook,
  squint = 1
): SvgNode {
  const w = eyes.rx * 2
  const h = eyes.ry * 2
  const y = eyes.y
  const each = (cx: number, i: number): SvgNode => {
    switch (look) {
      case "thinking":
        return capsule(cx, y, w * 0.944, h * 0.85 * squint)
      case "working":
        return capsule(cx, y, w * 0.89, h * 0.6 * squint)
      case "waiting":
        return capsule(cx, y, w * 1.11, h * 1.05 * squint)
      case "stuck":
        // Lids half down: the lower half of each eye, its top flat.
        return path(
          `M${n1(cx - w / 2)} ${y}H${n1(cx + w / 2)}V${n1(y + h / 2 - w / 2)}` +
            `A${n1(w / 2)} ${n1(w / 2)} 0 0 1 ${n1(cx - w / 2)} ${n1(y + h / 2 - w / 2)}Z`,
          { fill: "currentColor" }
        )
      case "done":
        // Curved up into a smile.
        return path(
          `M${n1(cx - w * 0.67)} ${n1(y + h * 0.15)}Q${cx} ${n1(y - h * 0.35)} ` +
            `${n1(cx + w * 0.67)} ${n1(y + h * 0.15)}`,
          {
            fill: "none",
            stroke: "currentColor",
            "stroke-width": n1(w / 2),
            "stroke-linecap": "round",
          }
        )
      case "failed":
        // Drooping: tilted in at the top.
        return el("rect", {
          x: n1(cx - w * 0.445),
          y: n1(y - h * 0.325),
          width: n1(w * 0.89),
          height: n1(h * 0.65),
          rx: n1(w * 0.445),
          fill: "currentColor",
          transform: `rotate(${i === 0 ? 18 : -18} ${cx} ${y})`,
        })
      case "sleeping":
        // Shut: two arcs curving down.
        return path(
          `M${n1(cx - w * 0.61)} ${y}Q${cx} ${n1(y + h * 0.275)} ${n1(cx + w * 0.61)} ${y}`,
          {
            fill: "none",
            stroke: "currentColor",
            "stroke-width": n1(w * 0.39),
            "stroke-linecap": "round",
          }
        )
      case "idle":
      default:
        return capsule(cx, y, w, h * squint)
    }
  }
  const mx = (eyes.x[0] + eyes.x[1]) / 2
  return g(
    eyes.tilt ? { transform: `rotate(${eyes.tilt} ${mx} ${y})` } : {},
    each(eyes.x[0], 0),
    each(eyes.x[1], 1)
  )
}

// ── as markup ───────────────────────────────────────────────────────────

const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
}

/** A node as SVG markup, its paints as the colours given — still, as a
 *  picture is: what shows only while it works (`pa-face-progress`) left
 *  out. */
export function nodeMarkup(
  node: SvgNode,
  paint: Record<Paint, string>
): string {
  if (String(node.a.class ?? "").includes("pa-face-progress")) return ""
  const attrs = Object.entries(node.a)
    .map(([k, v]) => {
      const value =
        typeof v === "string" && v in paint ? paint[v as Paint] : String(v)
      return ` ${k}="${value.replace(/[&"<]/g, (c) => ATTR_ESCAPES[c] ?? c)}"`
    })
    .join("")
  const kids = (node.c ?? []).map((k) => nodeMarkup(k, paint)).join("")
  return kids
    ? `<${node.t}${attrs}>${kids}</${node.t}>`
    : `<${node.t}${attrs}/>`
}

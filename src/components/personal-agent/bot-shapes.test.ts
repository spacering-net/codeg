import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import type { BotLook } from "@/lib/types"

import {
  BOT_SHAPES,
  DEFAULT_SHAPES,
  FACE_COLORS,
  TONE_ROLES,
  contrast,
  faceMarkup,
  faceToneCss,
  faceTones,
  isMoving,
  poseAt,
  poseKey,
  isRestBody,
  restBody,
  restFace,
  restPose,
  shapeOf,
} from "./bot-shapes"

const rust = readFileSync(
  join(process.cwd(), "src-tauri/src/models/personal_agent_bots.rs"),
  "utf8"
)

/** A `pub const NAME: [&str; n] = [...]` of the backend, as a list. */
function rustList(name: string): string[] {
  const at = rust.indexOf(`const ${name}:`)
  const body = rust.slice(
    rust.indexOf("[", rust.indexOf("=", at)),
    rust.indexOf("];", at)
  )
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

const LOOKS: BotLook[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "stuck",
  "done",
  "failed",
  "sleeping",
]

/** A shape's whole drawing at rest, as one face of its own draws it. */
function rest(shape: string, small: boolean, id = "x"): string {
  return faceMarkup(shape, "idle", restPose(shape, "idle"), small, id)
}

/** A drawing as a document, to look into. */
function parse(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
    "image/svg+xml"
  )
  expect(doc.querySelector("parsererror")).toBeNull()
  return doc.documentElement as unknown as SVGSVGElement
}

describe("the shapes an assistant is drawn as", () => {
  it("are the backend's, the primary's ring kept out of the defaults", () => {
    expect([...BOT_SHAPES]).toEqual(rustList("BOT_SHAPES"))
    expect([...DEFAULT_SHAPES]).toEqual(rustList("DEFAULT_SHAPES"))
    expect(DEFAULT_SHAPES).not.toContain("ring")
    expect(BOT_SHAPES).toHaveLength(13)
  })

  it("reads a shape since renamed as the backend does, any other as the terminal", () => {
    const renamed = [
      ...rust
        .slice(rust.indexOf("const RENAMED_SHAPES"))
        .matchAll(/\("(\w+)", "(\w+)"\)/g),
    ]
    expect(renamed).toHaveLength(10)
    for (const [, was, now] of renamed) expect(shapeOf(was!), was).toBe(now)
    for (const s of BOT_SHAPES) expect(shapeOf(s)).toBe(s)
    for (const name of ["pebble", "constructor", "toString", "__proto__"]) {
      expect(shapeOf(name), name).toBe("terminal")
    }
  })
})

describe("a drawing", () => {
  it.each(BOT_SHAPES)(
    "of %s is whole in every look, full and small",
    (shape) => {
      for (const small of [false, true]) {
        for (const look of LOOKS) {
          const svg = parse(
            faceMarkup(shape, look, restPose(shape, look), small, "x")
          )
          // Its two eyes, in a group of their own.
          const lids = svg.querySelectorAll(".pa-face-lids")
          expect(lids, `${look}`).toHaveLength(1)
          expect(lids[0]!.children, `${look}`).toHaveLength(2)
          // Painted by its tones only.
          for (const el of svg.querySelectorAll("[class]")) {
            for (const c of el.getAttribute("class")!.split(/\s+/)) {
              expect(c).toMatch(/^(pa-[fs]-[a-z0-9-]+|pa-face-lids)$/)
            }
          }
          // Every clip it uses, it defines, under its own id.
          const ids = [...svg.querySelectorAll("[id]")].map((e) => e.id)
          for (const id of ids) expect(id.startsWith("x-")).toBe(true)
          expect(new Set(ids).size).toBe(ids.length)
          for (const el of svg.querySelectorAll("[clip-path]")) {
            const ref = el.getAttribute("clip-path")!.slice(5, -1)
            expect(ids).toContain(ref)
          }
        }
      }
    }
  )

  it("is some tens of elements, fewer small, so a face that moves draws cheaply", () => {
    for (const shape of BOT_SHAPES) {
      const full = parse(rest(shape, false))
      const small = parse(rest(shape, true))
      const count = (s: SVGSVGElement) => s.querySelectorAll("*").length
      expect(count(full), shape).toBeLessThan(70)
      expect(count(small), shape).toBeLessThanOrEqual(count(full))
      // Small: no edges, no thin lines.
      expect(small.querySelector("[class*='pa-s-edge'], .pa-s-rim")).toBeNull()
      expect(
        full.querySelector("[class*='pa-s-edge'], .pa-s-rim"),
        shape
      ).not.toBeNull()
    }
  })

  it("keeps the ring's eyes in its hole, its star on its band", () => {
    const svg = parse(rest("ring", false, "r"))
    const lids = svg.querySelector(".pa-face-lids")!
    expect(lids.parentElement!.getAttribute("clip-path")).toBe("url(#r-h)")
    expect(svg.querySelectorAll(".pa-f-star")).toHaveLength(1)
    // Drawn small, no star.
    const small = parse(rest("ring", true, "r"))
    expect(small.querySelector(".pa-f-star")).toBeNull()
  })

  it("paints each shape's eyes in the paint that reads where they are", () => {
    const eyesOf = (shape: string) =>
      parse(rest(shape, false))
        .querySelector(".pa-face-lids path")!
        .getAttribute("class")
    expect(eyesOf("mug")).toBe("pa-f-eye-body")
    expect(eyesOf("terminal")).toBe("pa-f-eye-screen")
    expect(eyesOf("ring")).toBe("pa-f-eye-hole")
    expect(eyesOf("braces")).toBe("pa-f-eye-float")
  })

  it("draws a picture in a theme's hex, the same drawing", () => {
    const tones = faceTones("teal", "light")
    const css = faceMarkup("mug", "idle", restPose("mug", "idle"), false, "x")
    const hex = faceMarkup(
      "mug",
      "idle",
      restPose("mug", "idle"),
      false,
      "x",
      tones
    )
    expect(hex).not.toMatch(/class="pa-[fs]-/)
    expect(hex).toContain(`fill="${tones.body}"`)
    expect(css.match(/<path/g)!.length).toBe(hex.match(/<path/g)!.length)
  })

  it("at rest is the page's drawing, each face its own eyes over it", () => {
    const id = "pa-face-def-ring-idle-f"
    const face = restFace("ring", "idle", false)
    expect(face.startsWith(`<use href="#${id}"/>`)).toBe(true)
    // The eyes seen through the hole the page's drawing defines.
    expect(face).toContain(`clip-path="url(#${id}-h)"`)
    expect(restBody("ring", "idle", false)).toContain(`id="${id}-h"`)
    expect(restBody("ring", "idle", false)).not.toContain("pa-face-lids")
    // Once per shape, look and size.
    expect(restBody("ring", "idle", false)).toBe(
      restBody("ring", "idle", false)
    )
    expect(restFace("gear", "idle", true)).toContain(
      '<use href="#pa-face-def-gear-idle-s"/>'
    )
    // A glance moves its eyes only; the pointer turns it.
    const glance = poseAt("gear", "idle", 0, null, [14, 0])
    expect(isRestBody("gear", "idle", glance)).toBe(true)
    expect(restFace("gear", "idle", false, glance)).not.toBe(
      restFace("gear", "idle", false)
    )
    expect(isRestBody("gear", "idle", poseAt("gear", "idle", 0, [2, 0]))).toBe(
      false
    )
  })
})

describe("a face's colours", () => {
  /** The page behind a face, light and dark. */
  const PAGE = { light: "#ffffff", dark: "#0a0a0a" } as const

  it.each(FACE_COLORS)("let its eyes be seen on %s, in either theme", (c) => {
    for (const theme of ["light", "dark"] as const) {
      const t = faceTones(c, theme)
      expect(contrast(t.eyeBody, t.body), theme).toBeGreaterThanOrEqual(3)
      expect(contrast(t.eyeScreen, t.screen), theme).toBeGreaterThanOrEqual(3)
      expect(contrast(t.eyeHole, PAGE[theme]), theme).toBeGreaterThanOrEqual(3)
      expect(contrast(t.eyeFloat, PAGE[theme]), theme).toBeGreaterThanOrEqual(3)
      // Its side shows against its face.
      expect(t.side).not.toBe(t.body)
    }
  })

  it("are the page's variables, each tone a class", () => {
    const css = faceToneCss()
    for (const c of FACE_COLORS) {
      const light = faceTones(c, "light")
      const dark = faceTones(c, "dark")
      expect(css).toContain(`[data-pa-tone="${c}"]{--pa-k-body:${light.body};`)
      expect(css).toContain(
        `.dark [data-pa-tone="${c}"]{--pa-k-body:${dark.body};`
      )
    }
    for (const r of TONE_ROLES) {
      const k = r.replace(/[A-Z0-9]/g, (ch) => `-${ch}`).toLowerCase()
      expect(css).toContain(`.pa-f-${k}{fill:var(--pa-k-${k})}`)
      expect(css).toContain(`.pa-s-${k}{stroke:var(--pa-k-${k})}`)
    }
  })
})

describe("a face's pose", () => {
  it("turns toward the pointer, its eyes ahead — not asleep", () => {
    const rest = restPose("gear", "idle")
    const right = poseAt("gear", "idle", 0, [2, 0])
    expect(right.n[0]).toBeGreaterThan(rest.n[0])
    expect(right.gx).toBeGreaterThan(rest.gx)
    const up = poseAt("gear", "idle", 0, [0, -2])
    expect(up.n[1]).toBeLessThan(rest.n[1])
    expect(up.gy).toBeGreaterThan(rest.gy)
    expect(poseAt("gear", "sleeping", 0, [2, 0])).toEqual(
      restPose("gear", "sleeping")
    )
  })

  it("moves only in a look that moves, a turn and a shake once", () => {
    expect(isMoving("idle", 5)).toBe(false)
    expect(isMoving("sleeping", 5)).toBe(false)
    expect(isMoving("working", 5)).toBe(true)
    expect(isMoving("thinking", 5)).toBe(true)
    expect(isMoving("done", 0.4)).toBe(true)
    expect(isMoving("done", 2)).toBe(false)
    expect(isMoving("failed", 0.5)).toBe(true)
    expect(isMoving("failed", 2)).toBe(false)
    // At rest once still: as its still pose.
    expect(poseKey(poseAt("ring", "done", 2))).toBe(
      poseKey(restPose("ring", "done"))
    )
    // The ring's star runs round its band while it works.
    expect(poseAt("ring", "working", 1).star).not.toBe(
      restPose("ring", "working").star
    )
  })

  it("turns the done face right round", () => {
    const half = poseAt("terminal", "done", 0.4)
    expect(half.n[2]).toBeLessThan(0)
    // Seen from behind: no eyes on it.
    const svg = parse(faceMarkup("terminal", "done", half, false, "x"))
    expect(svg.querySelector(".pa-face-lids")!.children).toHaveLength(0)
  })
})

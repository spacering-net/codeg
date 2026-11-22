import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  BOT_SHAPES,
  DEFAULT_SHAPES,
  eyeNodes,
  faceArt,
  nodeMarkup,
  type SvgNode,
} from "./bot-shapes"

const rust = readFileSync(
  join(process.cwd(), "src-tauri/src/models/personal_agent_bots.rs"),
  "utf8"
)
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8")

/** A `pub const NAME: [&str; n] = [...]` of the backend, as a list. */
function rustList(name: string): string[] {
  const at = rust.indexOf(`pub const ${name}:`)
  const body = rust.slice(
    rust.indexOf("[", rust.indexOf("=", at)),
    rust.indexOf("];", at)
  )
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

function walk(nodes: SvgNode[], visit: (n: SvgNode) => void) {
  for (const n of nodes) {
    visit(n)
    walk(n.c ?? [], visit)
  }
}

const PAINT = { $b: "#3b82f6", $c: "#ffffff", $w: "#ffffff" } as const

describe("the shapes an assistant is drawn as", () => {
  it("are the backend's, the primary's ring kept out of the defaults", () => {
    expect([...BOT_SHAPES]).toEqual(rustList("BOT_SHAPES"))
    expect([...DEFAULT_SHAPES]).toEqual(rustList("DEFAULT_SHAPES"))
    expect(DEFAULT_SHAPES).not.toContain("ring")
    expect(BOT_SHAPES).toHaveLength(13)
  })

  it.each(BOT_SHAPES)(
    "draws %s full and small, its paints all named",
    (shape) => {
      for (const small of [false, true]) {
        const art = faceArt(shape, small, (n) => `t-${n}`)
        expect(art.body.length).toBeGreaterThan(0)
        expect(art.eyes.window.length).toBeGreaterThan(0)
        // A clip path holds shapes only.
        for (const w of art.eyes.window) expect(w.t).not.toBe("g")
        const markup = art.body.map((n) => nodeMarkup(n, PAINT)).join("")
        expect(markup).not.toMatch(/"\$[bcw]"/)
        // Each mask it names, it defines.
        const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1])
        for (const ref of markup.matchAll(/url\(#([^)]+)\)/g)) {
          expect(ids).toContain(ref[1])
        }
        expect(new Set(ids).size).toBe(ids.length)
      }
    }
  )

  it("draws the small one plainer: fewer parts, larger eyes", () => {
    for (const shape of BOT_SHAPES) {
      let full = 0
      let small = 0
      walk(faceArt(shape, false, (n) => n).body, () => full++)
      walk(faceArt(shape, true, (n) => n).body, () => small++)
      expect(small, shape).toBeLessThanOrEqual(full)
      const a = faceArt(shape, false, (n) => n).eyes
      const b = faceArt(shape, true, (n) => n).eyes
      expect(b.ry, shape).toBeGreaterThanOrEqual(a.ry)
    }
  })

  it("has a rule in globals.css for every part that moves as it works", () => {
    const classes = new Set<string>()
    for (const shape of BOT_SHAPES) {
      for (const small of [false, true]) {
        walk(faceArt(shape, small, (n) => n).body, (n) => {
          for (const c of String(n.a.class ?? "").split(/\s+/)) {
            if (c) classes.add(c)
          }
        })
      }
    }
    expect(classes.size).toBeGreaterThan(5)
    for (const c of classes) {
      expect(css, c).toContain(`.pa-face[data-bot-look="working"] .${c} {`)
    }
  })

  it("moves at every size while it works: a still body has a part that moves", () => {
    // The shapes whose bounce is turned off at every size.
    const at = css.indexOf('.pa-face[data-bot-look="working"]:is(')
    const list = css.slice(at, css.indexOf(".pa-face-body", at))
    const still = [...list.matchAll(/data-bot-shape="([\w-]+)"/g)].map(
      (m) => m[1]!
    )
    expect(still.length).toBeGreaterThan(0)
    for (const shape of still) {
      let parts = 0
      walk(faceArt(shape, true, (n) => n).body, (n) => {
        if (String(n.a.class ?? "").includes("pa-face-")) parts++
      })
      expect(parts, shape).toBeGreaterThan(0)
    }
    // The mug's steam is its full drawing's: drawn small, it keeps its bounce.
    expect(still).not.toContain("mug")
    expect(css).toContain(
      '.pa-face[data-bot-look="working"][data-bot-shape="mug"]:not([data-bot-small])'
    )
  })

  it("draws any name it does not know as the donut", () => {
    for (const name of ["pebble", "constructor", "toString", "__proto__"]) {
      const art = faceArt(name, false, (n) => n)
      expect(art.body, name).toEqual(faceArt("donut", false, (n) => n).body)
    }
  })

  it("leaves out of a still picture what shows only while it works", () => {
    const markup = faceArt("watch", false, (n) => n)
      .body.map((n) => nodeMarkup(n, PAINT))
      .join("")
    expect(markup).not.toContain("pa-face-progress")
  })

  it("draws each look's two eyes, leaned as the shape leans them", () => {
    const eyes = faceArt("mug", false, (n) => n).eyes
    for (const look of [
      "idle",
      "thinking",
      "working",
      "waiting",
      "stuck",
      "done",
      "failed",
      "sleeping",
    ] as const) {
      const node = eyeNodes(eyes, look)
      expect(node.c, look).toHaveLength(2)
      expect(node.a.transform, look).toBe("rotate(-6 238 312)")
    }
    // A blink shuts them to a tenth.
    const open = eyeNodes(eyes, "idle").c![0]!.a.height
    const shut = eyeNodes(eyes, "idle", 0.1).c![0]!.a.height
    expect(shut).toBeCloseTo(Number(open) / 10, 0)
  })

  it("escapes what it writes into an attribute", () => {
    expect(
      nodeMarkup({ t: "text", a: { "aria-label": 'a "b" & <c>' } }, PAINT)
    ).toBe('<text aria-label="a &quot;b&quot; &amp; &lt;c>"/>')
  })
})

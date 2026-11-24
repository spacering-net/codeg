import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import type { BotColor } from "@/lib/types"

import { FACE_BODY, FACE_EYES } from "./bot-avatar"

/** The owner's bubbles are the assistant's face — its body's colour, the
 *  words in its eyes' — so the CSS that paints them has to name the very
 *  palette steps the face is drawn in. */
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8")

/** The custom properties a rule sets, by its selector exactly. */
function rule(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return {}
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at))
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]])
  )
}

/** `fill-red-500 dark:fill-red-400` → the palette steps, light and dark. */
function steps(classes: string, prefix: string) {
  let light: string | null = null
  let dark: string | null = null
  for (const c of classes.split(/\s+/)) {
    if (c.startsWith(`dark:${prefix}`)) dark = c.slice(`dark:${prefix}`.length)
    else if (c.startsWith(prefix)) light = c.slice(prefix.length)
  }
  return { light, dark }
}

describe("the owner's bubble in an assistant's face", () => {
  const colors = Object.keys(FACE_BODY) as BotColor[]

  it.each(colors)("is %s's body with its eyes' words", (color) => {
    const body = steps(FACE_BODY[color], "fill-")
    const eyes = steps(FACE_EYES[color], "text-")
    const light = rule(`[data-pa-face="${color}"]`)
    expect(light["--pa-body"]).toBe(`var(--color-${body.light})`)
    expect(light["--pa-eyes"]).toBe(`var(--color-${eyes.light})`)
    const dark = rule(`.dark [data-pa-face="${color}"]`)
    if (body.dark) expect(dark["--pa-body"]).toBe(`var(--color-${body.dark})`)
    else expect(dark["--pa-body"]).toBeUndefined()
    if (eyes.dark) expect(dark["--pa-eyes"]).toBe(`var(--color-${eyes.dark})`)
    else expect(dark["--pa-eyes"]).toBeUndefined()
  })

  it("paints the bubble with them, the theme's for a picture", () => {
    const own = rule(".pa-owner-bubble")
    expect(own["--pa-own"]).toBe("var(--pa-body, var(--primary))")
    expect(own["--pa-own-ink"]).toBe(
      "var(--pa-eyes, var(--primary-foreground))"
    )
  })
})

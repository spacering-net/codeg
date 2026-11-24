import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { THEME_COLOR_TITLE } from "@/lib/theme-presets"

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/app/globals.css"),
  "utf8"
)

/** The `--activity-accent` the last rule with exactly this selector sets —
 *  the one that wins, the preset's own block coming first. */
function accentOf(selector: string): string | null {
  let accent: string | null = null
  let from = 0
  for (;;) {
    const start = globalsCss.indexOf(`\n${selector} {`, from)
    if (start === -1) return accent
    const end = globalsCss.indexOf("\n}", start)
    const match = globalsCss
      .slice(start, end)
      .match(/--activity-accent:\s*([^;]+);/)
    if (match) accent = match[1]!.trim()
    from = end
  }
}

describe("globals.css --activity-accent", () => {
  // The timeline's theme colour (a running ring's arc, a running label's
  // sweep, the MCP chip) is the sidebar's folder-title tint: the primary held
  // to a readable lightness. The CSS spells the table out per preset; it must
  // say what theme-presets.ts says.
  it.each(Object.entries(THEME_COLOR_TITLE))(
    "the %s preset reads the folder-title tint",
    (preset, tint) => {
      expect(accentOf(`[data-theme="${preset}"]`)).toBe(tint.light)
      expect(accentOf(`[data-theme="${preset}"].dark`)).toBe(tint.dark)
    }
  )
})

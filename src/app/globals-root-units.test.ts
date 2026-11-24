import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/app/globals.css"),
  "utf8"
)

/** The first `:root { ... }` block, comments stripped. */
function rootBlock(): string {
  const start = globalsCss.indexOf(":root {")
  expect(start).toBeGreaterThan(-1)
  const end = globalsCss.indexOf("\n}", start)
  expect(end).toBeGreaterThan(start)
  return globalsCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "")
}

/** Regular (non-custom-property) declarations of the `:root` block. */
function rootDeclarations(): { prop: string; value: string }[] {
  return rootBlock()
    .split(";")
    .map((line) => line.trim())
    .filter((line) => line.includes(":") && !line.startsWith("--"))
    .map((line) => {
      const colon = line.indexOf(":")
      return {
        prop: line.slice(0, colon).trim(),
        value: line.slice(colon + 1).trim(),
      }
    })
    .filter(({ prop }) => !prop.startsWith(":root") && !prop.includes("{"))
}

describe("globals.css :root units", () => {
  // Zoom is one declaration: AppearanceProvider writes `16 * zoom / 100` px onto
  // <html>. WebKit — the engine the desktop app actually ships on, Tauri = WKWebView
  // — resolves `rem` ON THE ROOT ELEMENT against font-size's INITIAL value (16px)
  // rather than the root's own font-size, for every property and not just
  // font-size. So a root-level `rem` is frozen at its 100% value forever: at 300%
  // `line-height: 1.5rem` stayed 24px while the CJK glyphs grew to 42px, and
  // `truncate`'s overflow:hidden sliced 13px off the top and bottom of sidebar nav
  // labels, conversation titles and the folder select alike. It is not a
  // stale-invalidation race — a cold start at 300% computes 24px too — and
  // `calc(1.5 * 1rem)` / `var(--lh)` are frozen the same way, so no respelling of
  // rem escapes it. Chromium follows the spec here, which is why the bug is
  // invisible when server mode is opened in a browser.
  //
  // `em` on the root element is its own font-size in both engines and resolves
  // live: 24px at 100% (identical to the px literal this replaced) and 72px at
  // 300%. Custom properties are exempt — their values are substituted at the use
  // site and resolve against the element that consumes them, not against :root.
  it("declares no rem-valued regular property on :root", () => {
    const remDeclarations = rootDeclarations().filter(({ value }) =>
      /\brem\b|\d(?:\.\d+)?rem/.test(value)
    )

    expect(remDeclarations).toEqual([])
  })

  it("scales the inherited line-height with the zoom via em", () => {
    const lineHeight = rootDeclarations().find(
      ({ prop }) => prop === "line-height"
    )

    expect(lineHeight?.value).toBe("1.5em")
  })

  it("keeps the root font-size at the 16px the zoom math assumes", () => {
    // AppearanceProvider derives the zoom level back out of this
    // (`Math.round((px / 16) * 100)`), and every rem-sized utility in the app is
    // authored as px/16 — so this baseline is load-bearing for both directions.
    const fontSize = rootDeclarations().find(({ prop }) => prop === "font-size")

    expect(fontSize?.value).toBe("16px")
  })
})

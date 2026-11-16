// Snapshots every theme tweakcn publishes into `src/lib/theme-preset-library.json`.
//
// tweakcn's editor hands out one theme at a time as a shadcn registry item
// (`pnpm dlx shadcn@latest add https://tweakcn.com/r/themes/<id>.json`), which
// rewrites a stylesheet wholesale: one theme per project, chosen once. The
// registry index below publishes all of them with both light and dark
// variables in one document, which is what lets this app carry the whole set
// and switch between them at runtime instead.
//
// Re-run with `pnpm themes:fetch` to pick up themes added upstream.

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const outputPath = path.join(
  rootDir,
  "src",
  "lib",
  "theme-preset-library.json"
)

const REGISTRY_URL = "https://tweakcn.com/r/themes/registry.json"

// The variables this app can apply: `CUSTOM_THEME_TOKENS` in
// `src/lib/custom-style.ts`, mirrored here because a node script cannot import
// TypeScript. Keep the two lists in step — a token missing here is a colour the
// preset silently will not carry.
const TOKENS = [
  "primary",
  "primary-foreground",
  "background",
  "foreground",
  "accent",
  "border",
  "sidebar",
  "radius",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent-foreground",
  "destructive",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
]

// Same character set and length cap as `TOKEN_VALUE_RE` in `custom-style.ts`,
// which is also mirrored into the pre-paint script. A value that fails there is
// one the app would drop on apply, so it is dropped at snapshot time instead of
// shipping a token that silently does nothing.
const VALUE_RE = /^[a-zA-Z0-9#%.,()/\s+-]{1,64}$/

function pick(vars) {
  const picked = {}
  if (!vars || typeof vars !== "object") return picked
  for (const token of TOKENS) {
    const value = vars[token]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (VALUE_RE.test(trimmed)) picked[token] = trimmed
  }
  return picked
}

const response = await fetch(REGISTRY_URL)
if (!response.ok) {
  throw new Error(
    `registry request failed: ${response.status} ${response.statusText}`
  )
}

const registry = await response.json()
if (!Array.isArray(registry.items) || registry.items.length === 0) {
  throw new Error("registry index carried no items")
}

const presets = registry.items
  .filter((item) => item && typeof item.name === "string")
  .map((item) => {
    const light = pick(item.cssVars?.light)
    // Dark inherits whatever it does not override, exactly as the stylesheet
    // it came from does: tweakcn writes its dark block as `.dark` rules over a
    // `:root` that already holds the light values, and a handful of settings
    // are stated once there and never repeated.
    const dark = { ...light, ...pick(item.cssVars?.dark) }
    return { id: item.name, label: item.title ?? item.name, light, dark }
  })
  .filter((preset) => Object.keys(preset.light).length > 0)
  .sort((a, b) => a.id.localeCompare(b.id))

if (presets.length === 0) {
  throw new Error("no theme carried a single usable variable")
}

// 2-space indent and a trailing newline match what prettier expects of the
// files under `src/`.
await writeFile(outputPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8")

console.log(
  `wrote ${presets.length} themes to ${path.relative(rootDir, outputPath)}`
)

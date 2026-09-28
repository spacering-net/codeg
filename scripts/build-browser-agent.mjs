// Bundles `browser-agent/` into the single script the isolated world runs.
//
// The product is committed (`src-tauri/src/browser/js/agent.bundle.js`) so a
// cargo build never needs node: `include_str!` reads it at compile time, and a
// contributor building only the Rust side gets a working browser without a
// pnpm install. Run this whenever `browser-agent/` changes; CI checks that the
// committed bundle matches its source.
//
// esbuild transpiles without typechecking, which is what lets the vendored
// Playwright sources stay byte-identical to upstream: they are written for
// Playwright's tsconfig, not ours. `pnpm browser:agent:check` typechecks our
// own entry separately.

import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outfile = resolve(root, "src-tauri/src/browser/js/agent.bundle.js")

// `--check` proves the committed bundle is the one this source produces,
// rather than something someone hand-edited or forgot to rebuild. esbuild is
// deterministic for a given version and input, so a byte comparison is a fair
// test; a version bump that changes its output shows up here as a diff and is
// committed along with the bump.
const check = process.argv.includes("--check")

const result = await build({
  entryPoints: [resolve(root, "browser-agent/src/index.ts")],
  ...(check ? { write: false } : { outfile }),
  bundle: true,
  format: "iife",
  // The world is created fresh for every document, so the script runs once per
  // document and needs no guard against being evaluated twice.
  platform: "browser",
  // WebKitGTK 2.40 is the oldest engine any supported platform gives us, and
  // it is roughly Safari 16.4. Targeting it keeps the bundle free of syntax
  // the oldest of the three engines cannot parse.
  target: ["safari16.4"],
  // Playwright's sources import each other through this alias; keeping it
  // means the vendored files need no edits to build here.
  alias: {
    "@isomorphic": resolve(root, "browser-agent/vendor/playwright/isomorphic"),
  },
  legalComments: "none",
  banner: {
    js: [
      "/*",
      " * GENERATED — do not edit. Built from browser-agent/ by",
      " * scripts/build-browser-agent.mjs (pnpm browser:agent).",
      " *",
      " * Bundles a vendored subset of Playwright (Apache-2.0). See",
      " * browser-agent/vendor/playwright/{VENDOR.md,LICENSE}.",
      " */",
    ].join("\n"),
  },
  metafile: true,
})

if (check) {
  const built = result.outputFiles[0].text
  let committed
  try {
    committed = readFileSync(outfile, "utf8")
  } catch {
    console.error(
      `missing ${outfile} — run \`pnpm browser:agent\` and commit it.`
    )
    process.exit(1)
  }
  if (built !== committed) {
    console.error(
      `${outfile} is stale: browser-agent/ has changed since it was built.\n` +
        `Run \`pnpm browser:agent\` and commit the result.`
    )
    process.exit(1)
  }
  console.log("agent.bundle.js is up to date with browser-agent/")
} else {
  const bytes = Object.values(result.metafile.outputs)[0].bytes
  console.log(
    `agent.bundle.js  ${(bytes / 1024).toFixed(1)} KB  ->  ${outfile}`
  )
}

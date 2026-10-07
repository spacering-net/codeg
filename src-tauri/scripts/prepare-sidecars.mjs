#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Runs `cargo build --release --no-default-features`, with the feature
//      each binary target requires, for each sidecar bin (`codeg-mcp`,
//      `codeg-computer-helper`) for that triple from `src-tauri/`.
//   3. Copies each produced binary to
//      `src-tauri/binaries/<bin>-<triple>{.exe}` so Tauri's externalBin
//      bundler picks it up under its bare name at install time.
//   4. For a macOS target, also wraps the helper in an app of its own,
//      `src-tauri/binaries/codeg-computer-helper.app`, which the bundle
//      carries as `Contents/Helpers/codeg-computer-helper.app` (see
//      `tauri.macos.conf.json`). macOS charges an executable's permissions to
//      the app bundle it sits in: a helper beside codeg in `Contents/MacOS/`
//      would hold codeg's — every agent's shell's — and none of its own.
//
// `codeg-computer-helper` takes its trust anchors from the environment at
// compile time (`CODEG_COMPUTER_PEER_REQUIREMENT`): the release workflow sets
// it for the macOS builds, and a local build without it is a development
// helper that says so. Nothing here sets or defaults it.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     get a host-triple build, so the externalBin lookup still finds a file.
//   - Skippable: set `CODEG_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't care about delegation or computer use: a development
//     codeg refuses a computer helper built from other sources than its own,
//     so after a change under `src-tauri/src/computer/` run this script once
//     (it is what rebuilds the helper) and restart `pnpm tauri dev`.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { execFileSync } from "node:child_process"
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
// Every sidecar in `bundle.externalBin`, in the order they are built. (On
// macOS the helper is bundled as an app instead; see `stageHelperApp`.)
const BIN_NAMES = ["codeg-mcp", "codeg-computer-helper"]
// The features their binary targets require (Cargo.toml).
const FEATURES = "mcp-bin,computer-helper"
const HELPER = "codeg-computer-helper"
const HELPER_APP = join(BINARIES_DIR, `${HELPER}.app`)

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

// The helper as an app: its Info.plist (identifier `app.codeg.computer-helper`,
// no Dock icon), its executable, codeg's icon. Sealed ad hoc, so a bundle
// signed around it accepts it; release.yml signs it again with the Developer
// ID before `tauri build`.
function stageHelperApp(built) {
  const version = JSON.parse(
    readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8")
  ).version
  const plist = readFileSync(
    join(SRC_TAURI, "macos", `${HELPER}.plist`),
    "utf8"
  ).replaceAll("{{version}}", version)
  rmSync(HELPER_APP, { recursive: true, force: true })
  const contents = join(HELPER_APP, "Contents")
  mkdirSync(join(contents, "MacOS"), { recursive: true })
  mkdirSync(join(contents, "Resources"), { recursive: true })
  writeFileSync(join(contents, "Info.plist"), plist)
  const exe = join(contents, "MacOS", HELPER)
  copyFileSync(built, exe)
  chmodSync(exe, 0o755)
  copyFileSync(
    join(SRC_TAURI, "icons", "icon.icns"),
    join(contents, "Resources", "icon.icns")
  )
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--force", "--sign", "-", HELPER_APP], {
      stdio: "inherit",
    })
  } else {
    log(`not on macOS: ${HELPER_APP} is left unsigned`)
  }
  log(`helper app staged at ${HELPER_APP}`)
}

function main() {
  if (process.env.CODEG_SKIP_SIDECAR === "1") {
    log("CODEG_SKIP_SIDECAR=1 — skipping sidecar preparation")
    log(
      "computer use refuses a helper older than src-tauri/src/computer/; " +
        "run `pnpm tauri:prepare-sidecars` after changing it"
    )
    return
  }

  const { target: cliTarget } = parseArgs(process.argv.slice(2))
  const target =
    cliTarget || process.env.TAURI_TARGET_TRIPLE || resolveHostTriple()
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""

  log(`target triple: ${target}`)
  log(
    `building ${BIN_NAMES.join(", ")} (--release --no-default-features --features ${FEATURES})`
  )

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  // `--no-default-features` keeps the sidecars free of the Tauri runtime deps
  // — so they cross-compile without dragging in macOS-private-api / Linux
  // WebKit / Windows WebView2. One cargo invocation for both, so they share
  // one dependency build. Each binary target needs its own feature (see
  // Cargo.toml): off by default, so `tauri build` leaves them alone.
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      ...BIN_NAMES.flatMap((name) => ["--bin", name]),
      "--no-default-features",
      "--features",
      FEATURES,
      "--target",
      target,
    ],
    { stdio: "inherit", cwd: SRC_TAURI }
  )

  mkdirSync(BINARIES_DIR, { recursive: true })
  for (const name of BIN_NAMES) {
    const built = join(SRC_TAURI, "target", target, "release", `${name}${ext}`)
    if (!existsSync(built)) {
      die(`expected ${built} after cargo build, but it does not exist`)
    }
    const dest = join(BINARIES_DIR, `${name}-${target}${ext}`)
    copyFileSync(built, dest)
    if (!isWindows) {
      // copyFileSync preserves modes on POSIX, but be explicit for tarball
      // sources that may strip the +x bit.
      chmodSync(dest, 0o755)
    }
    log(`sidecar staged at ${dest}`)
    if (name === HELPER && target.includes("apple-darwin")) {
      stageHelperApp(built)
    }
  }
}

main()

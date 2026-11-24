// @vitest-environment node

import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const script = fileURLToPath(
  new URL("../../src-tauri/scripts/prepare-sidecars.mjs", import.meta.url)
)
const bins = ["codeg-mcp", "codeg-computer-helper", "codeg-cli"]
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

// Exercise the complete Node staging CLI. The fake Cargo writes its build
// artifacts ONLY to its reported output, so a hardcoded lookup fails.
function prepare({
  shared = false,
  target = "x86_64-unknown-linux-gnu",
  metadata = "valid",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeg-sidecar-output-"))
  roots.push(root)
  const crate = join(root, "src-tauri")
  const entry = join(crate, "scripts", "prepare-sidecars.mjs")
  mkdirSync(dirname(entry), { recursive: true })
  copyFileSync(script, entry)
  const output = shared
    ? join(root, "shared Cargo cache")
    : join(crate, "target")
  const preload = join(root, "cargo.mjs")
  const commands = join(root, "commands.jsonl")
  writeFileSync(
    preload,
    `import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
childProcess.execFileSync = (command, args) => {
  if (command !== "cargo") throw new Error("Unexpected command " + command)
  appendFileSync(process.env.CODEG_SIDECAR_TEST_COMMANDS, JSON.stringify(args) + "\\n")
  const output = process.env.CODEG_SIDECAR_TEST_OUTPUT
  if (args[0] === "build") {
    const target = args[args.indexOf("--target") + 1]
    const release = join(output, target, "release")
    mkdirSync(release, { recursive: true })
    for (const bin of ${JSON.stringify(bins)}) {
      writeFileSync(join(release, bin + (target.includes("windows") ? ".exe" : "")), "built:" + bin)
    }
    return null
  }
  if (args[0] === "metadata") {
    const mode = process.env.CODEG_SIDECAR_TEST_METADATA
    return JSON.stringify(mode === "missing" ? {} : {
      target_directory: mode === "relative" ? "relative-output" : output
    })
  }
  throw new Error("Unexpected Cargo operation " + args[0])
}
syncBuiltinESMExports()
`
  )
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, entry, "--target", target],
    {
      cwd: root,
      env: {
        ...process.env,
        CODEG_SKIP_SIDECAR: "0",
        CODEG_SIDECAR_TEST_COMMANDS: commands,
        CODEG_SIDECAR_TEST_OUTPUT: output,
        CODEG_SIDECAR_TEST_METADATA: metadata,
      },
      encoding: "utf8",
    }
  )
  return { result, crate, commands, target, output }
}

describe("sidecar Cargo output staging", () => {
  it.each([false, true])(
    "copies every binary from the Cargo-reported output (shared=%s)",
    (shared) => {
      const { result, crate, target } = prepare({ shared })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      for (const bin of bins) {
        const staged = join(crate, "binaries", `${bin}-${target}`)
        expect(readFileSync(staged, "utf8")).toBe(`built:${bin}`)
        if (process.platform !== "win32") {
          expect(statSync(staged).mode & 0o111).toBe(0o111)
        }
      }
    }
  )

  it("preserves the Windows executable suffix with a configured output directory", () => {
    const target = "x86_64-pc-windows-msvc"
    const { result, crate } = prepare({ shared: true, target })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    for (const bin of bins) {
      expect(
        readFileSync(join(crate, "binaries", `${bin}-${target}.exe`), "utf8")
      ).toBe(`built:${bin}`)
    }
  })

  it.each(["missing", "relative"])(
    "fails before staging when Cargo reports %s output metadata",
    (metadata) => {
      const { result, crate } = prepare({ shared: true, metadata })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("cannot determine Cargo output directory")
      expect(existsSync(join(crate, "binaries"))).toBe(false)
    }
  )
})

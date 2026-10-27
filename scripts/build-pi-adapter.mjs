// Reproducible, offline runtime bundle. Install the pinned build dependencies
// with `npm ci --ignore-scripts --omit=dev --prefix pi-adapter/vendor` first.
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyOverlay } from "../pi-adapter/overlay.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const vendor = resolve(root, "pi-adapter/vendor")
const provenance = JSON.parse(
  readFileSync(resolve(root, "pi-adapter/provenance.json"), "utf8")
)
const check = process.argv.includes("--check")
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
for (const [path, expected] of Object.entries(provenance.files)) {
  const bytes = readFileSync(resolve(vendor, path))
  const actual = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
  if (actual !== expected) throw new Error(`Vendored source changed: ${path}`)
}
const output = resolve(root, "src-tauri/src/acp/pi-bundle")
mkdirSync(output, { recursive: true })
const hashes = {}
const usedPackages = new Set()
for (const [entry, name] of [
  [resolve(vendor, "src/index.ts"), "adapter.mjs"],
  [resolve(root, "pi-adapter/mcp-bridge.mjs"), "mcp-bridge.mjs"],
]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
    minify: false,
    define: { __PI_ACP_VERSION__: JSON.stringify(provenance.version) },
    banner: {
      js: '/* Generated from pi-adapter/vendor (MIT); see pi-adapter/provenance.json. */\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "pi-lifecycle-overlay",
        setup(builder) {
          builder.onLoad(
            { filter: /[\\/]acp[\\/](agent|session|mcp-bridge)\.ts$/ },
            async ({ path }) => ({
              contents: applyOverlay(
                path.replaceAll("\\", "/"),
                readFileSync(path, "utf8")
              ),
              loader: "ts",
            })
          )
        },
      },
    ],
  })
  const bytes = result.outputFiles[0].contents
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = input
      .replaceAll("\\", "/")
      .match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
    if (match) usedPackages.add(match[1])
  }
  hashes[name] = sha256(bytes)
  if (check) {
    if (!readFileSync(resolve(output, name)).equals(Buffer.from(bytes)))
      throw new Error(`Stale Pi bundle: ${name}`)
  } else writeFileSync(resolve(output, name), bytes)
}
const license = readFileSync(resolve(vendor, "LICENSE"))
hashes.LICENSE = sha256(license)
if (check) {
  if (!readFileSync(resolve(output, "LICENSE")).equals(license))
    throw new Error("Stale Pi license")
} else writeFileSync(resolve(output, "LICENSE"), license)
const notices =
  [...usedPackages]
    .sort()
    .map((name) => {
      const directory = resolve(vendor, "node_modules", name)
      const pkg = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8")
      )
      const files = readdirSync(directory)
        .filter((name) => /^(license|notice)(\.|$)/i.test(name))
        .sort()
      if (!files.length) throw new Error(`Missing dependency license: ${name}`)
      return `${name}@${pkg.version}\n${files.map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n")}\n`
    })
    .join("\n----------------------------------------\n\n")
    .trimEnd() + "\n"
hashes["THIRD_PARTY_NOTICES"] = sha256(notices)
if (check) {
  if (readFileSync(resolve(output, "THIRD_PARTY_NOTICES"), "utf8") !== notices)
    throw new Error("Stale dependency notices")
} else writeFileSync(resolve(output, "THIRD_PARTY_NOTICES"), notices)
const localSources = Object.fromEntries(
  [
    "pi-adapter/overlay.mjs",
    "pi-adapter/mcp-bridge.mjs",
    "scripts/build-pi-adapter.mjs",
  ].map((path) => [path, sha256(readFileSync(resolve(root, path)))])
)
const manifest =
  JSON.stringify({ ...provenance, localSources, sha256: hashes }, null, 2) +
  "\n"
if (check) {
  if (readFileSync(resolve(output, "manifest.json"), "utf8") !== manifest)
    throw new Error("Stale Pi bundle manifest")
} else writeFileSync(resolve(output, "manifest.json"), manifest)
console.log(
  check
    ? "Pi adapter source, bundle and digests verified"
    : "Pi adapter bundle generated"
)

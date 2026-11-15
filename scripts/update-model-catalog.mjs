// Regenerates the model catalog snapshot compiled into the binary.
//
// The snapshot is litellm's model_prices_and_context_window.json trimmed the
// same way src-tauri/src/model_catalog/mod.rs does at runtime: chat models
// only, one entry per provider-facing id, first-party providers over resellers.
//
//   node scripts/update-model-catalog.mjs                 # fetch the default URL
//   node scripts/update-model-catalog.mjs --from <file>   # trim a local copy
//   node scripts/update-model-catalog.mjs --url <url>     # another source

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/resources/model-catalog/litellm.json"
)

const RESELLERS = new Set([
  "azure",
  "azure_ai",
  "azure_text",
  "bedrock",
  "bedrock_converse",
  "vertex_ai",
  "openrouter",
  "replicate",
  "databricks",
  "sagemaker",
  "fireworks_ai",
  "together_ai",
])
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function modelIdOf(key) {
  const slash = key.indexOf("/")
  return slash === -1 ? key : key.slice(slash + 1)
}

function effortLevelsOf(entry) {
  if (Array.isArray(entry.reasoning_effort_levels)) {
    const levels = entry.reasoning_effort_levels.filter((l) => typeof l === "string")
    if (levels.length > 0) return levels
  }
  if (entry.supports_reasoning === true) {
    return LEVELS.filter((level) => entry[`supports_${level}_reasoning_effort`] === true)
  }
  return []
}

function supportsVisionOf(entry) {
  if (entry.supports_vision === true || entry.supports_image_input === true) return true
  return (
    Array.isArray(entry.supported_modalities) &&
    entry.supported_modalities.includes("image")
  )
}

function trim(raw) {
  const best = new Map()
  for (const key of Object.keys(raw).sort()) {
    const entry = raw[key]
    if (!entry || typeof entry !== "object" || entry.mode !== "chat") continue
    const model = modelIdOf(key)
    const provider =
      typeof entry.litellm_provider === "string"
        ? entry.litellm_provider
        : key.includes("/")
          ? key.slice(0, key.indexOf("/"))
          : ""
    const rank = RESELLERS.has(provider) ? 1 : 0
    const known = best.get(model)
    if (known && known.rank <= rank) continue
    best.set(model, {
      rank,
      entry: {
        id: key,
        model,
        provider,
        maxInputTokens: entry.max_input_tokens ?? entry.max_tokens ?? null,
        maxOutputTokens: entry.max_output_tokens ?? null,
        supportsReasoning: entry.supports_reasoning === true,
        reasoningEffortLevels: effortLevelsOf(entry),
        defaultReasoningEffort:
          typeof entry.default_reasoning_effort === "string"
            ? entry.default_reasoning_effort
            : null,
        supportsVision: supportsVisionOf(entry),
        supportsFunctionCalling: entry.supports_function_calling === true,
      },
    })
  }
  const entries = [...best.values()].map((v) => v.entry)
  entries.sort(
    (a, b) =>
      a.model.toLowerCase().localeCompare(b.model.toLowerCase()) ||
      a.provider.localeCompare(b.provider)
  )
  return entries
}

async function load() {
  const args = process.argv.slice(2)
  const fromIndex = args.indexOf("--from")
  if (fromIndex !== -1) {
    return JSON.parse(readFileSync(args[fromIndex + 1], "utf8"))
  }
  const urlIndex = args.indexOf("--url")
  const url = urlIndex !== -1 ? args[urlIndex + 1] : DEFAULT_URL
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

const entries = trim(await load())
if (entries.length === 0) throw new Error("the source has no chat models")
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ fetchedAt: 0, entries })}\n`)
console.log(`wrote ${entries.length} models to ${OUT}`)

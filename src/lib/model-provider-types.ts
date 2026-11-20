/**
 * The four API wire-format families a provider speaks. Each implies its own
 * auth-header convention (Bearer / `x-api-key`+version / `x-goog-api-key`)
 * and its own `/models` payload shape when probing.
 */
export type ModelProviderApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"

export type ModelInputKind = "text" | "text-image"

/** One model inside a provider. Numeric fields are kept as strings while the
 *  form is being edited so the inputs can hold an empty/in-flight value. */
export interface ModelEntryDraft {
  id: string
  reasoning: boolean
  input: ModelInputKind
  contextWindow?: string
  maxTokens?: string
  /** Codex-only: a full system prompt for a custom catalog entry. */
  baseInstructions?: string
}

/** The full editable provider, as the editor works on it. */
export interface ModelProviderDraft {
  /** Current id being edited (user may have renamed it). */
  providerId: string
  /** Id when the editor was opened (empty for new providers). Used to detect
   *  id collisions: renaming "foo" to "bar" when "bar" already exists must be
   *  rejected instead of silently overwriting it. */
  originalId: string
  api: ModelProviderApiType
  baseUrl: string
  proxy?: string
  /** Masked when read from a saved provider; an empty string on save means
   *  "keep the existing credential" (the service resolves it). */
  apiKey: string
  authHeader: boolean
  /** Provider-level compat. `null` = leave unset (SDK auto-detect). */
  compatSupportsDeveloperRole: boolean | null
  enabled: boolean
  models: ModelEntryDraft[]
}

/** A saved provider as the list/settings surface reads it — never carries the
 *  raw API key, only a masked preview. */
export interface ModelProviderRecord {
  providerId: string
  api: ModelProviderApiType
  baseUrl: string
  proxy?: string
  enabled: boolean
  models: ModelEntryDraft[]
  apiKeyMasked: string
  hasApiKey: boolean
  compatSupportsDeveloperRole: boolean | null
}

/** A curated built-in provider the user can clone into a custom provider. */
export interface BuiltinProviderInfo {
  id: string
  apiType: ModelProviderApiType
  baseUrl: string
  configured: boolean
  models: ModelEntryDraft[]
}

export interface ProbeParams {
  baseUrl: string
  api: ModelProviderApiType
  apiKey?: string
  authHeader?: boolean
}

export type ProbeOutcome =
  | { ok: true; models: ModelEntryDraft[] }
  | { ok: false; error: string }

export type TestOutcome =
  | { ok: true; reply: string }
  | { ok: false; error: string }

export interface SaveResult {
  record: ModelProviderRecord
  affectedRunningSessions: number
}

export function emptyModelEntry(): ModelEntryDraft {
  return { id: "", reasoning: true, input: "text-image" }
}

export function emptyProviderDraft(): ModelProviderDraft {
  return {
    providerId: "",
    originalId: "",
    api: "openai-completions",
    baseUrl: "",
    apiKey: "",
    authHeader: true,
    compatSupportsDeveloperRole: null,
    enabled: true,
    models: [emptyModelEntry()],
  }
}

/** Open the editor for a saved provider: the API key is intentionally cleared
 *  (blank on save = keep existing), everything else is copied as-is. */
export function recordToDraft(record: ModelProviderRecord): ModelProviderDraft {
  return {
    providerId: record.providerId,
    originalId: record.providerId,
    api: record.api,
    baseUrl: record.baseUrl,
    proxy: record.proxy,
    apiKey: "",
    authHeader: record.hasApiKey,
    compatSupportsDeveloperRole: record.compatSupportsDeveloperRole ?? null,
    enabled: record.enabled,
    models: record.models.map((m) => ({ ...m })),
  }
}

/** Mask an API key for display: first 4 + middle dots + last 4, mirroring the
 *  backend's masker. */
export function maskApiKey(key: string): string {
  const chars = [...key]
  const len = chars.length
  if (len <= 8) return "\u2022".repeat(len)
  const prefix = chars.slice(0, 4).join("")
  const suffix = chars.slice(len - 4).join("")
  return `${prefix}\u2022\u2022\u2022${suffix}`
}

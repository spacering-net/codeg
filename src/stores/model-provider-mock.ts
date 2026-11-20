"use client"

import { useMemo } from "react"

import type { ModelProviderService } from "@/lib/model-provider-service"
import type {
  BuiltinProviderInfo,
  ModelEntryDraft,
  ModelProviderApiType,
  ModelProviderDraft,
  ModelProviderRecord,
  ProbeOutcome,
  ProbeParams,
  TestOutcome,
} from "@/lib/model-provider-types"
import { maskApiKey } from "@/lib/model-provider-types"

/**
 * In-memory mock behind the {@link ModelProviderService} contract. The page
 * renders fully against this store today; the real backend drops in later by
 * swapping the implementation returned from `useModelProviderService()`.
 *
 * The store simulates the shapes and failure modes the UI must handle (latency,
 * id collisions, fetch/test outcomes) without touching the real DB.
 */

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Canned `/models` payloads per API family (and OpenRouter-style gateways). */
function cannedModels(
  baseUrl: string,
  api: ModelProviderApiType
): ModelEntryDraft[] {
  if (baseUrl.includes("openrouter")) {
    return [
      {
        id: "openrouter/anthropic/claude-sonnet-4-5",
        reasoning: false,
        input: "text",
      },
      { id: "openrouter/openai/gpt-5.1", reasoning: false, input: "text" },
      {
        id: "openrouter/deepseek/deepseek-reasoner",
        reasoning: true,
        input: "text",
      },
    ]
  }
  switch (api) {
    case "anthropic-messages":
      return [
        { id: "claude-sonnet-4-5", reasoning: false, input: "text" },
        { id: "claude-opus-4-5", reasoning: true, input: "text" },
        { id: "claude-haiku-4-5", reasoning: false, input: "text" },
      ]
    case "google-generative-ai":
      return [
        { id: "gemini-2.5-pro", reasoning: true, input: "text-image" },
        { id: "gemini-2.5-flash", reasoning: false, input: "text-image" },
      ]
    default:
      return [
        { id: "gpt-5.1-mini", reasoning: false, input: "text" },
        { id: "gpt-5.1", reasoning: false, input: "text" },
        { id: "o4-mini", reasoning: true, input: "text" },
      ]
  }
}

const CURATED_BUILTINS: BuiltinProviderInfo[] = [
  {
    id: "anthropic",
    apiType: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    configured: false,
    models: cannedModels("", "anthropic-messages"),
  },
  {
    id: "openai",
    apiType: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    configured: false,
    models: cannedModels("", "openai-completions"),
  },
  {
    id: "gemini",
    apiType: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    configured: false,
    models: cannedModels("", "google-generative-ai"),
  },
  {
    id: "deepseek",
    apiType: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    configured: false,
    models: cannedModels("", "openai-completions").map((m) =>
      m.id === "o4-mini"
        ? { ...m, id: "deepseek-reasoner" }
        : { ...m, id: "deepseek-chat" }
    ),
  },
  {
    id: "kimi",
    apiType: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    configured: false,
    models: [
      { id: "kimi-k2.5", reasoning: true, input: "text" },
      { id: "kimi-latest", reasoning: false, input: "text" },
    ],
  },
  {
    id: "grok",
    apiType: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
    configured: false,
    models: [
      { id: "grok-4.5", reasoning: true, input: "text" },
      { id: "grok-composer-2.5-fast", reasoning: false, input: "text" },
    ],
  },
]

const SEED_RECORDS: ModelProviderRecord[] = [
  {
    providerId: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    enabled: true,
    models: [
      { id: "deepseek-chat", reasoning: false, input: "text" },
      { id: "deepseek-reasoner", reasoning: true, input: "text" },
    ],
    apiKeyMasked: maskApiKey("sk-demo-deepseek-0123456789"),
    hasApiKey: true,
    compatSupportsDeveloperRole: null,
  },
  {
    providerId: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    enabled: true,
    models: [
      {
        id: "openrouter/anthropic/claude-sonnet-4-5",
        reasoning: false,
        input: "text",
      },
      { id: "openrouter/openai/gpt-5.1", reasoning: false, input: "text" },
      {
        id: "openrouter/deepseek/deepseek-reasoner",
        reasoning: true,
        input: "text",
      },
    ],
    apiKeyMasked: maskApiKey("sk-or-demo-abcdef012345"),
    hasApiKey: true,
    compatSupportsDeveloperRole: null,
  },
  {
    providerId: "local-vllm",
    api: "openai-completions",
    baseUrl: "http://localhost:8000/v1",
    enabled: false,
    models: [{ id: "qwen2.5-72b-instruct", reasoning: false, input: "text" }],
    apiKeyMasked: "",
    hasApiKey: false,
    compatSupportsDeveloperRole: null,
  },
]

function nextCloneId(base: string, taken: Set<string>): string {
  let candidate = `${base}-2`
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`
  return candidate
}

export function createMockModelProviderService(): ModelProviderService {
  let records: ModelProviderRecord[] = deepClone(SEED_RECORDS)
  let builtins: BuiltinProviderInfo[] = deepClone(CURATED_BUILTINS)

  const refreshBuiltins = () => {
    builtins = builtins.map((b) => ({
      ...b,
      configured: records.some((r) => r.baseUrl === b.baseUrl && r.hasApiKey),
    }))
  }

  const toRecord = (
    draft: ModelProviderDraft,
    keepKey: string
  ): ModelProviderRecord => {
    const key = draft.apiKey.trim() || keepKey
    return {
      providerId: draft.providerId.trim(),
      api: draft.api,
      baseUrl: draft.baseUrl.trim(),
      proxy: draft.proxy?.trim() || undefined,
      enabled: draft.enabled,
      models: draft.models.map((m) => ({ ...m })),
      apiKeyMasked: key ? maskApiKey(key) : "",
      hasApiKey: !!key,
      compatSupportsDeveloperRole: draft.compatSupportsDeveloperRole,
    }
  }

  return {
    async list() {
      await delay(160)
      return deepClone(records)
    },

    async listBuiltins() {
      await delay(120)
      refreshBuiltins()
      return deepClone(builtins)
    },

    async create(draft) {
      await delay(220)
      const id = draft.providerId.trim()
      if (!id) throw new Error("Provider id is required")
      if (records.some((r) => r.providerId === id)) {
        throw new Error(`A provider with the id "${id}" already exists`)
      }
      const record = toRecord(draft, "")
      records = [...records, record]
      refreshBuiltins()
      return { record: deepClone(record), affectedRunningSessions: 0 }
    },

    async update(draft) {
      await delay(220)
      const id = draft.providerId.trim()
      const original = draft.originalId.trim()
      if (!id) throw new Error("Provider id is required")
      if (id !== original && records.some((r) => r.providerId === id)) {
        throw new Error(`A provider with the id "${id}" already exists`)
      }
      const existing = records.find((r) => r.providerId === original)
      if (!existing) throw new Error(`Provider "${original}" no longer exists`)
      const record = toRecord(draft, existing.apiKeyMasked ? "keep" : "")
      records = records.map((r) => (r.providerId === original ? record : r))
      refreshBuiltins()
      return { record: deepClone(record), affectedRunningSessions: 0 }
    },

    async remove(providerId) {
      await delay(180)
      records = records.filter((r) => r.providerId !== providerId)
      refreshBuiltins()
    },

    async setEnabled(providerId, enabled) {
      await delay(120)
      records = records.map((r) =>
        r.providerId === providerId ? { ...r, enabled } : r
      )
    },

    async reorder(providerIds) {
      await delay(120)
      const known = records.map((r) => r.providerId)
      const requested = new Set(providerIds)
      const reordered: ModelProviderRecord[] = []
      for (const id of providerIds) {
        const rec = records.find((r) => r.providerId === id)
        if (rec) reordered.push(rec)
      }
      for (const rec of records) {
        if (!requested.has(rec.providerId)) reordered.push(rec)
      }
      if (reordered.length === known.length) records = reordered
    },

    async probe(params: ProbeParams): Promise<ProbeOutcome> {
      await delay(400)
      const baseUrl = params.baseUrl.trim()
      if (!baseUrl) return { ok: false, error: "Base URL is required" }
      if (baseUrl.includes("fail")) {
        return { ok: false, error: "HTTP 401: unauthorized" }
      }
      return { ok: true, models: cannedModels(baseUrl, params.api) }
    },

    async test(
      providerId: string,
      modelId: string,
      apiKey?: string
    ): Promise<TestOutcome> {
      await delay(350)
      const id = providerId.trim()
      const mid = modelId.trim()
      if (!id || !mid)
        return { ok: false, error: "Provider and model id are required" }
      const record = records.find((r) => r.providerId === id)
      // A draft being edited (not yet saved) tests against the typed key.
      if (!record) {
        if (!apiKey) {
          return { ok: false, error: "No API key configured for this provider" }
        }
        return { ok: true, reply: `pong from ${mid}` }
      }
      if (!record.models.some((m) => m.id === mid)) {
        return { ok: false, error: `Model "${mid}" not in this provider` }
      }
      if (!apiKey && !record.hasApiKey) {
        return { ok: false, error: "No API key configured for this provider" }
      }
      return { ok: true, reply: `pong from ${mid}` }
    },

    async cloneBuiltin(builtinId) {
      await delay(300)
      const builtin = builtins.find((b) => b.id === builtinId)
      if (!builtin)
        throw new Error(`Built-in provider "${builtinId}" not found`)
      const taken = new Set(records.map((r) => r.providerId))
      return {
        providerId: nextCloneId(builtin.id, taken),
        originalId: "",
        api: builtin.apiType,
        baseUrl: builtin.baseUrl,
        apiKey: "",
        authHeader: true,
        compatSupportsDeveloperRole: null,
        enabled: true,
        models: builtin.models.map((m) => ({ ...m })),
      }
    },
  }
}

/** The page's single access point to the provider service. The mock is what the
 *  demo renders; the transport-backed implementation swaps in here later. */
export function useModelProviderService(): ModelProviderService {
  return useMemo(() => createMockModelProviderService(), [])
}

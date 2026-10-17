import { describe, expect, it } from "vitest"

import {
  DEFAULT_OPENAI_COMPATIBLE_NPM,
  applyApiKeyConnect,
  buildConnectedModelOptions,
  buildConnectedProviders,
  customProviderIdIssue,
  disconnectProvider,
  formatContextWindow,
  migrateSecretsToAuth,
  modelReferencesProvider,
  setProviderApiKey,
  setProviderEnabled,
} from "./opencode-connect"
import type { OpenCodeCatalogProvider } from "./types"

const CATALOG: OpenCodeCatalogProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    doc: "https://platform.openai.com/docs/models",
    auth_kind: "oauth",
    models: [
      {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        tool_call: true,
        context: 400000,
        cost_in: 1,
        cost_out: 8,
        cost_cache_read: null,
        cost_cache_write: null,
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENROUTER_API_KEY"],
    doc: null,
    auth_kind: "api",
    models: [
      {
        id: "moonshotai/kimi-k2",
        name: "Kimi K2",
        reasoning: false,
        tool_call: true,
        context: 200000,
        cost_in: 0.5,
        cost_out: 2,
        cost_cache_read: null,
        cost_cache_write: null,
      },
    ],
  },
]

describe("applyApiKeyConnect", () => {
  it("well-known provider writes only auth.json, leaves config empty", () => {
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: "",
      authJsonText: "",
      providerId: "openai",
      apiKey: "sk-test",
    })
    expect(configText).toBe("")
    expect(JSON.parse(authJsonText)).toEqual({
      openai: { type: "api", key: "sk-test" },
    })
  })

  it("custom provider writes a config block AND the auth key, never a key in config", () => {
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: "",
      authJsonText: "",
      providerId: "mygw",
      apiKey: "sk-secret",
      custom: {
        name: "My Gateway",
        baseUrl: "https://api.example.com/v1",
        modelIds: ["glm-4.6", "  ", "qwen3-coder"],
      },
    })
    const config = JSON.parse(configText)
    expect(config.provider.mygw).toEqual({
      npm: DEFAULT_OPENAI_COMPATIBLE_NPM,
      name: "My Gateway",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        "glm-4.6": { name: "glm-4.6" },
        "qwen3-coder": { name: "qwen3-coder" },
      },
    })
    // secret only in auth.json
    expect(config.provider.mygw.options.apiKey).toBeUndefined()
    expect(JSON.parse(authJsonText).mygw).toEqual({
      type: "api",
      key: "sk-secret",
    })
  })

  it("defaults custom name to the id and npm to openai-compatible", () => {
    const { configText } = applyApiKeyConnect({
      configText: "",
      authJsonText: "",
      providerId: "ollama",
      apiKey: "ollama",
      custom: { baseUrl: "http://localhost:11434/v1" },
    })
    const block = JSON.parse(configText).provider.ollama
    expect(block.name).toBe("ollama")
    expect(block.npm).toBe(DEFAULT_OPENAI_COMPATIBLE_NPM)
  })

  it("editing a well-known provider updates the key and sets a base URL override", () => {
    // Edit mode reuses applyApiKeyConnect: a rotated key replaces the old one
    // and a base URL override lands in the config block (no secret in config).
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: "",
      authJsonText: JSON.stringify({ openai: { type: "api", key: "old" } }),
      providerId: "openai",
      apiKey: "rotated",
      baseUrlOverride: "https://proxy.example/v1",
    })
    expect(JSON.parse(authJsonText).openai).toEqual({
      type: "api",
      key: "rotated",
    })
    const block = JSON.parse(configText).provider.openai
    expect(block.options.baseURL).toBe("https://proxy.example/v1")
    expect(block.options.apiKey).toBeUndefined()
  })

  it("omitting baseUrlOverride preserves an existing override (reconnect/rotate key)", () => {
    // Omitted (undefined) must NOT clear — only an explicit blank clears.
    const prior = JSON.stringify({
      provider: { openai: { options: { baseURL: "https://keep/v1" } } },
    })
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: "",
      providerId: "openai",
      apiKey: "rotated",
      // baseUrlOverride intentionally omitted
    })
    expect(JSON.parse(configText).provider.openai.options.baseURL).toBe(
      "https://keep/v1"
    )
    expect(JSON.parse(authJsonText).openai.key).toBe("rotated")
  })

  it("editing clears an existing base URL override when the field is blanked", () => {
    const prior = JSON.stringify({
      provider: { openai: { options: { baseURL: "https://old/v1" } } },
    })
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: JSON.stringify({ openai: { type: "api", key: "k" } }),
      providerId: "openai",
      apiKey: "k",
      baseUrlOverride: "",
    })
    // baseURL removed → the now-empty provider block is cleaned up entirely.
    expect(configText).toBe("")
    expect(JSON.parse(authJsonText).openai.key).toBe("k")
  })

  it("clearing the base URL keeps other provider options and unrelated config", () => {
    const prior = JSON.stringify({
      model: "openai/gpt-5",
      provider: {
        openai: { options: { baseURL: "https://old/v1", timeout: 1000 } },
      },
    })
    const { configText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: "",
      providerId: "openai",
      apiKey: "k",
      baseUrlOverride: "",
    })
    const config = JSON.parse(configText)
    expect(config.model).toBe("openai/gpt-5")
    expect(config.provider.openai.options.baseURL).toBeUndefined()
    expect(config.provider.openai.options.timeout).toBe(1000)
  })

  it("well-known base URL override writes a minimal block without a key", () => {
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: "",
      authJsonText: "",
      providerId: "anthropic",
      apiKey: "sk-ant",
      baseUrlOverride: "https://proxy.example/v1",
    })
    const block = JSON.parse(configText).provider.anthropic
    expect(block.options.baseURL).toBe("https://proxy.example/v1")
    expect(block.options.apiKey).toBeUndefined()
    expect(JSON.parse(authJsonText).anthropic.key).toBe("sk-ant")
  })

  it("preserves unrelated config and other providers", () => {
    const prior = JSON.stringify({
      model: "openai/gpt-5",
      provider: { existing: { npm: "x" } },
    })
    const { configText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: "",
      providerId: "openai",
      apiKey: "sk",
    })
    const config = JSON.parse(configText)
    expect(config.model).toBe("openai/gpt-5")
    expect(config.provider.existing).toEqual({ npm: "x" })
  })

  it("empty api key does not write an auth entry", () => {
    const { authJsonText } = applyApiKeyConnect({
      configText: "",
      authJsonText: "",
      providerId: "openai",
      apiKey: "   ",
    })
    expect(authJsonText).toBe("")
  })

  it("throws on empty provider id", () => {
    expect(() =>
      applyApiKeyConnect({
        configText: "",
        authJsonText: "",
        providerId: "  ",
        apiKey: "sk",
      })
    ).toThrow()
  })

  it("scrubs a stale options.apiKey for a well-known provider (no block written)", () => {
    // A leaked key already sits in opencode.json; reconnecting must remove it.
    const prior = JSON.stringify({
      provider: { openai: { options: { apiKey: "sk-leak" } } },
    })
    const { configText, authJsonText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: "",
      providerId: "openai",
      apiKey: "sk-new",
    })
    // The now-empty provider block is cleaned up entirely.
    expect(configText).toBe("")
    expect(JSON.parse(authJsonText).openai).toEqual({
      type: "api",
      key: "sk-new",
    })
  })

  it("scrubs options.apiKey but keeps a real provider block", () => {
    const prior = JSON.stringify({
      provider: {
        openai: { npm: "@ai-sdk/openai", options: { apiKey: "sk-leak" } },
      },
    })
    const { configText } = applyApiKeyConnect({
      configText: prior,
      authJsonText: "",
      providerId: "openai",
      apiKey: "sk-new",
    })
    const block = JSON.parse(configText).provider.openai
    expect(block.npm).toBe("@ai-sdk/openai")
    expect(block.options).toBeUndefined()
  })
})

describe("setProviderApiKey", () => {
  it("writes the key only to auth.json and scrubs config secrets", () => {
    const config = JSON.stringify({
      provider: {
        mygw: {
          npm: "x",
          options: { baseURL: "https://e/v1", apiKey: "sk-old" },
        },
      },
    })
    const result = setProviderApiKey({
      configText: config,
      authJsonText: "",
      providerId: "mygw",
      apiKey: "sk-new",
    })
    const block = JSON.parse(result.configText).provider.mygw
    expect(block.options).toEqual({ baseURL: "https://e/v1" })
    expect(block.options.apiKey).toBeUndefined()
    expect(JSON.parse(result.authJsonText).mygw).toEqual({
      type: "api",
      key: "sk-new",
    })
  })

  it("clearing the key removes the auth entry", () => {
    const result = setProviderApiKey({
      configText: "",
      authJsonText: JSON.stringify({ mygw: { type: "api", key: "k" } }),
      providerId: "mygw",
      apiKey: "  ",
    })
    expect(result.authJsonText).toBe("")
  })
})

describe("modelReferencesProvider", () => {
  it("matches provider/model and bare provider, not substrings", () => {
    expect(modelReferencesProvider("openai/gpt-5", "openai")).toBe(true)
    expect(modelReferencesProvider("openai", "openai")).toBe(true)
    expect(modelReferencesProvider("openrouter/x", "openai")).toBe(false)
    expect(modelReferencesProvider("openai-mirror/x", "openai")).toBe(false)
    expect(modelReferencesProvider(undefined, "openai")).toBe(false)
  })
})

describe("disconnectProvider", () => {
  it("removes the credential and keeps config by default", () => {
    const auth = JSON.stringify({ openai: { type: "api", key: "sk" } })
    const config = JSON.stringify({ provider: { openai: { npm: "x" } } })
    const result = disconnectProvider({
      configText: config,
      authJsonText: auth,
      providerId: "openai",
    })
    expect(result.authJsonText).toBe("")
    expect(JSON.parse(result.configText).provider.openai).toEqual({ npm: "x" })
  })

  it("removes the config block when requested and drops it from disabled list", () => {
    const config = JSON.stringify({
      provider: { mygw: { npm: "x" } },
      disabled_providers: ["mygw", "other"],
    })
    const result = disconnectProvider({
      configText: config,
      authJsonText: JSON.stringify({ mygw: { type: "api", key: "k" } }),
      providerId: "mygw",
      removeConfigBlock: true,
    })
    const parsed = JSON.parse(result.configText)
    expect(parsed.provider).toBeUndefined()
    expect(parsed.disabled_providers).toEqual(["other"])
    expect(result.authJsonText).toBe("")
  })

  it("clears model and small_model that point at the removed provider", () => {
    const config = JSON.stringify({
      model: "openai/gpt-5",
      small_model: "openai/gpt-5-mini",
      provider: { other: { npm: "x" } },
    })
    const result = disconnectProvider({
      configText: config,
      authJsonText: JSON.stringify({ openai: { type: "api", key: "k" } }),
      providerId: "openai",
    })
    const parsed = JSON.parse(result.configText)
    expect(parsed.model).toBeUndefined()
    expect(parsed.small_model).toBeUndefined()
    expect(parsed.provider.other).toEqual({ npm: "x" })
  })

  it("keeps model/small_model that point at other providers", () => {
    const config = JSON.stringify({
      model: "anthropic/claude",
      small_model: "openai/gpt-5-mini",
    })
    const result = disconnectProvider({
      configText: config,
      authJsonText: "",
      providerId: "openai",
    })
    const parsed = JSON.parse(result.configText)
    expect(parsed.model).toBe("anthropic/claude")
    expect(parsed.small_model).toBeUndefined()
  })
})

describe("setProviderEnabled", () => {
  it("disabling adds to disabled_providers", () => {
    const out = setProviderEnabled({
      configText: "",
      providerId: "openai",
      enabled: false,
    })
    expect(JSON.parse(out).disabled_providers).toEqual(["openai"])
  })

  it("enabling removes from disabled_providers and clears empty array", () => {
    const out = setProviderEnabled({
      configText: JSON.stringify({ disabled_providers: ["openai"] }),
      providerId: "openai",
      enabled: true,
    })
    expect(out).toBe("")
  })

  it("disabling is idempotent", () => {
    const once = setProviderEnabled({
      configText: "",
      providerId: "x",
      enabled: false,
    })
    const twice = setProviderEnabled({
      configText: once,
      providerId: "x",
      enabled: false,
    })
    expect(JSON.parse(twice).disabled_providers).toEqual(["x"])
  })
})

describe("migrateSecretsToAuth", () => {
  it("moves options.apiKey into auth.json and strips it from config", () => {
    const config = JSON.stringify({
      provider: {
        mygw: {
          npm: "x",
          options: { baseURL: "https://e/v1", apiKey: "sk-leak" },
        },
      },
    })
    const result = migrateSecretsToAuth({
      configText: config,
      authJsonText: "",
    })
    expect(result.changed).toBe(true)
    const parsed = JSON.parse(result.configText)
    expect(parsed.provider.mygw.options.apiKey).toBeUndefined()
    expect(parsed.provider.mygw.options.baseURL).toBe("https://e/v1")
    expect(JSON.parse(result.authJsonText).mygw).toEqual({
      type: "api",
      key: "sk-leak",
    })
  })

  it("does not overwrite an existing auth key", () => {
    const config = JSON.stringify({
      provider: { mygw: { options: { apiKey: "sk-config" } } },
    })
    const auth = JSON.stringify({ mygw: { type: "api", key: "sk-auth" } })
    const result = migrateSecretsToAuth({
      configText: config,
      authJsonText: auth,
    })
    expect(result.changed).toBe(true)
    expect(JSON.parse(result.authJsonText).mygw.key).toBe("sk-auth")
    expect(
      JSON.parse(result.configText).provider.mygw.options.apiKey
    ).toBeUndefined()
  })

  it("no-op when nothing to migrate", () => {
    const config = JSON.stringify({ provider: { x: { npm: "y" } } })
    const result = migrateSecretsToAuth({
      configText: config,
      authJsonText: "",
    })
    expect(result.changed).toBe(false)
    expect(result.configText).toBe(config)
  })
})

describe("buildConnectedProviders", () => {
  it("unions auth and config providers with the right auth kind", () => {
    const auth = JSON.stringify({
      openai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      openrouter: { type: "api", key: "sk" },
    })
    const config = JSON.stringify({
      provider: {
        mygw: {
          name: "My GW",
          npm: "n",
          options: { baseURL: "u" },
          models: { m1: {} },
        },
      },
      disabled_providers: ["openrouter"],
    })
    const list = buildConnectedProviders({
      configText: config,
      authJsonText: auth,
      catalog: CATALOG,
    })
    const byId = Object.fromEntries(list.map((p) => [p.id, p]))

    expect(byId.openai.authKind).toBe("oauth")
    expect(byId.openai.inCatalog).toBe(true)
    expect(byId.openai.hasConfigBlock).toBe(false)
    expect(byId.openai.enabled).toBe(true)

    expect(byId.openrouter.authKind).toBe("api")
    expect(byId.openrouter.enabled).toBe(false)

    expect(byId.mygw.name).toBe("My GW")
    expect(byId.mygw.authKind).toBe("none")
    expect(byId.mygw.inCatalog).toBe(false)
    expect(byId.mygw.hasConfigBlock).toBe(true)
    expect(byId.mygw.baseUrl).toBe("u")
    expect(byId.mygw.modelIds).toEqual(["m1"])
  })

  it("enabled_providers allowlist hides non-listed providers", () => {
    const auth = JSON.stringify({
      openai: { type: "api", key: "a" },
      openrouter: { type: "api", key: "b" },
    })
    const config = JSON.stringify({ enabled_providers: ["openai"] })
    const list = buildConnectedProviders({
      configText: config,
      authJsonText: auth,
      catalog: CATALOG,
    })
    const byId = Object.fromEntries(list.map((p) => [p.id, p]))
    expect(byId.openai.enabled).toBe(true)
    expect(byId.openrouter.enabled).toBe(false)
  })
})

describe("buildConnectedModelOptions", () => {
  it("offers catalog models for well-known plus custom models, skipping disabled", () => {
    const connected = buildConnectedProviders({
      configText: JSON.stringify({
        provider: { mygw: { name: "My GW", models: { "custom-x": {} } } },
        disabled_providers: ["openrouter"],
      }),
      authJsonText: JSON.stringify({
        openai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
        openrouter: { type: "api", key: "k" },
        mygw: { type: "api", key: "k2" },
      }),
      catalog: CATALOG,
    })
    const groups = buildConnectedModelOptions({ connected, catalog: CATALOG })
    const byProvider = Object.fromEntries(groups.map((g) => [g.providerId, g]))

    expect(byProvider.openai.models.map((m) => m.value)).toContain(
      "openai/gpt-5"
    )
    expect(byProvider.mygw.models.map((m) => m.value)).toContain(
      "mygw/custom-x"
    )
    // openrouter is disabled → no group
    expect(byProvider.openrouter).toBeUndefined()
  })

  it("attaches catalog metadata (context, reasoning) to model options", () => {
    const connected = buildConnectedProviders({
      configText: JSON.stringify({
        provider: { mygw: { name: "My GW", models: { "custom-x": {} } } },
      }),
      authJsonText: JSON.stringify({
        openai: { type: "api", key: "k" },
        mygw: { type: "api", key: "k2" },
      }),
      catalog: CATALOG,
    })
    const groups = buildConnectedModelOptions({ connected, catalog: CATALOG })
    const byProvider = Object.fromEntries(groups.map((g) => [g.providerId, g]))

    const gpt5 = byProvider.openai.models.find(
      (m) => m.value === "openai/gpt-5"
    )
    expect(gpt5?.context).toBe(400000)
    expect(gpt5?.reasoning).toBe(true)

    // custom config-only model has no catalog metadata
    const customModel = byProvider.mygw.models.find(
      (m) => m.value === "mygw/custom-x"
    )
    expect(customModel?.context).toBeNull()
    expect(customModel?.reasoning).toBe(false)
  })
})

describe("formatContextWindow", () => {
  it("formats thousands and millions compactly", () => {
    expect(formatContextWindow(128000)).toBe("128K")
    expect(formatContextWindow(200000)).toBe("200K")
    expect(formatContextWindow(1_000_000)).toBe("1M")
    expect(formatContextWindow(2_000_000)).toBe("2M")
    expect(formatContextWindow(1_500_000)).toBe("1.5M")
    expect(formatContextWindow(512)).toBe("512")
  })

  it("returns empty string for non-positive or non-finite values", () => {
    expect(formatContextWindow(0)).toBe("")
    expect(formatContextWindow(-1)).toBe("")
    expect(formatContextWindow(Number.NaN)).toBe("")
  })
})

describe("customProviderIdIssue", () => {
  const base = { existingProviderIds: ["my-proxy"], catalogIds: ["openai"] }

  it("accepts a fresh, well-formed, non-catalog id", () => {
    expect(customProviderIdIssue({ ...base, id: "acme-gw" })).toBeNull()
  })

  it("treats blank/whitespace ids as no issue (not yet entered)", () => {
    expect(customProviderIdIssue({ ...base, id: "" })).toBeNull()
    expect(customProviderIdIssue({ ...base, id: "   " })).toBeNull()
  })

  it("flags illegal characters", () => {
    expect(customProviderIdIssue({ ...base, id: "bad id" })).toBe("pattern")
    expect(customProviderIdIssue({ ...base, id: "a/b" })).toBe("pattern")
  })

  it("flags an already-defined provider id", () => {
    expect(customProviderIdIssue({ ...base, id: "my-proxy" })).toBe("exists")
  })

  it("rejects a catalog id — those connect via the catalog dialog", () => {
    expect(customProviderIdIssue({ ...base, id: "openai" })).toBe("in-catalog")
    // trimming applies before the catalog check
    expect(customProviderIdIssue({ ...base, id: "  openai  " })).toBe(
      "in-catalog"
    )
  })

  it("cannot flag a catalog id when the catalog is empty (loading/failed) — the UI must gate the custom dialog on catalog readiness so this check runs against a known set", () => {
    expect(
      customProviderIdIssue({ ...base, catalogIds: [], id: "openai" })
    ).toBeNull()
  })
})

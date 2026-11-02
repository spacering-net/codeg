import { describe, expect, it } from "vitest"

import {
  applyCustomProvider,
  buildConnectedModelOptions,
  buildConnectedProviders,
  customProviderIdIssue,
  formatContextWindow,
  isProviderEnabled,
  keyConnectableIntegrations,
  keyMethodOf,
  modelReferencesProvider,
  modelSelectionText,
  npmOfPackage,
  opencodeWildcardMatch,
  openCodeModelsProtocol,
  packageForNpm,
  providerBlockForEdit,
  readMainModel,
  readProviderBlocks,
  readSmallModel,
  removeProviderFromConfig,
  setMainModel,
  setProviderBlockBaseUrl,
  setProviderBlockNpm,
  setProviderEnabled,
  setSmallModel,
  setWellKnownBaseUrl,
  visibleKeyFields,
} from "./opencode-connect"
import type { OpenCodeCatalogProvider, OpenCodeIntegration } from "./types"

type Json = Record<string, unknown>

const CATALOG: OpenCodeCatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    doc: null,
    auth_kind: "api",
    models: [
      {
        id: "claude-x",
        name: "Claude X",
        reasoning: true,
        tool_call: true,
        context: 200000,
        cost_in: null,
        cost_out: null,
        cost_cache_read: null,
        cost_cache_write: null,
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPSEEK_API_KEY"],
    doc: null,
    auth_kind: "api",
    models: [],
  },
]

function integration(
  id: string,
  connections: OpenCodeIntegration["connections"] = [],
  methods: OpenCodeIntegration["methods"] = [{ type: "key" }]
): OpenCodeIntegration {
  return { id, name: id.toUpperCase(), methods, connections }
}

describe("packages", () => {
  it("names AI SDK packages the way OpenCode 2 loads them", () => {
    expect(packageForNpm("@ai-sdk/openai-compatible")).toBe(
      "aisdk:@ai-sdk/openai-compatible"
    )
    expect(packageForNpm("aisdk:@ai-sdk/openai")).toBe("aisdk:@ai-sdk/openai")
    expect(packageForNpm("@opencode/ai/openai")).toBe("@opencode/ai/openai")
    expect(packageForNpm("  ")).toBe("")
    expect(npmOfPackage("aisdk:@ai-sdk/anthropic")).toBe("@ai-sdk/anthropic")
    expect(npmOfPackage("@opencode/ai/openai")).toBe("@opencode/ai/openai")
  })

  it("keeps the model-listing protocol by package", () => {
    expect(openCodeModelsProtocol("@ai-sdk/anthropic")).toBe("anthropic")
    expect(openCodeModelsProtocol("@ai-sdk/google")).toBe("gemini")
    expect(openCodeModelsProtocol("@ai-sdk/amazon-bedrock")).toBeNull()
    expect(openCodeModelsProtocol("@ai-sdk/openai-compatible")).toBe("openai")
  })
})

describe("provider blocks", () => {
  it("reads both shapes, with the 2.x block winning an id both name", () => {
    const config: Json = {
      provider: {
        old: {
          npm: "@ai-sdk/openai-compatible",
          name: "Old",
          options: { baseURL: "https://old/v1" },
          models: { m1: { name: "M1" } },
        },
        apionly: { api: "https://api-alias/v1" },
        both: { name: "Legacy copy" },
      },
      providers: {
        both: {
          name: "Native copy",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: "https://native/v1" },
          models: { m2: { name: "M2", modelID: "real-m2" } },
        },
      },
    }
    const blocks = readProviderBlocks(config)
    expect(blocks.old).toMatchObject({
      shape: "legacy",
      name: "Old",
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://old/v1",
      modelIds: ["m1"],
    })
    // 1.x's `api` is a base URL OpenCode 2 migrates to settings.baseURL.
    expect(blocks.apionly.baseUrl).toBe("https://api-alias/v1")
    expect(blocks.both).toMatchObject({
      shape: "native",
      name: "Native copy",
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://native/v1",
      modelIds: ["m2"],
    })
    // `modelID` is the 2.x alias, not an extra field.
    expect(blocks.both.models.m2.extraFieldCount).toBe(0)
  })

  it("edits a block in the shape it is in and creates new ones natively", () => {
    const config: Json = { provider: { old: { npm: "x" } } }
    const legacy = providerBlockForEdit(config, "old")
    expect(legacy.shape).toBe("legacy")
    setProviderBlockNpm(legacy.block, legacy.shape, "@ai-sdk/openai")
    setProviderBlockBaseUrl(legacy.block, legacy.shape, "https://old/v2")
    expect(config.provider).toEqual({
      old: { npm: "@ai-sdk/openai", options: { baseURL: "https://old/v2" } },
    })

    const fresh = providerBlockForEdit(config, "new")
    expect(fresh.shape).toBe("native")
    setProviderBlockNpm(fresh.block, fresh.shape, "@ai-sdk/openai-compatible")
    setProviderBlockBaseUrl(fresh.block, fresh.shape, "https://new/v1")
    expect(config.providers).toEqual({
      new: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: "https://new/v1" },
      },
    })
    // Clearing the URL prunes the emptied settings object.
    setProviderBlockBaseUrl(fresh.block, fresh.shape, "")
    expect(fresh.block).toEqual({ package: "aisdk:@ai-sdk/openai-compatible" })
  })

  it("writes a new custom provider in 2.x's shape", () => {
    const config: Json = {}
    applyCustomProvider(config, {
      id: "relay",
      name: "Relay",
      baseUrl: "https://relay/v1",
      modelIds: ["a", " ", "b"],
    })
    expect(config).toEqual({
      providers: {
        relay: {
          name: "Relay",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: "https://relay/v1" },
          models: { a: { name: "a" }, b: { name: "b" } },
        },
      },
    })
    expect(() => applyCustomProvider(config, { id: " " })).toThrow()
  })
})

describe("models", () => {
  it("reads both selection forms", () => {
    expect(modelSelectionText("a/b")).toBe("a/b")
    expect(
      modelSelectionText({ providerID: "a", model: "b", variant: "high" })
    ).toBe("a/b#high")
    expect(modelSelectionText({ providerID: "a" })).toBe("")
    expect(modelReferencesProvider("relay/x", "relay")).toBe(true)
    expect(modelReferencesProvider("relayx/x", "relay")).toBe(false)
    expect(
      modelReferencesProvider({ providerID: "relay", model: "x" }, "relay")
    ).toBe(true)
  })

  it("writes the small model as the title agent's", () => {
    const config: Json = {
      small_model: "a/old",
      agents: { build: { steps: 3 } },
    }
    expect(readSmallModel(config)).toBe("a/old")
    setSmallModel(config, "a/new")
    expect(config).toEqual({
      agents: { build: { steps: 3 }, title: { model: "a/new" } },
    })
    expect(readSmallModel(config)).toBe("a/new")
    setSmallModel(config, "")
    expect(config).toEqual({ agents: { build: { steps: 3 } } })

    const main: Json = {}
    setMainModel(main, " p/m ")
    expect(readMainModel(main)).toBe("p/m")
    setMainModel(main, "")
    expect(main).toEqual({})
  })
})

describe("policies", () => {
  it("matches resources the way OpenCode's wildcard does", () => {
    expect(opencodeWildcardMatch("anthropic", "*")).toBe(true)
    expect(opencodeWildcardMatch("anthropic", "anth*")).toBe(true)
    expect(opencodeWildcardMatch("anthropic", "anthropi?")).toBe(true)
    expect(opencodeWildcardMatch("anthropic", "openai")).toBe(false)
    expect(opencodeWildcardMatch("a.b", "a?b")).toBe(true)
    expect(opencodeWildcardMatch("ab", "a.b")).toBe(false)
  })

  it("decides by the last matching rule, legacy lists first", () => {
    expect(isProviderEnabled({}, "x")).toBe(true)
    expect(isProviderEnabled({ disabled_providers: ["x"] }, "x")).toBe(false)
    expect(isProviderEnabled({ enabled_providers: ["y"] }, "x")).toBe(false)
    expect(isProviderEnabled({ enabled_providers: ["x"] }, "x")).toBe(true)
    // An explicitly empty allow-list allows nothing.
    expect(isProviderEnabled({ enabled_providers: [] }, "x")).toBe(false)
    expect(
      isProviderEnabled(
        {
          disabled_providers: ["x"],
          policies: [
            { action: "provider.use", resource: "x", effect: "allow" },
          ],
        },
        "x"
      )
    ).toBe(true)
    expect(
      isProviderEnabled(
        {
          policies: [
            { action: "provider.use", resource: "*", effect: "deny" },
            { action: "tool.use", resource: "x", effect: "allow" },
          ],
        },
        "x"
      )
    ).toBe(false)
  })

  it("toggles with the fewest rules and drops legacy entries it replaces", () => {
    const config: Json = { disabled_providers: ["x", "y"] }
    setProviderEnabled(config, "x", true)
    expect(config).toEqual({ disabled_providers: ["y"] })

    setProviderEnabled(config, "z", false)
    expect(config.policies).toEqual([
      { action: "provider.use", resource: "z", effect: "deny" },
    ])
    setProviderEnabled(config, "z", true)
    expect(config.policies).toBeUndefined()

    // Under a wildcard deny, enabling needs an explicit allow.
    const strict: Json = {
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
    }
    setProviderEnabled(strict, "a", true)
    expect(strict.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "a", effect: "allow" },
    ])
    expect(isProviderEnabled(strict, "a")).toBe(true)
    expect(isProviderEnabled(strict, "b")).toBe(false)
  })

  // Emptying a 1.x allow-list must not lift it: dropping the key would let
  // OpenCode use every provider the list kept out.
  it("keeps an allow-list restrictive when its last provider is disabled", () => {
    const config: Json = { enabled_providers: ["anthropic"] }
    setProviderEnabled(config, "anthropic", false)
    expect(config).toEqual({ enabled_providers: [] })
    expect(isProviderEnabled(config, "anthropic")).toBe(false)
    expect(isProviderEnabled(config, "openai")).toBe(false)

    setProviderEnabled(config, "anthropic", true)
    expect(isProviderEnabled(config, "anthropic")).toBe(true)
    expect(isProviderEnabled(config, "openai")).toBe(false)

    const removed: Json = { enabled_providers: ["anthropic"] }
    removeProviderFromConfig(removed, "anthropic")
    expect(removed).toEqual({ enabled_providers: [] })
  })

  it("reads 1.x provider ids OpenCode 2 renamed", () => {
    const config: Json = { enabled_providers: ["azure-cognitive-services"] }
    expect(isProviderEnabled(config, "azure")).toBe(true)
    expect(
      isProviderEnabled(
        { disabled_providers: ["google-vertex-anthropic"] },
        "google-vertex"
      )
    ).toBe(false)
    setProviderEnabled(config, "azure", false)
    expect(config).toEqual({ enabled_providers: [] })
  })

  // A 1.x `provider` block under a retired id is the renamed provider at run
  // time, so its row reads and toggles that provider's rules.
  it("toggles a provider row kept under a retired 1.x id", () => {
    const config: Json = {
      provider: { "azure-cognitive-services": { npm: "@ai-sdk/azure" } },
      disabled_providers: ["azure-cognitive-services"],
    }
    expect(isProviderEnabled(config, "azure-cognitive-services")).toBe(false)
    setProviderEnabled(config, "azure-cognitive-services", true)
    expect(config.disabled_providers).toBeUndefined()
    expect(isProviderEnabled(config, "azure-cognitive-services")).toBe(true)
    expect(isProviderEnabled(config, "azure")).toBe(true)

    setProviderEnabled(config, "azure-cognitive-services", false)
    expect(config.policies).toEqual([
      { action: "provider.use", resource: "azure", effect: "deny" },
    ])
    expect(isProviderEnabled(config, "azure-cognitive-services")).toBe(false)

    const allowed: Json = {
      provider: { "google-vertex-anthropic": {} },
      enabled_providers: ["google-vertex-anthropic", "anthropic"],
    }
    expect(isProviderEnabled(allowed, "google-vertex-anthropic")).toBe(true)
    setProviderEnabled(allowed, "google-vertex-anthropic", false)
    expect(allowed.enabled_providers).toEqual(["anthropic"])
    expect(isProviderEnabled(allowed, "google-vertex-anthropic")).toBe(false)
    expect(isProviderEnabled(allowed, "anthropic")).toBe(true)

    const removed: Json = {
      provider: { "azure-cognitive-services": {} },
      disabled_providers: ["azure-cognitive-services", "x"],
      model: "azure/gpt-5",
    }
    removeProviderFromConfig(removed, "azure-cognitive-services")
    expect(removed).toEqual({ disabled_providers: ["x"], model: "azure/gpt-5" })
  })

  // A native `providers` block keeps its key, retired id or not: its row is
  // that provider, and Azure's rules are not its rules.
  it("leaves a native block under a retired id its own key", () => {
    const config: Json = {
      providers: { "azure-cognitive-services": { name: "Old Azure" } },
      disabled_providers: ["azure-cognitive-services"],
    }
    // The 1.x list entry names Azure, not this provider.
    expect(isProviderEnabled(config, "azure-cognitive-services")).toBe(true)
    expect(isProviderEnabled(config, "azure")).toBe(false)

    setProviderEnabled(config, "azure-cognitive-services", false)
    expect(config.policies).toEqual([
      {
        action: "provider.use",
        resource: "azure-cognitive-services",
        effect: "deny",
      },
    ])
    expect(config.disabled_providers).toEqual(["azure-cognitive-services"])
    expect(isProviderEnabled(config, "azure-cognitive-services")).toBe(false)

    const removed: Json = {
      providers: { "google-vertex-anthropic": {} },
      policies: [
        { action: "provider.use", resource: "google-vertex", effect: "deny" },
      ],
      model: "google-vertex/gemini-3",
    }
    removeProviderFromConfig(removed, "google-vertex-anthropic")
    expect(removed).toEqual({
      policies: [
        { action: "provider.use", resource: "google-vertex", effect: "deny" },
      ],
      model: "google-vertex/gemini-3",
    })
  })
})

describe("writing and removing providers", () => {
  it("sets, keeps and clears a base URL override", () => {
    const config: Json = {}
    setWellKnownBaseUrl(config, "anthropic", undefined)
    setWellKnownBaseUrl(config, "anthropic", "")
    expect(config).toEqual({})
    setWellKnownBaseUrl(config, "anthropic", "https://proxy/v1")
    expect(config).toEqual({
      providers: { anthropic: { settings: { baseURL: "https://proxy/v1" } } },
    })
    // Reconnecting with a new key leaves the override alone.
    setWellKnownBaseUrl(config, "anthropic", undefined)
    expect(config).toEqual({
      providers: { anthropic: { settings: { baseURL: "https://proxy/v1" } } },
    })
    setWellKnownBaseUrl(config, "anthropic", "")
    expect(config).toEqual({})
  })

  it("forgets a provider everywhere the config names it", () => {
    const config: Json = {
      model: "relay/x",
      agents: { title: { model: "relay/y" } },
      provider: { relay: { npm: "x" }, keep: { npm: "y" } },
      providers: { relay: { name: "Relay" } },
      policies: [
        { action: "provider.use", resource: "relay", effect: "deny" },
        { action: "provider.use", resource: "other", effect: "deny" },
      ],
      disabled_providers: ["relay"],
    }
    removeProviderFromConfig(config, "relay")
    expect(config).toEqual({
      provider: { keep: { npm: "y" } },
      policies: [{ action: "provider.use", resource: "other", effect: "deny" }],
    })
  })
})

describe("integrations and the panel view", () => {
  it("finds key methods and the fields they ask for", () => {
    const azure = integration(
      "azure",
      [],
      [
        {
          type: "key",
          label: "API key",
          form: [
            { key: "resourceName", type: "string", required: true },
            { key: "region", type: "string", hidden: true, default: "eastus" },
          ],
        },
        { type: "env", names: ["AZURE_API_KEY"] },
      ]
    )
    expect(keyMethodOf(azure)?.label).toBe("API key")
    expect(visibleKeyFields(keyMethodOf(azure)).map((f) => f.key)).toEqual([
      "resourceName",
    ])
    const envOnly = integration(
      "copilot",
      [],
      [{ type: "env", names: ["GITHUB_TOKEN"] }]
    )
    expect(keyMethodOf(envOnly)).toBeNull()
    expect(
      keyConnectableIntegrations([integration("zed"), envOnly, azure]).map(
        (i) => i.id
      )
    ).toEqual(["azure", "zed"])
  })

  it("lists connected integrations and the config's providers", () => {
    const config: Json = {
      providers: {
        relay: {
          name: "Relay",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: "https://relay/v1" },
          models: { "relay-1": { name: "R1" } },
        },
      },
      policies: [
        { action: "provider.use", resource: "deepseek", effect: "deny" },
      ],
    }
    const integrations = [
      integration("anthropic", [
        {
          type: "credential",
          id: "c1",
          label: "A",
          method: "key",
          active: true,
        },
        { type: "env", name: "ANTHROPIC_API_KEY", active: false },
      ]),
      integration("deepseek", [
        { type: "env", name: "DEEPSEEK_API_KEY", active: true },
      ]),
      integration("openai"),
      integration("relay"),
    ]
    const connected = buildConnectedProviders({
      config,
      integrations,
      catalog: CATALOG,
    })
    expect(connected.map((p) => p.id)).toEqual([
      "anthropic",
      "deepseek",
      "relay",
    ])
    const [anthropic, deepseek, relay] = connected
    expect(anthropic).toMatchObject({
      name: "ANTHROPIC",
      connection: "key",
      credentialCount: 1,
      enabled: true,
      inCatalog: true,
      hasConfigBlock: false,
    })
    expect(deepseek).toMatchObject({
      connection: "env",
      envName: "DEEPSEEK_API_KEY",
      credentialCount: 0,
      enabled: false,
    })
    expect(relay).toMatchObject({
      name: "Relay",
      connection: "none",
      inCatalog: false,
      hasConfigBlock: true,
      shape: "native",
      baseUrl: "https://relay/v1",
      npm: "@ai-sdk/openai-compatible",
      modelIds: ["relay-1"],
    })

    const groups = buildConnectedModelOptions({ connected, catalog: CATALOG })
    // DeepSeek is disabled; anthropic offers its catalog models, relay its own.
    expect(groups.map((g) => g.providerId)).toEqual(["anthropic", "relay"])
    expect(groups[0].models[0]).toMatchObject({
      value: "anthropic/claude-x",
      context: 200000,
      reasoning: true,
    })
    expect(groups[1].models.map((m) => m.value)).toEqual(["relay/relay-1"])
  })

  it("filters disabled configured and catalog models by provider and config ID", () => {
    const connected = buildConnectedProviders({
      config: {
        provider: {
          anthropic: { models: { enabled: { disabled: true } } },
        },
        providers: {
          anthropic: {
            blacklist: ["enabled"],
            models: {
              "claude-x": { disabled: true },
              "vendor/hidden": { disabled: true },
              enabled: { disabled: false, modelID: "claude-x" },
              implicit: {},
              malformed: { disabled: "true" },
            },
          },
          relay: { models: { "claude-x": {} } },
        },
      },
      integrations: [],
      catalog: CATALOG,
    })
    const groups = buildConnectedModelOptions({ connected, catalog: CATALOG })
    expect(groups.flatMap((group) => group.models.map((m) => m.value))).toEqual(
      [
        "anthropic/enabled",
        "anthropic/implicit",
        "anthropic/malformed",
        "relay/claude-x",
      ]
    )
  })

  it.each([{ catalog: [] }, { catalog: CATALOG }])(
    "omits providers with only disabled models (catalog size: $catalog.length)",
    ({ catalog }) => {
      const connected = buildConnectedProviders({
        config: {
          providers: {
            anthropic: { models: { "claude-x": { disabled: true } } },
          },
        },
        integrations: [],
        catalog,
      })
      expect(buildConnectedModelOptions({ connected, catalog })).toEqual([])
    }
  )
})

describe("custom provider ids and labels", () => {
  it("validates a new custom provider id", () => {
    const base = { existingProviderIds: ["relay"], catalogIds: ["anthropic"] }
    expect(customProviderIdIssue({ ...base, id: "" })).toBeNull()
    expect(customProviderIdIssue({ ...base, id: "bad id" })).toBe("pattern")
    expect(customProviderIdIssue({ ...base, id: "relay" })).toBe("exists")
    expect(customProviderIdIssue({ ...base, id: "anthropic" })).toBe(
      "in-catalog"
    )
    expect(customProviderIdIssue({ ...base, id: "my-relay.v2" })).toBeNull()
  })

  it("formats context windows compactly", () => {
    expect(formatContextWindow(200000)).toBe("200K")
    expect(formatContextWindow(1_000_000)).toBe("1M")
    expect(formatContextWindow(1_500_000)).toBe("1.5M")
    expect(formatContextWindow(0)).toBe("")
  })
})

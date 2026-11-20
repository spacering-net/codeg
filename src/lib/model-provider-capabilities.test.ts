import { describe, expect, it } from "vitest"

import {
  countCompatibleModelProviders,
  getModelProviderApiTypes,
  MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES,
  supportsModelProviderSourceCard,
} from "./model-provider-capabilities"
import type { ModelProviderRecord } from "./model-provider-types"

function provider(
  overrides: Partial<ModelProviderRecord> = {}
): ModelProviderRecord {
  return {
    providerId: "provider",
    api: "openai-completions",
    baseUrl: "https://example.test",
    enabled: true,
    models: [{ id: "model", reasoning: false, input: "text" }],
    apiKeyMasked: "",
    hasApiKey: true,
    compatSupportsDeveloperRole: null,
    ...overrides,
  }
}

describe("model provider capabilities", () => {
  it("declares supported API families per agent", () => {
    expect(getModelProviderApiTypes("claude_code")).toEqual([
      "anthropic-messages",
    ])
    expect(getModelProviderApiTypes("codex")).toEqual(["openai-responses"])
  })

  // Custom agents project env-only on the backend, and the families are the
  // backend's per-definition verdict — a verified contract pins what the CLI
  // speaks (glm-acp-agent is Chat Completions only), a user declaration is
  // permissive, and an agent codeg cannot project into has none.
  it("reads a custom agent's API families from the backend verdict", () => {
    const qwenFamilies = [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ] as const
    expect(getModelProviderApiTypes("custom:qwen-code", qwenFamilies)).toEqual([
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ])
    expect(
      getModelProviderApiTypes("custom:glm-acp-agent", ["openai-completions"])
    ).toEqual(["openai-completions"])
    expect(getModelProviderApiTypes("custom:kilo")).toEqual([])
    expect(getModelProviderApiTypes("custom:minimax-code")).toEqual([])
  })

  it("counts enabled providers with a matching API and at least one model", () => {
    const providers = [
      provider({ providerId: "match", api: "openai-responses" }),
      provider({ providerId: "wrong-api", api: "anthropic-messages" }),
      provider({ providerId: "disabled", enabled: false }),
      provider({ providerId: "empty", models: [] }),
    ]
    expect(countCompatibleModelProviders(providers, "codex")).toBe(1)
    // Custom agents match every family the backend granted them…
    expect(
      countCompatibleModelProviders(providers, "custom:qwen-code", [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ])
    ).toBe(2)
    // …and a Chat-Completions-only agent is not offered the Responses provider
    // it could never use.
    expect(
      countCompatibleModelProviders(providers, "custom:glm-acp-agent", [
        "openai-completions",
      ])
    ).toBe(0)
    expect(countCompatibleModelProviders(providers, "custom:kilo")).toBe(0)
  })

  it("offers the settings source card only where a projection can land", () => {
    expect(supportsModelProviderSourceCard("codex")).toBe(true)
    expect(
      supportsModelProviderSourceCard("custom:qwen-code", [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ])
    ).toBe(true)
    expect(
      supportsModelProviderSourceCard("custom:glm-acp-agent", [
        "openai-completions",
      ])
    ).toBe(true)
    // Verified non-readers: no option, so nothing silently half-applies.
    expect(supportsModelProviderSourceCard("custom:kilo")).toBe(false)
    expect(supportsModelProviderSourceCard("custom:minimax-code")).toBe(false)
    expect(supportsModelProviderSourceCard("cursor")).toBe(false)
  })

  // Codex has declared API families but no source card, so its settings panel
  // could never flip agent_setting.model_source and the composer picker never
  // appeared (the panel's own "model provider" auth mode is a legacy binding).
  it("gives codex a settings source card", () => {
    expect(MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES).toContain("codex")
  })

  it("gives Claude a settings source card", () => {
    expect(MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES).toContain("claude_code")
  })
})

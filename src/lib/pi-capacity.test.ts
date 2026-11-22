import { describe, expect, it } from "vitest"

import type { ListedProviderModel, ModelCatalogEntry } from "@/lib/types"

import { piModelCapacity } from "./pi-capacity"

function catalog(
  overrides: Partial<ModelCatalogEntry> = {}
): ModelCatalogEntry {
  return {
    id: "openai/gpt-5",
    model: "gpt-5",
    provider: "openai",
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    reasoningEffortLevels: ["low", "high"],
    defaultReasoningEffort: "high",
    supportsVision: true,
    supportsFunctionCalling: true,
    ...overrides,
  }
}

const listed = (
  overrides: Partial<ListedProviderModel> = {}
): ListedProviderModel => ({
  id: "gpt-5",
  ...overrides,
})

describe("piModelCapacity", () => {
  it("prefers the provider's contextWindow over litellm", () => {
    const result = piModelCapacity(
      "gpt-5",
      [listed({ id: "gpt-5", contextWindow: 999000 })],
      [catalog()]
    )
    expect(result.contextWindow).toBe(999000)
    // provider listings carry no output cap, so maxTokens still comes from litellm.
    expect(result.maxTokens).toBe(128000)
  })

  it("falls back to litellm's maxInputTokens when the provider has no capacity", () => {
    const result = piModelCapacity("gpt-5", [listed()], [catalog()])
    expect(result.contextWindow).toBe(272000)
    expect(result.maxTokens).toBe(128000)
  })

  it("matches by the unprefixed model id and case-insensitively", () => {
    const result = piModelCapacity(
      "openai/GPT-5",
      [],
      [catalog({ id: "openai/gpt-5", model: "gpt-5" })]
    )
    expect(result.contextWindow).toBe(272000)
    expect(result.maxTokens).toBe(128000)
  })

  it("returns only what is known when litellm has no entry", () => {
    expect(piModelCapacity("mystery-model", [], [])).toEqual({})
    expect(
      piModelCapacity("gpt-5", [listed({ contextWindow: 400000 })], [])
    ).toEqual({ contextWindow: 400000 })
  })

  it("ignores non-positive and malformed values", () => {
    const result = piModelCapacity(
      "gpt-5",
      [listed({ contextWindow: 0 })],
      [catalog({ maxInputTokens: -1, maxOutputTokens: null })]
    )
    expect(result).toEqual({})
  })
})

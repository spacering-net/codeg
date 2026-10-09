import { describe, expect, it } from "vitest"

import {
  buildRateIndex,
  estimateItemCost,
  estimateReportCost,
  pickRate,
  resolveRate,
  type ModelApiRate,
} from "./model-api-rates"
import type { OpenCodeCatalogProvider, TokenUsageBreakdownItem } from "./types"

function model(
  over: Partial<OpenCodeCatalogProvider["models"][number]> & { id: string }
): OpenCodeCatalogProvider["models"][number] {
  return {
    name: over.id,
    reasoning: false,
    tool_call: true,
    context: 200_000,
    cost_in: 3,
    cost_out: 15,
    cost_cache_read: 0.3,
    cost_cache_write: 3.75,
    ...over,
  }
}

function provider(
  id: string,
  models: OpenCodeCatalogProvider["models"],
  over: Partial<OpenCodeCatalogProvider> = {}
): OpenCodeCatalogProvider {
  return {
    id,
    name: id,
    npm: null,
    env: [],
    doc: null,
    auth_kind: "api",
    models,
    ...over,
  }
}

function item(
  key: string,
  over: Partial<TokenUsageBreakdownItem> = {}
): TokenUsageBreakdownItem {
  return {
    key,
    label: key,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    turn_count: 1,
    conversation_count: 1,
    ...over,
  }
}

function rate(over: Partial<ModelApiRate> = {}): ModelApiRate {
  return {
    providerId: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...over,
  }
}

const CATALOG: OpenCodeCatalogProvider[] = [
  provider("anthropic", [
    model({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    }),
  ]),
  provider("openrouter", [
    model({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      cost_in: 3.3,
      cost_out: 16.5,
      cost_cache_read: 0.33,
      cost_cache_write: 4.125,
    }),
    model({
      id: "gpt-5",
      name: "GPT-5",
      cost_in: 1.25,
      cost_out: 10,
      cost_cache_read: 0.125,
      cost_cache_write: null,
    }),
  ]),
  provider("openai", [
    model({
      id: "gpt-5",
      name: "GPT-5",
      cost_in: 1.25,
      cost_out: 10,
      cost_cache_read: 0.125,
      cost_cache_write: null,
    }),
    model({
      id: "gpt-5.3",
      name: "GPT-5.3",
      cost_in: 1.75,
      cost_out: 14,
      cost_cache_read: 0.175,
      cost_cache_write: null,
    }),
  ]),
  provider("xai", [
    model({
      id: "grok-4",
      name: "Grok 4",
      cost_in: 3,
      cost_out: 15,
      cost_cache_read: 0.75,
      cost_cache_write: null,
    }),
  ]),
]

describe("resolveRate", () => {
  const index = buildRateIndex(CATALOG)

  it("matches an exact catalog id", () => {
    expect(resolveRate(index, "claude-sonnet-4-5")?.providerId).toBe(
      "anthropic"
    )
  })

  it("strips a dated snapshot suffix", () => {
    expect(resolveRate(index, "claude-sonnet-4-5-20250929")?.id).toBe(
      "claude-sonnet-4-5"
    )
  })

  it("honors an explicit provider prefix", () => {
    expect(resolveRate(index, "openrouter/claude-sonnet-4-5")?.providerId).toBe(
      "openrouter"
    )
  })

  it("matches a display name", () => {
    expect(resolveRate(index, "Claude Sonnet 4.5")?.id).toBe(
      "claude-sonnet-4-5"
    )
  })

  it("does not let gpt-5 steal gpt-5.3", () => {
    expect(resolveRate(index, "gpt-5.3")?.id).toBe("gpt-5.3")
    expect(resolveRate(index, "gpt-5")?.id).toBe("gpt-5")
  })

  it("accepts a numeric build suffix on an otherwise exact id", () => {
    expect(resolveRate(index, "grok-4-0709")?.id).toBe("grok-4")
  })

  it("does not invent a rate for an unknown or folded key", () => {
    expect(resolveRate(index, "mystery-model-9")).toBeNull()
    expect(resolveRate(index, "__unknown__")).toBeNull()
    expect(resolveRate(index, "__other__")).toBeNull()
    expect(resolveRate(index, "")).toBeNull()
  })
})

describe("pickRate", () => {
  it("prefers the lab listing when two providers disagree", () => {
    expect(
      pickRate([
        rate({ providerId: "openrouter", input: 9 }),
        rate({ providerId: "anthropic", input: 3 }),
      ])?.providerId
    ).toBe("anthropic")
  })

  it("refuses to guess when two official listings disagree", () => {
    expect(
      pickRate([
        rate({ providerId: "anthropic", input: 3 }),
        rate({ providerId: "amazon-bedrock", input: 3.6 }),
      ])
    ).toBeNull()
  })

  it("collapses identical prices", () => {
    expect(
      pickRate([
        rate({ providerId: "openrouter" }),
        rate({ providerId: "anthropic" }),
      ])?.providerId
    ).toBe("anthropic")
  })
})

describe("estimateItemCost", () => {
  it("applies the four official list buckets", () => {
    const cost = estimateItemCost(
      item("claude-sonnet-4-5", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
      }),
      rate()
    )
    expect(cost.usd).toBeCloseTo(3 + 15 + 3.75 + 0.3)
    expect(cost.pricedTokens).toBe(4_000_000)
    expect(cost.unpricedTokens).toBe(0)
  })

  it("leaves cache tokens unpriced when the catalog omitted that rate", () => {
    const cost = estimateItemCost(
      item("gpt-5", {
        input_tokens: 1_000_000,
        cache_read_tokens: 500_000,
        cache_creation_tokens: 100_000,
      }),
      rate({ cacheRead: null, cacheWrite: null, input: 1.25, output: 10 })
    )
    expect(cost.usd).toBeCloseTo(1.25)
    expect(cost.pricedTokens).toBe(1_000_000)
    expect(cost.unpricedTokens).toBe(600_000)
  })

  it("returns no dollar amount when nothing could be priced", () => {
    const cost = estimateItemCost(
      item("mystery", { input_tokens: 10, output_tokens: 4 }),
      null
    )
    expect(cost.usd).toBeNull()
    expect(cost.unpricedTokens).toBe(14)
  })
})

describe("estimateReportCost", () => {
  const index = buildRateIndex(CATALOG)

  it("sums only the priced models and reports coverage", () => {
    const report = estimateReportCost(
      [
        item("claude-sonnet-4-5", {
          input_tokens: 1_000_000,
          total_tokens: 1_000_000,
        }),
        item("mystery-model", {
          input_tokens: 250_000,
          total_tokens: 250_000,
        }),
      ],
      index
    )
    expect(report.usd).toBeCloseTo(3)
    expect(report.pricedTokens).toBe(1_000_000)
    expect(report.unpricedTokens).toBe(250_000)
    expect(report.coverage).toBeCloseTo(0.8)
    expect(report.pricedModels).toBe(1)
    expect(report.unpricedModels).toBe(1)
  })
})

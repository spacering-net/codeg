import { describe, expect, it } from "vitest"

import {
  buildRateIndex,
  coveragePercent,
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

  it("lets the maker's own listing win over clouds that disagree", () => {
    expect(
      pickRate([
        rate({ providerId: "azure", cacheRead: 0.5 }),
        rate({ providerId: "amazon-bedrock", input: 3.6 }),
        rate({ providerId: "anthropic", input: 3 }),
      ])?.providerId
    ).toBe("anthropic")
  })

  it("refuses to guess when hosts disagree and no maker lists the id", () => {
    expect(
      pickRate([
        rate({ providerId: "amazon-bedrock", input: 3.6 }),
        rate({ providerId: "azure", input: 3.3 }),
        rate({ providerId: "openrouter", input: 3 }),
      ])
    ).toBeNull()
  })

  it("still lets a lone host decide over disagreeing resellers", () => {
    expect(
      pickRate([
        rate({ providerId: "openrouter", input: 3.3 }),
        rate({ providerId: "groq", input: 3 }),
      ])?.providerId
    ).toBe("groq")
  })

  it("stays ambiguous when the maker's own hits disagree", () => {
    const index = buildRateIndex([
      provider("anthropic", [
        model({ id: "model", cost_in: 2 }),
        model({ id: "model-20260101", cost_in: 8 }),
      ]),
    ])
    // A newer snapshot the catalog does not list reaches both via the date
    // strip; neither is its price.
    expect(resolveRate(index, "model-20270101")).toBeNull()
  })

  it("ranks a model's own maker above a maker that also hosts it", () => {
    expect(
      pickRate([
        rate({ providerId: "alibaba", id: "kimi-k3", input: 4 }),
        rate({ providerId: "moonshotai", id: "kimi-k3", input: 3 }),
      ])?.providerId
    ).toBe("moonshotai")
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

describe("catalog identity boundaries", () => {
  it("keeps an exact dated price ahead of an alias", () => {
    const index = buildRateIndex([
      provider("anthropic", [
        model({ id: "model-20260101", cost_in: 8 }),
        model({ id: "model", cost_in: 2 }),
      ]),
    ])
    expect(resolveRate(index, "model")?.input).toBe(2)
    expect(resolveRate(index, "model-20260101")?.input).toBe(8)
  })

  it("never borrows another provider's missing published price", () => {
    const index = buildRateIndex([
      provider("openai", [model({ id: "model" })]),
      provider("other", [
        model({
          id: "model",
          cost_in: null,
          cost_out: null,
          cost_cache_read: null,
          cost_cache_write: null,
        }),
      ]),
    ])
    const own = resolveRate(index, "other/model")
    expect(own?.input).toBeNull()
    expect(
      estimateItemCost(item("other/model", { input_tokens: 100 }), own).usd
    ).toBeNull()
    expect(resolveRate(index, "missing/model")).toBeNull()
  })

  it("treats invalid rates as unpublished and zero rates as published", () => {
    const index = buildRateIndex([
      provider("openai", [
        model({
          id: "model",
          cost_in: -1,
          cost_out: 0,
        }),
      ]),
    ])
    expect(resolveRate(index, "model")?.input).toBeNull()
    const result = estimateItemCost(
      item("model", {
        input_tokens: 100,
        output_tokens: 50,
      }),
      resolveRate(index, "model")
    )
    expect(result).toEqual({ usd: 0, pricedTokens: 50, unpricedTokens: 100 })
  })
})

// The listing shapes below are taken from the live models.dev catalog: a
// maker and a cloud selling the same id with different cache prices, and a
// reseller that leaves a bucket unpublished.
describe("maker listings", () => {
  const sol = {
    id: "gpt-5.6-sol",
    cost_in: 4,
    cost_out: 20,
    cost_cache_read: 0.4,
    cost_cache_write: 5,
  }
  const index = buildRateIndex([
    provider("azure", [
      model({ ...sol, cost_cache_read: 0.5, cost_cache_write: 6.25 }),
      model({
        id: "claude-sonnet-5-5",
        cost_in: 2,
        cost_out: 10,
        cost_cache_read: 0.2,
        cost_cache_write: 2.5,
      }),
      model({
        id: "deepseek-v4-flash",
        cost_in: 0.19,
        cost_out: 0.51,
        cost_cache_read: null,
        cost_cache_write: null,
      }),
    ]),
    provider("opencode", [
      model(sol),
      model({
        id: "kimi-k3",
        cost_in: 3,
        cost_out: 15,
        cost_cache_read: 0.3,
        cost_cache_write: null,
      }),
    ]),
    provider("openai", [model(sol)]),
    provider("anthropic", [
      model({
        id: "claude-sonnet-5-5",
        cost_in: 2,
        cost_out: 10,
        cost_cache_read: 0.1,
        cost_cache_write: 2.5,
      }),
    ]),
    provider("deepseek", [
      model({
        id: "deepseek-v4-flash",
        cost_in: 0.15,
        cost_out: 0.6,
        cost_cache_read: 0.003,
        cost_cache_write: null,
      }),
    ]),
    provider("moonshotai", [
      model({
        id: "kimi-k3",
        cost_in: 3,
        cost_out: 15,
        cost_cache_read: 0.3,
        cost_cache_write: 3,
      }),
    ]),
  ])

  it("prices a model at its maker's rate when a cloud disagrees", () => {
    const sonnet = resolveRate(index, "claude-sonnet-5-5")
    expect(sonnet?.providerId).toBe("anthropic")
    expect(sonnet?.cacheRead).toBe(0.1)

    const gpt = resolveRate(index, "gpt-5.6-sol")
    expect(gpt?.providerId).toBe("openai")
    expect(
      estimateItemCost(
        item("gpt-5.6-sol", {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_creation_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
        }),
        gpt
      ).usd
    ).toBeCloseTo(4 + 20 + 5 + 0.4)

    expect(resolveRate(index, "deepseek-v4-flash")?.providerId).toBe("deepseek")
    expect(resolveRate(index, "kimi-k3")?.providerId).toBe("moonshotai")
  })

  it("still honors an explicit cloud prefix", () => {
    expect(resolveRate(index, "azure/gpt-5.6-sol")?.cacheRead).toBe(0.5)
  })

  it("never fills a bucket the maker leaves unpublished from a cloud", () => {
    const hosted = buildRateIndex([
      provider("azure", [
        model({
          id: "deepseek-v4-flash",
          cost_in: 0.19,
          cost_out: 0.51,
          cost_cache_read: 0.05,
          cost_cache_write: 0.25,
        }),
      ]),
      provider("deepseek", [
        model({
          id: "deepseek-v4-flash",
          cost_in: 0.15,
          cost_out: 0.6,
          cost_cache_read: 0.003,
          cost_cache_write: null,
        }),
      ]),
    ])
    const flash = resolveRate(hosted, "deepseek-v4-flash")
    expect(flash?.providerId).toBe("deepseek")
    expect(flash?.cacheWrite).toBeNull()
    expect(
      estimateItemCost(
        item("deepseek-v4-flash", {
          input_tokens: 1_000_000,
          cache_creation_tokens: 10,
        }),
        flash
      )
    ).toEqual({ usd: 0.15, pricedTokens: 1_000_000, unpricedTokens: 10 })
  })
})

describe("coveragePercent", () => {
  it("floors, so a partial estimate never reads as complete", () => {
    expect(coveragePercent(995, 5)).toBe("99")
    expect(coveragePercent(1, 1)).toBe("50")
  })

  it("never shows 0% next to a priced amount", () => {
    expect(coveragePercent(1, 999)).toBe("<1")
    expect(coveragePercent(10, 990)).toBe("1")
  })

  it("stays below 100 while any token is unpriced", () => {
    // Floating-point division rounds this ratio up to exactly 100.
    expect(coveragePercent(9_007_199_254_740_989, 1)).toBe("99")
    expect(coveragePercent(5, 0)).toBe("100")
  })

  it("is 0 when nothing was priced", () => {
    expect(coveragePercent(0, 50)).toBe("0")
    expect(coveragePercent(0, 0)).toBe("0")
  })
})

describe("explicit provider scope", () => {
  it("prices `provider/model` from that provider alone", () => {
    // Live catalog shape: Tempr's own id is the literal string
    // `cerebras/qwen-3.8-27b`, with the cache read left unpublished.
    const index = buildRateIndex([
      provider("cerebras", [
        model({
          id: "qwen-3.8-27b",
          cost_in: 0.99,
          cost_out: 1.49,
          cost_cache_read: 0.99,
          cost_cache_write: null,
        }),
      ]),
      provider("tempr", [
        model({
          id: "cerebras/qwen-3.8-27b",
          cost_in: 0.99,
          cost_out: 1.49,
          cost_cache_read: null,
          cost_cache_write: null,
        }),
      ]),
    ])
    const rate = resolveRate(index, "cerebras/qwen-3.8-27b")
    expect(rate?.providerId).toBe("cerebras")
    expect(rate?.cacheRead).toBe(0.99)
  })

  it("keeps a provider's unpublished price over a reseller's literal id", () => {
    const index = buildRateIndex([
      provider("custom", [
        model({
          id: "foo",
          cost_in: null,
          cost_out: null,
          cost_cache_read: null,
          cost_cache_write: null,
        }),
      ]),
      provider("groq", [model({ id: "custom/foo", cost_in: 1 })]),
    ])
    const rate = resolveRate(index, "custom/foo")
    expect(rate?.providerId).toBe("custom")
    expect(
      estimateItemCost(item("custom/foo", { input_tokens: 1_000_000 }), rate)
        .usd
    ).toBeNull()
  })

  it("abstains when a dated key reaches the provider's disagreeing snapshots", () => {
    const index = buildRateIndex([
      provider("openai", [
        model({ id: "gpt-4o", cost_in: 2.5, cost_out: 10 }),
        model({ id: "gpt-4o-2024-05-13", cost_in: 5, cost_out: 15 }),
      ]),
    ])
    expect(resolveRate(index, "openai/gpt-4o-20240513")).toBeNull()
    expect(resolveRate(index, "gpt-4o-20240513")).toBeNull()
    expect(resolveRate(index, "openai/gpt-4o-2024-05-13")?.input).toBe(5)
  })

  it("falls back from an unlisted dated key to the provider's own snapshots", () => {
    const index = buildRateIndex([
      provider("anthropic", [
        model({ id: "claude-x", cost_in: 3 }),
        model({ id: "claude-x-20250101", cost_in: 3 }),
      ]),
      // A reseller whose raw id is the scoped alias, at its own price.
      provider("tempr", [model({ id: "anthropic/claude-x", cost_in: 9 })]),
    ])
    const rate = resolveRate(index, "anthropic/claude-x-20990101")
    expect(rate?.providerId).toBe("anthropic")
    expect(rate?.input).toBe(3)
  })

  it("still reads a reseller's own `vendor/model` id", () => {
    const index = buildRateIndex([
      provider("openrouter", [model({ id: "acme/model-x", cost_in: 1 })]),
    ])
    expect(resolveRate(index, "acme/model-x")?.providerId).toBe("openrouter")
  })
})

describe("makers that also host other labs' models", () => {
  it("never outrank a host for a model they do not make", () => {
    // Live catalog shape: Moonshot does not list `kimi-k2.5`, Alibaba CN and
    // Azure both host it at different prices.
    const index = buildRateIndex([
      provider("alibaba-cn", [
        model({ id: "kimi-k2.5", cost_in: 0.574, cost_out: 2.411 }),
      ]),
      provider("azure", [
        model({ id: "kimi-k2.5", cost_in: 0.6, cost_out: 3 }),
      ]),
    ])
    expect(resolveRate(index, "kimi-k2.5")?.providerId).toBe("azure")
  })
})

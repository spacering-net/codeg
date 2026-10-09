import type {
  OpenCodeCatalogProvider,
  TokenUsageBreakdownItem,
} from "@/lib/types"

/**
 * Public API list rates from the models.dev catalog Codeg already fetches.
 *
 * This is the official published per-million price (input, output, cache
 * read, cache write). It is not what a subscription plan charged, and it is
 * not a live remaining-quota figure.
 */

export interface ModelApiRate {
  providerId: string
  id: string
  name: string
  /** USD per 1M tokens. `null` means that bucket is unpublished. */
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface RateIndex {
  byKey: Map<string, ModelApiRate[]>
  byName: Map<string, ModelApiRate[]>
  ids: string[]
}

export interface ItemCost {
  /** `null` when no published rate applied to any token. */
  usd: number | null
  pricedTokens: number
  unpricedTokens: number
}

export interface ReportCost {
  usd: number
  pricedTokens: number
  unpricedTokens: number
  /** priced / (priced + unpriced). 0 when nothing was recorded. */
  coverage: number
  pricedModels: number
  unpricedModels: number
}

/** Prefer the lab's own listing when the same id is sold by many providers. */
const PROVIDER_RANK: Record<string, number> = {
  anthropic: 0,
  openai: 1,
  google: 2,
  xai: 3,
  groq: 4,
  mistral: 5,
  deepseek: 6,
  "amazon-bedrock": 7,
  azure: 8,
}

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/
const PROVIDER_PREFIX = /^[a-z0-9][a-z0-9._-]*\//

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

export function normalizeModelKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

function stripProvider(key: string): string {
  return key.replace(PROVIDER_PREFIX, "")
}

function stripDate(key: string): string {
  return key.replace(DATE_SUFFIX, "")
}

function lookupKeys(raw: string): string[] {
  const n = normalizeModelKey(raw)
  if (!n) return []
  const noProv = stripProvider(n)
  const keys = [n, noProv, stripDate(n), stripDate(noProv)]
  return [...new Set(keys.filter(Boolean))]
}

function priceKey(rate: ModelApiRate): string {
  return [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].join("|")
}

function providerRank(id: string): number {
  return PROVIDER_RANK[id] ?? 100
}

function push(
  map: Map<string, ModelApiRate[]>,
  key: string,
  rate: ModelApiRate
): void {
  if (!key) return
  const existing = map.get(key)
  if (existing) existing.push(rate)
  else map.set(key, [rate])
}

function toRate(
  providerId: string,
  model: OpenCodeCatalogProvider["models"][number]
): ModelApiRate | null {
  const input = finiteOrNull(model.cost_in)
  const output = finiteOrNull(model.cost_out)
  const cacheRead = finiteOrNull(model.cost_cache_read)
  const cacheWrite = finiteOrNull(model.cost_cache_write)
  if (
    input == null &&
    output == null &&
    cacheRead == null &&
    cacheWrite == null
  ) {
    return null
  }
  return {
    providerId,
    id: model.id,
    name: model.name,
    input,
    output,
    cacheRead,
    cacheWrite,
  }
}

/** Collapse several catalog hits to one rate, or none if the price is ambiguous. */
export function pickRate(rates: ModelApiRate[]): ModelApiRate | null {
  if (rates.length === 0) return null
  if (rates.length === 1) return rates[0]

  const uniquePrices = new Set(rates.map(priceKey))
  const ranked = [...rates].sort(
    (a, b) =>
      providerRank(a.providerId) - providerRank(b.providerId) ||
      a.providerId.localeCompare(b.providerId)
  )
  if (uniquePrices.size === 1) return ranked[0]

  const official = ranked.filter((r) => providerRank(r.providerId) < 100)
  if (official.length === 1) return official[0]
  if (official.length > 1) {
    const officialPrices = new Set(official.map(priceKey))
    if (officialPrices.size === 1) return official[0]
    return null
  }
  return null
}

export function buildRateIndex(
  providers: OpenCodeCatalogProvider[]
): RateIndex {
  const byKey = new Map<string, ModelApiRate[]>()
  const byName = new Map<string, ModelApiRate[]>()
  const idSet = new Set<string>()

  for (const provider of providers) {
    for (const model of provider.models) {
      const rate = toRate(provider.id, model)
      if (!rate) continue
      const id = normalizeModelKey(model.id)
      const prefixed = `${normalizeModelKey(provider.id)}/${id}`
      for (const key of lookupKeys(id)) push(byKey, key, rate)
      push(byKey, prefixed, rate)
      idSet.add(id)
      const name = normalizeModelKey(model.name)
      if (name.length >= 3) push(byName, name, rate)
    }
  }

  return { byKey, byName, ids: [...idSet] }
}

export function resolveRate(
  index: RateIndex,
  raw: string | null | undefined
): ModelApiRate | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === "__unknown__" || trimmed === "__other__") {
    return null
  }

  for (const key of lookupKeys(trimmed)) {
    const hit = pickRate(index.byKey.get(key) ?? [])
    if (hit) return hit
  }

  for (const key of lookupKeys(trimmed)) {
    const hit = pickRate(index.byName.get(key) ?? [])
    if (hit) return hit
  }

  // `claude-sonnet-4-5-20250929` already matches via the date strip. This
  // last pass only accepts a numeric build suffix (`grok-4-0709`) so
  // `gpt-5` never steals `gpt-5.3` or `gpt-5-mini`.
  const bare = stripProvider(normalizeModelKey(trimmed))
  const prefixHits: ModelApiRate[] = []
  for (const id of index.ids) {
    if (!bare.startsWith(`${id}-`)) continue
    if (!/^-\d{4,8}$/.test(bare.slice(id.length))) continue
    prefixHits.push(...(index.byKey.get(id) ?? []))
  }
  return pickRate(prefixHits)
}

function priceBucket(
  tokens: number,
  perMillion: number | null
): { usd: number; priced: number; unpriced: number } {
  if (tokens <= 0) return { usd: 0, priced: 0, unpriced: 0 }
  if (perMillion == null) return { usd: 0, priced: 0, unpriced: tokens }
  return {
    usd: (tokens / 1_000_000) * perMillion,
    priced: tokens,
    unpriced: 0,
  }
}

export function estimateItemCost(
  item: Pick<
    TokenUsageBreakdownItem,
    | "input_tokens"
    | "output_tokens"
    | "cache_creation_tokens"
    | "cache_read_tokens"
  >,
  rate: ModelApiRate | null
): ItemCost {
  if (!rate) {
    const unpriced =
      item.input_tokens +
      item.output_tokens +
      item.cache_creation_tokens +
      item.cache_read_tokens
    return { usd: null, pricedTokens: 0, unpricedTokens: unpriced }
  }

  const input = priceBucket(item.input_tokens, rate.input)
  const output = priceBucket(item.output_tokens, rate.output)
  const cacheWrite = priceBucket(item.cache_creation_tokens, rate.cacheWrite)
  const cacheRead = priceBucket(item.cache_read_tokens, rate.cacheRead)
  const pricedTokens =
    input.priced + output.priced + cacheWrite.priced + cacheRead.priced
  const unpricedTokens =
    input.unpriced + output.unpriced + cacheWrite.unpriced + cacheRead.unpriced
  if (pricedTokens <= 0) {
    return { usd: null, pricedTokens: 0, unpricedTokens }
  }
  return {
    usd: input.usd + output.usd + cacheWrite.usd + cacheRead.usd,
    pricedTokens,
    unpricedTokens,
  }
}

export function estimateReportCost(
  items: TokenUsageBreakdownItem[],
  index: RateIndex
): ReportCost {
  let usd = 0
  let pricedTokens = 0
  let unpricedTokens = 0
  let pricedModels = 0
  let unpricedModels = 0

  for (const item of items) {
    const cost = estimateItemCost(item, resolveRate(index, item.key))
    if (cost.usd != null) {
      usd += cost.usd
      pricedModels += 1
    } else if (cost.unpricedTokens > 0) {
      unpricedModels += 1
    }
    pricedTokens += cost.pricedTokens
    unpricedTokens += cost.unpricedTokens
  }

  const total = pricedTokens + unpricedTokens
  return {
    usd,
    pricedTokens,
    unpricedTokens,
    coverage: total > 0 ? pricedTokens / total : 0,
    pricedModels,
    unpricedModels,
  }
}

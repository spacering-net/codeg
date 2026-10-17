import type {
  OpenCodeCatalogProvider,
  TokenUsageBreakdownItem,
} from "@/lib/types"

/**
 * Public API list rates from the models.dev catalog Codeg already fetches.
 *
 * These are catalog list rates per million tokens (input, output, cache
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
  /** `provider/id` -> that provider's own listing of the model. */
  own: Map<string, ModelApiRate[]>
  /** Same, keyed with any date suffix stripped from the id. */
  ownByKey: Map<string, ModelApiRate[]>
  /**
   * Raw catalog ids, kept apart from the provider-scoped keys above: many
   * resellers' ids carry a `vendor/` namespace of their own (OpenRouter's
   * `openai/gpt-5`), which would otherwise collide with `provider/id`.
   */
  exact: Map<string, ModelApiRate[]>
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

/**
 * Model makers whose catalog listings are all their own models. A maker's own
 * listing IS the API list price of its model, so when one lists the id it
 * wins outright, even when a cloud or reseller (Azure, Bedrock, OpenCode Zen,
 * OpenRouter...) sells the same id at another price: that is a different
 * product, not a competing list price.
 *
 * Only makers that sell nothing but their own models belong here. One that
 * also hosts other labs' models (Mistral lists GLM; Alibaba lists Kimi, GLM
 * and DeepSeek) would otherwise win for a model it does not make. The order
 * only matters between a maker's international and China endpoints.
 */
const LAB_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "moonshotai",
  "moonshotai-cn",
  "zai",
  "zhipuai",
  "minimax",
  "minimax-cn",
  "xiaomi",
]

/**
 * Hosts preferred over other resellers, but never over a maker. Used only
 * when no maker lists the id: a single host's price decides, and hosts that
 * disagree leave the price ambiguous.
 */
const HOST_PROVIDERS = ["groq", "mistral", "amazon-bedrock", "azure"]

const LABS = new Set(LAB_PROVIDERS)
const PROVIDER_RANK = new Map(
  [...LAB_PROVIDERS, ...HOST_PROVIDERS].map((id, rank) => [id, rank])
)

const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/
const PROVIDER_PREFIX = /^[a-z0-9][a-z0-9._-]*\//

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null
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
  return PROVIDER_RANK.get(id) ?? 100
}

/** The first hit when every hit carries the same prices, else `null`. */
function agreed(rates: ModelApiRate[]): ModelApiRate | null {
  if (rates.length === 0) return null
  return new Set(rates.map(priceKey)).size === 1 ? rates[0] : null
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
): ModelApiRate {
  const input = finiteOrNull(model.cost_in)
  const output = finiteOrNull(model.cost_out)
  const cacheRead = finiteOrNull(model.cost_cache_read)
  const cacheWrite = finiteOrNull(model.cost_cache_write)
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

/**
 * Collapse several catalog hits to one rate, or none if the price is
 * ambiguous. A maker's own listing decides outright (see `LAB_PROVIDERS`),
 * including any bucket it leaves unpublished, unless that maker's own hits
 * disagree (a date-stripped key reaching two of its snapshots). Without a
 * maker, hits that agree on every bucket collapse, a lone preferred host
 * decides, and anything else stays unpriced.
 */
export function pickRate(rates: ModelApiRate[]): ModelApiRate | null {
  if (rates.length === 0) return null
  if (rates.length === 1) return rates[0]

  const ranked = [...rates].sort(
    (a, b) =>
      providerRank(a.providerId) - providerRank(b.providerId) ||
      a.providerId.localeCompare(b.providerId)
  )
  const maker = ranked[0].providerId
  if (LABS.has(maker)) {
    return agreed(ranked.filter((r) => r.providerId === maker))
  }

  const uniquePrices = new Set(rates.map(priceKey))
  if (uniquePrices.size === 1) return ranked[0]

  return agreed(ranked.filter((r) => providerRank(r.providerId) < 100))
}

export function buildRateIndex(
  providers: OpenCodeCatalogProvider[]
): RateIndex {
  const own = new Map<string, ModelApiRate[]>()
  const ownByKey = new Map<string, ModelApiRate[]>()
  const exact = new Map<string, ModelApiRate[]>()
  const byKey = new Map<string, ModelApiRate[]>()
  const byName = new Map<string, ModelApiRate[]>()
  const idSet = new Set<string>()

  for (const provider of providers) {
    for (const model of provider.models) {
      const rate = toRate(provider.id, model)
      const id = normalizeModelKey(model.id)
      const prefixed = `${normalizeModelKey(provider.id)}/${id}`
      push(own, prefixed, rate)
      push(ownByKey, stripDate(prefixed), rate)
      for (const key of lookupKeys(id)) push(byKey, key, rate)
      push(exact, id, rate)
      idSet.add(id)
      const name = normalizeModelKey(model.name)
      if (name.length >= 3) push(byName, name, rate)
    }
  }

  return { own, ownByKey, exact, byKey, byName, ids: [...idSet] }
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

  // An exact model/version or explicit provider must not inherit another
  // listing's cheaper rate, even when its own rate is unpublished.
  const normalized = normalizeModelKey(trimmed)
  const scoped = normalized.includes("/")
  if (scoped) {
    // `provider/model` where that provider lists the model resolves to its
    // own listing alone; a reseller whose raw id is the same string does not
    // get a vote. Its snapshots that disagree under a stripped date stay
    // ambiguous.
    const own =
      index.own.get(normalized) ?? index.ownByKey.get(stripDate(normalized))
    if (own) return agreed(own)
  }
  if (index.exact.has(normalized)) {
    return pickRate(index.exact.get(normalized)!)
  }
  if (scoped) {
    return pickRate(index.byKey.get(stripDate(normalized)) ?? [])
  }

  for (const key of lookupKeys(trimmed)) {
    const hit = pickRate(index.byKey.get(key) ?? [])
    if (index.byKey.has(key)) return hit
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

/**
 * The share of tokens a partial estimate covers, as the whole percent in its
 * "N% of tokens" label. Floored, so a partial estimate never reads as 100%;
 * "<1" rather than "0" once anything was priced, so a dollar amount is never
 * shown next to "0% of tokens".
 */
export function coveragePercent(
  pricedTokens: number,
  unpricedTokens: number
): string {
  const total = pricedTokens + unpricedTokens
  if (pricedTokens <= 0 || total <= 0) return "0"
  const percent = Math.floor((100 * pricedTokens) / total)
  if (percent < 1) return "<1"
  // Float division can round up to 100 with a handful of unpriced tokens
  // among quadrillions.
  return String(unpricedTokens > 0 ? Math.min(percent, 99) : percent)
}

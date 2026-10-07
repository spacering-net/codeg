import type {
  TokenUsageBreakdownItem,
  TokenUsageBucket,
  TokenUsageHeatCell,
  TokenUsagePoint,
  TokenUsageReport,
  TokenUsageTotals,
} from "@/lib/types"

/**
 * Pure helpers behind the token-usage dashboard. Everything here is a function
 * of its arguments — no clock, no locale, no DOM — so the range math, the
 * top-N folding and the highlight derivation are exactly testable and the
 * components stay presentational.
 */

// ─── Ranges ─────────────────────────────────────────────────────────────

export type TokenUsageRangePreset =
  | "7d"
  | "30d"
  | "90d"
  | "thisMonth"
  | "thisYear"
  | "all"
  | "custom"

export const RANGE_PRESETS: TokenUsageRangePreset[] = [
  "7d",
  "30d",
  "90d",
  "thisMonth",
  "thisYear",
  "all",
]

export interface ResolvedRange {
  /** ISO-8601, inclusive. `null` = unbounded (the backend clamps to the data). */
  start: string | null
  /** ISO-8601, exclusive. */
  end: string | null
}

/** Midnight at the start of `d`'s local calendar day. */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addLocalDays(d: Date, days: number): Date {
  // Constructing through the Date parts (rather than adding milliseconds) keeps
  // the result on a real local midnight across DST transitions.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

/**
 * The custom range's wire form is a pair of `YYYY-MM-DD` local days; the
 * calendar speaks `Date`. These two are that seam.
 *
 * Neither goes through `toISOString`/`Date.parse` of a bare date: a date-only
 * string is parsed as UTC by the language spec, so west of Greenwich the day
 * would come back as the one before.
 */
export function toLocalDayValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DD` → local midnight; `null` for empty or unparsable input. */
export function fromLocalDayValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Which month the two-month range calendar should open on — the LEFT pane, so
 * the right one lands on the range's end (or on the current month when nothing
 * is picked yet).
 *
 * Without this the calendar opens on today and shows [this month, next month],
 * and since there are no statistics in the future that entire right pane is
 * disabled: half the panel is dead and a span reaching back into last month
 * cannot be drawn without first paging backwards. Anchoring one month earlier
 * makes both panes usable and puts a cross-month range within one gesture.
 *
 * Day 1 of the month, because react-day-picker only reads the month off it.
 */
export function rangeDefaultMonth(from: string, to: string, today: Date): Date {
  const anchor = fromLocalDayValue(to) ?? fromLocalDayValue(from) ?? today
  return new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
}

/**
 * Turn a preset into concrete UTC bounds.
 *
 * Bounds are always local-day aligned and half-open `[start, end)`: "the last 7
 * days" is the last 7 *calendar* days including today, not a rolling 168 hours,
 * which is what a day-bucketed chart is showing anyway.
 *
 * `custom` takes two inclusive local dates and widens `end` to the following
 * midnight, so picking the same day twice yields that whole day.
 */
export function resolveRange(
  preset: TokenUsageRangePreset,
  now: Date,
  custom?: { from: Date | null; to: Date | null }
): ResolvedRange {
  const tomorrow = addLocalDays(startOfLocalDay(now), 1)
  const iso = (d: Date) => d.toISOString()

  switch (preset) {
    case "7d":
      return { start: iso(addLocalDays(tomorrow, -7)), end: iso(tomorrow) }
    case "30d":
      return { start: iso(addLocalDays(tomorrow, -30)), end: iso(tomorrow) }
    case "90d":
      return { start: iso(addLocalDays(tomorrow, -90)), end: iso(tomorrow) }
    case "thisMonth":
      return {
        start: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
        end: iso(tomorrow),
      }
    case "thisYear":
      return {
        start: iso(new Date(now.getFullYear(), 0, 1)),
        end: iso(tomorrow),
      }
    case "all":
      return { start: null, end: null }
    case "custom": {
      const from = custom?.from ?? null
      const to = custom?.to ?? null
      if (!from && !to) return { start: null, end: null }
      // A half-filled custom range is still meaningful — treat the missing side
      // as unbounded rather than silently falling back to "all".
      return {
        start: from ? iso(startOfLocalDay(from)) : null,
        end: to ? iso(addLocalDays(startOfLocalDay(to), 1)) : null,
      }
    }
  }
}

/**
 * The bucket width that keeps a range readable. Named presets map directly —
 * 90 daily bars is a picket fence, so 90d reads in weeks and a year in
 * months. Custom falls back to the span: days to ~3 months, weeks to a year,
 * months beyond. Only ever used to pick a *default* — the control stays
 * user-settable.
 */
export function suggestBucket(
  preset: TokenUsageRangePreset,
  range: ResolvedRange
): TokenUsageBucket {
  switch (preset) {
    case "7d":
    case "30d":
    case "thisMonth":
      return "day"
    case "90d":
      return "week"
    case "thisYear":
      return "month"
    case "all":
      return "week"
    case "custom":
      break
  }
  if (!range.start || !range.end) return "week"
  const days =
    (new Date(range.end).getTime() - new Date(range.start).getTime()) /
    86_400_000
  if (days <= 92) return "day"
  if (days <= 366) return "week"
  return "month"
}

/** `-getTimezoneOffset()` — minutes east of UTC, the sign the backend expects. */
export function localTzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset()
}

// ─── Deltas ─────────────────────────────────────────────────────────────

export interface Delta {
  /** Fractional change, e.g. `0.25` for +25%. `null` when there is no base to
   *  compare against (the previous window was empty) — render that as "new",
   *  never as "+∞%" or a misleading "+100%". */
  ratio: number | null
  direction: "up" | "down" | "flat"
}

export function computeDelta(current: number, previous: number): Delta {
  if (previous <= 0) {
    return { ratio: null, direction: current > 0 ? "up" : "flat" }
  }
  const ratio = (current - previous) / previous
  // Sub-half-percent moves read as noise on a spend chart; call them flat so a
  // steady week doesn't sprout arrows.
  if (Math.abs(ratio) < 0.005) return { ratio, direction: "flat" }
  return { ratio, direction: ratio > 0 ? "up" : "down" }
}

// ─── Breakdown folding ──────────────────────────────────────────────────

/**
 * Keep the top `limit` slices and fold the rest into one "other" bucket.
 *
 * The categorical palette has a fixed number of validated slots; a 9th series
 * is never a generated colour. Folding — not cycling — is the rule.
 */
export function foldBreakdown(
  items: TokenUsageBreakdownItem[],
  limit: number
): { shown: TokenUsageBreakdownItem[]; other: TokenUsageBreakdownItem | null } {
  if (items.length <= limit) return { shown: items, other: null }
  const shown = items.slice(0, limit)
  const rest = items.slice(limit)
  const other = rest.reduce<TokenUsageBreakdownItem>(
    (acc, it) => ({
      ...acc,
      input_tokens: acc.input_tokens + it.input_tokens,
      output_tokens: acc.output_tokens + it.output_tokens,
      cache_creation_tokens:
        acc.cache_creation_tokens + it.cache_creation_tokens,
      cache_read_tokens: acc.cache_read_tokens + it.cache_read_tokens,
      total_tokens: acc.total_tokens + it.total_tokens,
      turn_count: acc.turn_count + it.turn_count,
      conversation_count: acc.conversation_count + it.conversation_count,
    }),
    {
      key: "__other__",
      label: "__other__",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      turn_count: 0,
      conversation_count: 0,
    }
  )
  return { shown, other: other.total_tokens > 0 ? other : null }
}

// ─── Heatmap ────────────────────────────────────────────────────────────

export interface HeatMatrix {
  /** `[weekday][hour]` totals, 7 × 24, zero-filled. */
  cells: number[][]
  max: number
}

/** Expand the sparse wire cells into the dense grid the chart draws. */
export function buildHeatMatrix(cells: TokenUsageHeatCell[]): HeatMatrix {
  const grid: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  )
  let max = 0
  for (const c of cells) {
    if (c.weekday < 0 || c.weekday > 6 || c.hour < 0 || c.hour > 23) continue
    grid[c.weekday][c.hour] += c.total_tokens
    max = Math.max(max, grid[c.weekday][c.hour])
  }
  return { cells: grid, max }
}

// ─── Derived stats ──────────────────────────────────────────────────────

/**
 * Share of input that was served from the prompt cache.
 *
 * The denominator is every token that entered the model as context — fresh
 * input, cache writes, and cache reads — so the ratio answers "how much of what
 * I sent did I not pay full price for". Output tokens are excluded on purpose:
 * they were never cacheable.
 *
 * Counter-shaped rather than totals-shaped so the dashboard (`TokenUsageTotals`)
 * and a single session's live counters (`TurnUsage`, whose fields are named
 * differently) share ONE definition of the ratio instead of each carrying its
 * own division.
 */
export function cacheHitRatio(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number | null {
  const denominator = inputTokens + cacheCreationTokens + cacheReadTokens
  if (denominator <= 0) return null
  return cacheReadTokens / denominator
}

/** {@link cacheHitRatio} over a dashboard totals row. */
export function cacheHitRate(totals: TokenUsageTotals): number | null {
  return cacheHitRatio(
    totals.input_tokens,
    totals.cache_creation_tokens,
    totals.cache_read_tokens
  )
}

/**
 * Decimal places every surface prints the cache hit rate with
 * ({@link formatPercent}): the dashboard's ring, the share card's copy of it,
 * and the composer popover's row. One number, one reading — a rounded `95%`
 * beside a `94.6%` looks like two different measurements.
 *
 * Deliberately not applied to the archetype copy, whose `{percent}%` sentences
 * are a family of five and read as a badge, not a meter.
 */
export const CACHE_HIT_RATE_DIGITS = 1

export function averagePerConversation(totals: TokenUsageTotals): number {
  if (totals.conversation_count <= 0) return 0
  return totals.total_tokens / totals.conversation_count
}

export function averageTurnsPerConversation(totals: TokenUsageTotals): number {
  if (totals.conversation_count <= 0) return 0
  return totals.turn_count / totals.conversation_count
}

/** Tokens that were actually computed this period — everything the cache did
 *  NOT serve: fresh input, cache writes, and output. */
export function freshTokens(totals: TokenUsageTotals): number {
  return Math.max(0, totals.total_tokens - totals.cache_read_tokens)
}

/**
 * Calendar days inside the report's range with no recorded usage at all.
 *
 * The span is counted in *local calendar days*, matching how the backend
 * counts `active_days` — never as elapsed milliseconds / 86.4M. That matters
 * because an unbounded request comes back clamped to the data: `range_start`
 * is the first activity *instant* (mid-day, not midnight) and `range_end` is
 * one tick past the last, so a ms division would undercount the span by up to
 * two days. `null` when the span is unknowable (no bounds and no activity).
 */
export function idleDays(report: TokenUsageReport): number | null {
  const startIso = report.range_start ?? report.first_activity_at
  const endIso = report.range_end ?? report.last_activity_at
  if (!startIso || !endIso) return null
  let endMs = Date.parse(endIso)
  // `range_end` is exclusive — step back one tick to the last instant that
  // was actually counted. The `last_activity_at` fallback is already
  // inclusive.
  if (report.range_end) endMs -= 1
  const start = new Date(startIso)
  const end = new Date(endMs)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  const startDay = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  )
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  // Local midnights differ by a whole day count ±1h of DST; rounding
  // absorbs the hour.
  const days =
    Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000) + 1
  if (!Number.isFinite(days) || days <= 0) return null
  return Math.max(0, days - report.totals.active_days)
}

export function averagePerActiveDay(totals: TokenUsageTotals): number {
  if (totals.active_days <= 0) return 0
  return totals.total_tokens / totals.active_days
}

/** The single busiest bucket, or `null` when nothing was recorded. */
export function peakPoint(series: TokenUsagePoint[]): TokenUsagePoint | null {
  let best: TokenUsagePoint | null = null
  for (const p of series) {
    if (p.total_tokens <= 0) continue
    if (!best || p.total_tokens > best.total_tokens) best = p
  }
  return best
}

/** Local hour of day with the most recorded tokens, or `null`. */
export function peakHour(cells: TokenUsageHeatCell[]): number | null {
  const byHour = new Array<number>(24).fill(0)
  for (const c of cells) {
    if (c.hour < 0 || c.hour > 23) continue
    byHour[c.hour] += c.total_tokens
  }
  let best: number | null = null
  for (let h = 0; h < 24; h++) {
    if (byHour[h] <= 0) continue
    if (best === null || byHour[h] > byHour[best]) best = h
  }
  return best
}

// ─── Archetype ──────────────────────────────────────────────────────────

/**
 * A one-line "what kind of builder are you" label for the share card.
 *
 * Every archetype is a threshold on a real measured quantity — nothing is
 * randomised or invented — and the list is ordered most-specific first so the
 * winner is the most interesting true statement about the data, not just the
 * first one that happens to fit. `values` carries the numbers the UI
 * interpolates into the translated string.
 */
export type ArchetypeId =
  | "nightOwl"
  | "earlyBird"
  | "weekendWarrior"
  | "cacheMaster"
  | "marathoner"
  | "polyglot"
  | "laserFocus"
  | "deepDiver"
  | "steady"

export interface Archetype {
  id: ArchetypeId
  /** Interpolation values for the translated label/description. */
  values: Record<string, number>
}

const NIGHT_HOURS = [22, 23, 0, 1, 2, 3]
const MORNING_HOURS = [5, 6, 7, 8]
/** Saturday and Sunday in the backend's Monday-first weekday numbering. */
const WEEKEND_DAYS = [5, 6]

function shareOf(
  cells: TokenUsageHeatCell[],
  predicate: (c: TokenUsageHeatCell) => boolean
): number {
  let total = 0
  let matched = 0
  for (const c of cells) {
    total += c.total_tokens
    if (predicate(c)) matched += c.total_tokens
  }
  return total > 0 ? matched / total : 0
}

export function deriveArchetype(report: TokenUsageReport): Archetype {
  const { totals, heatmap, streak, by_agent, by_folder } = report

  const nightShare = shareOf(heatmap, (c) => NIGHT_HOURS.includes(c.hour))
  if (nightShare >= 0.35) {
    return { id: "nightOwl", values: { percent: Math.round(nightShare * 100) } }
  }

  const morningShare = shareOf(heatmap, (c) => MORNING_HOURS.includes(c.hour))
  if (morningShare >= 0.3) {
    return {
      id: "earlyBird",
      values: { percent: Math.round(morningShare * 100) },
    }
  }

  const weekendShare = shareOf(heatmap, (c) => WEEKEND_DAYS.includes(c.weekday))
  if (weekendShare >= 0.35) {
    return {
      id: "weekendWarrior",
      values: { percent: Math.round(weekendShare * 100) },
    }
  }

  const cache = cacheHitRate(totals)
  if (cache !== null && cache >= 0.7) {
    return { id: "cacheMaster", values: { percent: Math.round(cache * 100) } }
  }

  if (streak.longest_days >= 7) {
    return { id: "marathoner", values: { days: streak.longest_days } }
  }

  const significantAgents = by_agent.filter(
    (a) =>
      totals.total_tokens > 0 && a.total_tokens / totals.total_tokens >= 0.1
  ).length
  if (significantAgents >= 3) {
    return { id: "polyglot", values: { count: significantAgents } }
  }

  const topFolder = by_folder[0]
  if (
    topFolder &&
    totals.total_tokens > 0 &&
    topFolder.total_tokens / totals.total_tokens >= 0.7 &&
    by_folder.length > 1
  ) {
    return {
      id: "laserFocus",
      values: {
        percent: Math.round(
          (topFolder.total_tokens / totals.total_tokens) * 100
        ),
      },
    }
  }

  const perConversation = averagePerConversation(totals)
  if (perConversation >= 500_000) {
    // Thousands, so the translated string can interpolate a plain number
    // ("{averageK}K tokens") without needing a formatter injected here.
    return {
      id: "deepDiver",
      values: { averageK: Math.round(perConversation / 1000) },
    }
  }

  return { id: "steady", values: { days: totals.active_days } }
}

// ─── Formatting ─────────────────────────────────────────────────────────

/**
 * Token counts for headline positions: two significant decimals so a share
 * card reads "1.28M" rather than the lossy "1.3M" the compact list formatter
 * produces.
 */
export function formatTokensPrecise(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString()
}

/** `1h 24m` / `3m 05s` / `12s` — generation time, never zero-padded hours. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

/** A filename-safe stamp for the exported share card. */
export function shareCardFilename(range: ResolvedRange, now: Date): string {
  const day = (iso: string) => iso.slice(0, 10)
  const span =
    range.start && range.end
      ? `${day(range.start)}_${day(new Date(new Date(range.end).getTime() - 1).toISOString())}`
      : "all-time"
  return `codeg-tokens-${span}-${day(now.toISOString())}.png`
}

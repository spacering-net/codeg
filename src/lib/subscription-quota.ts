/**
 * Remaining-subscription inventory.
 *
 * ACP `usage_update` is context occupancy `{used, size}`, not plan remaining.
 *
 * Official remaining-quota sources, verified against live CLIs:
 *   Codex: documented app-server `account/rateLimits/read`.
 *     Live result (2026-08-15) is `{ rateLimits.primary.usedPercent,
 *     windowDurationMins, resetsAt, planType, rateLimitsByLimitId }`.
 *     `primary` is the current window (here a 10080-minute week), not a
 *     guaranteed 5-hour window.
 *   Claude: there is no `claude usage` CLI. The `/usage` HUD reads
 *     `GET https://api.anthropic.com/api/oauth/usage` with the local
 *     Claude Code OAuth token (same endpoint community monitors use).
 *     Live 2026-08-15: `five_hour.utilization` / `seven_day.utilization`
 *     are 0-100 percents, not 0-1 fractions.
 *   Grok: no usage CLI. Live 2026-08-15:
 *     `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
 *     with the Grok CLI OAuth token (`x-xai-token-auth: xai-grok-cli`)
 *     returns `config.creditUsagePercent` (0-100) and period end.
 *   Cursor: no `usage` CLI. `status` / `about --format json` are identity
 *     only. The official CLI/IDE client reads remaining from
 *     `POST aiserver.v1.DashboardService/GetCurrentPeriodUsage` on
 *     `api2.cursor.sh`. `planUsage` has `remaining` / `limit` plus
 *     `total_percent_used` / `auto_percent_used` / `api_percent_used`.
 *   OpenCode Go: official `GET https://opencode.ai/zen/go/v1/usage`
 *     (shipped 2026-08-11, anomalyco/opencode#16513) with the Go API
 *     key. `{ usage.rolling|weekly|monthly: { percent, resetsAt } }`.
 *     `percent` is used 0-100. `opencode stats` is still historical
 *     session cost, not this. Zen pay-as-you-go has no remaining API.
 * Gemini: no remaining-quota command.
 */

export type IsolatableFamily =
  | "claude"
  | "codex"
  | "grok"
  | "cursor"
  | "gemini"
  | "opencode"

/** Custom families are resolved from saved launch configuration by the server. */
export function familyFromAgentType(
  agentType: string | null | undefined
): IsolatableFamily | null {
  return (
    (
      {
        claude_code: "claude",
        codex: "codex",
        grok: "grok",
        cursor: "cursor",
        open_code: "opencode",
      } as Record<string, IsolatableFamily>
    )[agentType ?? ""] ?? null
  )
}

export type QuotaKind = "remaining-subscription" | "acp-context" | "unavailable"

export type QuotaWindow = {
  remaining: number
  usedPercent: number
  windowDurationMins?: number
  resetsAt?: number
  label?: string
}

export type FamilyQuota =
  | {
      family: IsolatableFamily
      kind: "remaining-subscription"
      label?: string
      hasOtherCapacity?: boolean
      hasModelLimits?: boolean
      remaining: number
      limit: number
      source: string
      planType?: string
      rateLimitReached?: boolean
      extras?: QuotaWindow[]
      resetsAt?: number
      windowDurationMins?: number
    }
  | {
      family: IsolatableFamily
      kind: "acp-context"
      used: number
      size: number
    }
  | {
      family: IsolatableFamily
      kind: "unavailable"
      providerUsageUrl: string
    }

export const PROVIDER_USAGE_URLS: Record<IsolatableFamily, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
  grok: "https://accounts.x.ai/",
  cursor: "https://cursor.com/dashboard/spending",
  gemini: "https://aistudio.google.com/",
  opencode: "https://opencode.ai/go",
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function percentRemaining(usedPercent: unknown): number | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null
  }
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return undefined
      return n > 1e12 ? Math.floor(n / 1000) : n
    }
    const ms = Date.parse(trimmed)
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
  }
  return undefined
}

/** Live `/api/oauth/usage` returns 0-100 percent, not a 0-1 fraction. */
function utilizationRemaining(utilization: unknown): number | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null
  }
  return Math.max(0, Math.min(100, 100 - utilization))
}

function windowFromUtilization(
  value: unknown,
  label: string
): QuotaWindow | null {
  const rec = asRecord(value)
  if (!rec) return null
  const remaining = utilizationRemaining(rec.utilization)
  if (remaining == null || typeof rec.utilization !== "number") return null
  return {
    remaining,
    usedPercent: rec.utilization,
    resetsAt: parseResetsAt(rec.resets_at),
    label,
  }
}

function codexWindows(
  limit: Record<string, unknown>,
  prefix = ""
): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const key of ["primary", "secondary"]) {
    const value = asRecord(limit[key])
    const remaining = percentRemaining(value?.usedPercent)
    if (remaining == null || !value) continue
    const mins =
      typeof value.windowDurationMins === "number"
        ? value.windowDurationMins
        : undefined
    const duration =
      mins === 300
        ? "5-hour"
        : mins === 10080
          ? "weekly"
          : mins
            ? `${mins / 60}h`
            : key
    windows.push({
      remaining,
      usedPercent: 100 - remaining,
      windowDurationMins: mins,
      resetsAt: parseResetsAt(value.resetsAt),
      label: prefix ? `${prefix} · ${duration}` : duration,
    })
  }
  return windows
}

/** Official Codex app-server account/rateLimits/read, including every window. */
export function remainingFromCodexAppServer(
  payload: unknown
): OfficialRemaining | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const result = asRecord(rec.result) ?? rec
  const limits = asRecord(result.rateLimits)
  if (!limits) return null
  const windows = codexWindows(limits)
  if (!windows.length) return null
  const primary = windows.reduce((a, b) => (a.remaining <= b.remaining ? a : b))
  const extras = windows.filter((w) => w !== primary)
  const byId = asRecord(result.rateLimitsByLimitId)
  let hasOtherCapacity = false
  if (byId)
    for (const [id, value] of Object.entries(byId)) {
      if (id === limits.limitId) continue
      const other = asRecord(value)
      if (!other) continue
      const more = codexWindows(
        other,
        typeof other.limitName === "string" ? other.limitName : id
      )
      if (more.length && more.every((w) => w.remaining > 0))
        hasOtherCapacity = true
      extras.push(...more)
    }
  const credits = asRecord(limits.credits)
  hasOtherCapacity ||=
    credits?.hasCredits === true || credits?.unlimited === true
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "codex account/rateLimits/read",
    label: primary.label,
    planType: typeof limits.planType === "string" ? limits.planType : undefined,
    rateLimitReached: limits.rateLimitReachedType === "rate_limit_reached",
    hasOtherCapacity,
    extras: extras.length ? extras : undefined,
    resetsAt: primary.resetsAt,
    windowDurationMins: primary.windowDurationMins,
  }
}

/** Claude Code `/usage` payload from `GET /api/oauth/usage`. */
export function remainingFromClaudeUsageHud(
  payload: unknown
): OfficialRemaining | null {
  const rec = asRecord(payload)
  if (!rec) return null
  let candidates = [
    windowFromUtilization(rec.five_hour, "5-hour"),
    windowFromUtilization(rec.seven_day, "weekly"),
  ].filter((w): w is QuotaWindow => w != null)
  const scoped: QuotaWindow[] = []
  if (Array.isArray(rec.limits)) {
    const current: QuotaWindow[] = []
    for (const raw of rec.limits) {
      const limit = asRecord(raw)
      const remaining = percentRemaining(limit?.percent)
      if (!limit || remaining == null) continue
      const label = limit.kind === "session" ? "5-hour" : "weekly"
      const window = {
        remaining,
        usedPercent: 100 - remaining,
        resetsAt: parseResetsAt(limit.resets_at),
        label,
      }
      const scope = asRecord(limit.scope)
      const model = asRecord(scope?.model)
      const scopeName =
        typeof limit.scope === "string"
          ? limit.scope
          : typeof model?.display_name === "string"
            ? model.display_name
            : "model"
      if (
        !limit.scope &&
        (limit.kind === "session" || limit.kind === "weekly_all")
      )
        current.push(window)
      else if (limit.kind === "weekly_scoped" || limit.scope)
        scoped.push({
          ...window,
          label: `${scopeName} · weekly`,
        })
    }
    if (current.length) candidates = current
  }
  if (!candidates.length) return null
  if (!scoped.length)
    for (const [key, label] of [
      ["seven_day_opus", "Opus"],
      ["seven_day_sonnet", "Sonnet"],
    ]) {
      const w = windowFromUtilization(rec[key], `${label} · weekly`)
      if (w) scoped.push(w)
    }
  const primary = candidates.reduce((a, b) =>
    a.remaining <= b.remaining ? a : b
  )
  const extraUsage = asRecord(rec.extra_usage)
  const extra =
    extraUsage?.is_enabled === true
      ? windowFromUtilization(extraUsage, "extra usage")
      : null
  const extras = [
    ...candidates.filter((w) => w !== primary),
    ...scoped,
    ...(extra ? [extra] : []),
  ]
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "claude /api/oauth/usage",
    hasModelLimits: scoped.some(
      (window) => window.remaining < primary.remaining
    ),
    hasOtherCapacity: extra != null && extra.remaining > 0,
    label: primary.label,
    extras: extras.length ? extras : undefined,
    resetsAt: primary.resetsAt,
  }
}

/**
 * Read remaining subscription from a recorded official payload.
 * Production Codeg never invents this object.
 */
export type OfficialRemaining = {
  label?: string
  hasOtherCapacity?: boolean
  hasModelLimits?: boolean
  remaining: number
  limit: number
  source: string
  planType?: string
  rateLimitReached?: boolean
  extras?: QuotaWindow[]
  resetsAt?: number
  windowDurationMins?: number
}

/** Grok CLI-proxy `GET /v1/billing?format=credits`. */
export function remainingFromGrokBilling(
  payload: unknown
): OfficialRemaining | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const config = asRecord(rec.config) ?? rec
  const remaining = percentRemaining(config.creditUsagePercent)
  if (remaining == null) return null
  const period = asRecord(config.currentPeriod)
  return {
    remaining,
    limit: 100,
    source: "grok cli-chat-proxy /v1/billing",
    resetsAt: parseResetsAt(period?.end ?? config.billingPeriodEnd),
  }
}

function pickNum(
  rec: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function windowFromUsedPercent(
  usedPercent: number | null,
  label: string
): QuotaWindow | null {
  const remaining = percentRemaining(usedPercent)
  if (remaining == null || usedPercent == null) return null
  return { remaining, usedPercent, label }
}

/**
 * Cursor CLI/IDE `GetCurrentPeriodUsage` `planUsage` object.
 * Field names from aiserver.v1.GetCurrentPeriodUsageResponse.PlanUsage.
 */
export function remainingFromCursorPeriodUsage(
  payload: unknown
): OfficialRemaining | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const plan = asRecord(rec.planUsage) ?? asRecord(rec.plan_usage) ?? rec
  if (!plan) return null

  const usedTotal = pickNum(plan, "totalPercentUsed", "total_percent_used")
  const usedAuto = pickNum(plan, "autoPercentUsed", "auto_percent_used")
  const usedApi = pickNum(plan, "apiPercentUsed", "api_percent_used")
  const leftover = pickNum(plan, "remaining")
  const cap = pickNum(plan, "limit")

  let remaining: number | null = percentRemaining(usedTotal)
  if (remaining == null && leftover != null && cap != null && cap > 0) {
    remaining = Math.max(0, Math.min(100, (100 * leftover) / cap))
  }
  if (remaining == null) return null

  const extras = [
    windowFromUsedPercent(usedAuto, "Auto / Composer"),
    windowFromUsedPercent(usedApi, "API"),
  ].filter((w): w is QuotaWindow => w != null)

  return {
    remaining,
    limit: 100,
    source: "cursor DashboardService/GetCurrentPeriodUsage",
    extras: extras.length ? extras : undefined,
    resetsAt: parseResetsAt(rec.billingCycleEnd ?? rec.billing_cycle_end),
  }
}

function windowFromOpencodeGo(
  value: unknown,
  label: string
): QuotaWindow | null {
  const rec = asRecord(value)
  if (!rec) return null
  const used = pickNum(rec, "percent", "usagePercent", "usage_percent")
  const remaining = percentRemaining(used)
  if (remaining == null || used == null) return null
  return {
    remaining,
    usedPercent: used,
    resetsAt: parseResetsAt(rec.resetsAt ?? rec.resets_at),
    label,
  }
}

/**
 * Official OpenCode Go `GET /zen/go/v1/usage`.
 * `percent` is used 0-100. Shipped 2026-08-11 (#16513).
 */
export function remainingFromOpencodeGoUsage(
  payload: unknown
): OfficialRemaining | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const usage = asRecord(rec.usage) ?? rec
  const rolling = windowFromOpencodeGo(usage.rolling, "5-hour")
  const weekly = windowFromOpencodeGo(usage.weekly, "weekly")
  const monthly = windowFromOpencodeGo(usage.monthly, "monthly")
  const candidates = [rolling, weekly, monthly].filter(
    (w): w is QuotaWindow => w != null
  )
  if (candidates.length === 0) return null
  const primary = candidates.reduce((a, b) =>
    a.remaining <= b.remaining ? a : b
  )
  const extras = candidates.filter((w) => w !== primary)
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "opencode /zen/go/v1/usage",
    label: primary.label,
    extras: extras.length ? extras : undefined,
    resetsAt: primary.resetsAt,
  }
}

export function remainingFromOfficialPayload(
  family: IsolatableFamily,
  payload: unknown
): OfficialRemaining | null {
  if (family === "codex") return remainingFromCodexAppServer(payload)
  if (family === "claude") return remainingFromClaudeUsageHud(payload)
  if (family === "grok") return remainingFromGrokBilling(payload)
  if (family === "cursor") return remainingFromCursorPeriodUsage(payload)
  if (family === "opencode") return remainingFromOpencodeGoUsage(payload)
  return null
}

export function acpContextFromPayload(
  payload: unknown
): { used: number; size: number } | null {
  if (!payload || typeof payload !== "object") return null
  const rec = payload as Record<string, unknown>
  if (typeof rec.used !== "number" || typeof rec.size !== "number") return null
  if (!Number.isFinite(rec.used) || !Number.isFinite(rec.size)) return null
  return { used: rec.used, size: rec.size }
}

export function familyQuota(
  family: IsolatableFamily,
  officialPayload?: unknown,
  acpUsage?: unknown
): FamilyQuota {
  const remaining = remainingFromOfficialPayload(family, officialPayload)
  if (remaining) return { family, kind: "remaining-subscription", ...remaining }
  const context = acpContextFromPayload(acpUsage)
  if (context) return { family, kind: "acp-context", ...context }
  return {
    family,
    kind: "unavailable",
    providerUsageUrl: PROVIDER_USAGE_URLS[family],
  }
}

export function emitsRemainingSubscription(row: FamilyQuota): boolean {
  return row.kind === "remaining-subscription"
}

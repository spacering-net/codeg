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
 * Gemini / OpenCode: no remaining-quota command. OpenCode `stats` is
 * historical token/cost, not plan remaining.
 */

export type IsolatableFamily =
  | "claude"
  | "codex"
  | "grok"
  | "cursor"
  | "gemini"
  | "opencode"

/** Map a conversation's agent_type (built-in or `custom:<family>-N`) to the
 *  remaining-quota family, or null when that agent has no remaining-quota
 *  source. Extra slots keep the family isolator (`custom:claude-code-2`). */
export function familyFromAgentType(
  agentType: string | null | undefined
): IsolatableFamily | null {
  if (!agentType) return null
  const s = agentType.toLowerCase()
  if (s === "claude_code" || s.startsWith("custom:claude")) return "claude"
  if (s === "codex" || s.startsWith("custom:codex")) return "codex"
  if (s === "grok" || s.startsWith("custom:grok")) return "grok"
  if (s === "cursor" || s.startsWith("custom:cursor")) return "cursor"
  if (s === "gemini" || s.startsWith("custom:gemini")) return "gemini"
  if (
    s === "open_code" ||
    s.startsWith("custom:opencode") ||
    s.startsWith("custom:open-code") ||
    s.startsWith("custom:open_code")
  ) {
    return "opencode"
  }
  return null
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
  codex: "https://chatgpt.com/#settings",
  grok: "https://accounts.x.ai/",
  cursor: "https://cursor.com/dashboard/spending",
  gemini: "https://aistudio.google.com/",
  opencode: "https://opencode.ai/",
}

const FAMILIES: IsolatableFamily[] = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "gemini",
  "opencode",
]

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

function windowFromLimit(limit: Record<string, unknown>): QuotaWindow | null {
  const primary = asRecord(limit.primary)
  const remaining = percentRemaining(primary?.usedPercent)
  if (remaining == null || typeof primary?.usedPercent !== "number") return null
  const windowDurationMins =
    typeof primary.windowDurationMins === "number"
      ? primary.windowDurationMins
      : undefined
  const resetsAt =
    typeof primary.resetsAt === "number" ? primary.resetsAt : undefined
  const label =
    typeof limit.limitName === "string"
      ? limit.limitName
      : typeof limit.limitId === "string"
        ? limit.limitId
        : undefined
  return {
    remaining,
    usedPercent: primary.usedPercent,
    windowDurationMins,
    resetsAt,
    label,
  }
}

/** Documented Codex app-server `account/rateLimits/read` result. */
export function remainingFromCodexAppServer(payload: unknown): {
  remaining: number
  limit: number
  source: string
  planType?: string
  rateLimitReached?: boolean
  extras?: QuotaWindow[]
  resetsAt?: number
  windowDurationMins?: number
} | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const result = asRecord(rec.result) ?? rec
  const limits = asRecord(result.rateLimits)
  if (!limits) return null
  const primary = windowFromLimit(limits)
  if (!primary) return null
  const extras: QuotaWindow[] = []
  const byId = asRecord(result.rateLimitsByLimitId)
  const primaryId = typeof limits.limitId === "string" ? limits.limitId : null
  if (byId) {
    for (const [id, value] of Object.entries(byId)) {
      if (primaryId && id === primaryId) continue
      const extra = asRecord(value)
      if (!extra) continue
      const parsed = windowFromLimit(extra)
      if (parsed) extras.push(parsed)
    }
  }
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "codex account/rateLimits/read",
    planType: typeof limits.planType === "string" ? limits.planType : undefined,
    rateLimitReached: limits.rateLimitReachedType === "rate_limit_reached",
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
  const five = windowFromUtilization(rec.five_hour, "5-hour")
  const week = windowFromUtilization(rec.seven_day, "weekly")
  const extra = windowFromUtilization(rec.extra_usage, "extra usage")
  const candidates = [five, week].filter((w): w is QuotaWindow => w != null)
  if (candidates.length === 0) return null
  const primary = candidates.reduce((a, b) =>
    a.remaining <= b.remaining ? a : b
  )
  const extras = [five, week, extra].filter(
    (w): w is QuotaWindow => w != null && w !== primary
  )
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "claude /api/oauth/usage",
    extras: extras.length ? extras : undefined,
    resetsAt: primary.resetsAt,
  }
}

/**
 * Read remaining subscription from a recorded official payload.
 * Production Codeg never invents this object.
 */
export type OfficialRemaining = {
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

export function remainingFromOfficialPayload(
  family: IsolatableFamily,
  payload: unknown
): OfficialRemaining | null {
  if (family === "codex") return remainingFromCodexAppServer(payload)
  if (family === "claude") return remainingFromClaudeUsageHud(payload)
  if (family === "grok") return remainingFromGrokBilling(payload)
  if (family === "cursor") return remainingFromCursorPeriodUsage(payload)
  return null
}

export type OfficialQuotaSlot = {
  label: string
  payload: unknown
}

export function attachExtraSlots(
  remaining: OfficialRemaining | null,
  family: IsolatableFamily,
  extraSlots?: OfficialQuotaSlot[] | null
): OfficialRemaining | null {
  const more: QuotaWindow[] = []
  for (const slot of extraSlots ?? []) {
    const parsed = remainingFromOfficialPayload(family, slot.payload)
    if (!parsed) continue
    more.push({
      remaining: parsed.remaining,
      usedPercent: Math.max(0, Math.min(100, 100 - parsed.remaining)),
      resetsAt: parsed.resetsAt,
      label: slot.label,
    })
  }
  if (!remaining) {
    if (more.length === 0) return null
    const primary = more.reduce((a, b) => (a.remaining <= b.remaining ? a : b))
    return {
      remaining: primary.remaining,
      limit: 100,
      source: `${family} extra slot`,
      extras: more.filter((slot) => slot !== primary),
      resetsAt: primary.resetsAt,
    }
  }
  if (more.length === 0) return remaining
  return {
    ...remaining,
    extras: [...(remaining.extras ?? []), ...more],
  }
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
  acpUsage?: unknown,
  extraSlots?: OfficialQuotaSlot[] | null
): FamilyQuota {
  const remaining = attachExtraSlots(
    remainingFromOfficialPayload(family, officialPayload),
    family,
    extraSlots
  )
  if (remaining) {
    return { family, kind: "remaining-subscription", ...remaining }
  }
  const context = acpContextFromPayload(acpUsage)
  if (context) {
    return { family, kind: "acp-context", ...context }
  }
  return {
    family,
    kind: "unavailable",
    providerUsageUrl: PROVIDER_USAGE_URLS[family],
  }
}

export function inventory(
  officialByFamily: Partial<Record<IsolatableFamily, unknown>> = {},
  acpByFamily: Partial<Record<IsolatableFamily, unknown>> = {},
  extraSlotsByFamily: Partial<
    Record<IsolatableFamily, OfficialQuotaSlot[]>
  > = {}
): FamilyQuota[] {
  return FAMILIES.map((family) =>
    familyQuota(
      family,
      officialByFamily[family],
      acpByFamily[family],
      extraSlotsByFamily[family]
    )
  )
}

export function emitsRemainingSubscription(row: FamilyQuota): boolean {
  return row.kind === "remaining-subscription"
}

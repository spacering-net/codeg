export interface UsageSource {
  id: string
  title: string
  titleTranslations?: Record<string, string>
  provider?: string
  method: string
}

export interface UsageQueryRequest {
  pluginId: string
  sourceId: string
  locale?: string
}

export interface UsageQueryInput {
  sourceId: string
  locale: string
}

export interface UsageQueryResult {
  accounts: UsageAccount[]
}

export interface UsageAccount {
  /** Unique within the query result. */
  key: string
  label?: string
  harness?: string
  report: UsageReport
}

export type UsageReport =
  | {
      status: "available"
      planLabel?: string
      windows: UsageWindow[]
      balances?: UsageBalance[]
      details?: UsageDetail[]
    }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string }

export interface UsageWindow {
  /** Unique among the account's windows after control characters are removed. */
  id: string
  label: string
  usedPercent: number
  resetsAt?: string
  durationSeconds?: number
}

export interface UsageBalance {
  /** Unique among the account's balances after control characters are removed. */
  id: string
  label: string
  amount: string
  unit?: string
}

export interface UsageDetail {
  label: string
  value: string
}

export interface UsageProblem {
  kind: "expired" | "rejected" | "no_quota"
  detail?: string
  expiresAt?: string
  status?: number
}

"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { RefreshCw, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { getAgentQuota, refreshAgentQuota } from "@/lib/api"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AgentQuotaInfo, QuotaWindow } from "@/lib/types"
import { cn } from "@/lib/utils"

// Agents with a quota probe on the backend (`src-tauri/src/quota/`). Devin
// appears twice: the built-in id and the wire id of a user-registered custom
// ACP agent named `devin` are the same account.
const SUPPORTED_AGENTS = new Set([
  "codex",
  "antigravity",
  "claude_code",
  "devin",
  "custom:devin",
])

const quotaCache = new Map<
  string,
  { info: AgentQuotaInfo | null; fetchedAt: number }
>()
const quotaListeners = new Map<string, Set<() => void>>()

export function resetQuotaCache() {
  quotaCache.clear()
  quotaListeners.clear()
}

function notifyQuotaChanged(agentType: string) {
  quotaListeners.get(agentType)?.forEach((cb) => cb())
}

function subscribeQuota(agentType: string, callback: () => void) {
  if (!quotaListeners.has(agentType)) {
    quotaListeners.set(agentType, new Set())
  }
  quotaListeners.get(agentType)!.add(callback)
  return () => {
    quotaListeners.get(agentType)?.delete(callback)
  }
}

function formatCountdown(
  resetInSeconds: number | null | undefined,
  resetsAt: string | null | undefined,
  t: any
): string | null {
  let seconds = resetInSeconds
  if (seconds == null && resetsAt) {
    const diff = Math.floor((new Date(resetsAt).getTime() - Date.now()) / 1000)
    seconds = Math.max(0, diff)
  }
  if (seconds == null) return null

  if (seconds <= 0) {
    return t("resetsSoon")
  }

  const daysUnit = t("days")
  const hoursUnit = t("hours")
  const minutesUnit = t("minutes")
  const secondsUnit = t("seconds")

  if (seconds < 60) {
    return t("resetsIn", { time: `${seconds}${secondsUnit}` })
  }

  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    return t("resetsIn", { time: `${mins}${minutesUnit}` })
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const timeStr =
      mins > 0
        ? `${hours}${hoursUnit} ${mins}${minutesUnit}`
        : `${hours}${hoursUnit}`
    return t("resetsIn", { time: timeStr })
  }

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const timeStr =
    hours > 0 ? `${days}${daysUnit} ${hours}${hoursUnit}` : `${days}${daysUnit}`
  return t("resetsIn", { time: timeStr })
}

/** The window with the least remaining — the one that will run out first. */
export function pickBindingWindow(
  quota: AgentQuotaInfo | null | undefined
): QuotaWindow | null {
  const short = quota?.shortWindow ?? null
  const weekly = quota?.weeklyWindow ?? null
  if (short && weekly) {
    return weekly.remainingPercent < short.remainingPercent ? weekly : short
  }
  return short ?? weekly
}

function getShortWindowLabel(rawLabel: string): string {
  const lower = rawLabel.toLowerCase()
  if (
    lower.includes("5-hour") ||
    lower.includes("5h") ||
    lower.includes("5小时")
  )
    return "5h"
  if (lower.includes("week") || lower.includes("7d") || lower.includes("周"))
    return "7d"
  if (lower.includes("daily") || lower.includes("day") || lower.includes("日"))
    return "1d"
  if (rawLabel.length > 6) return rawLabel.slice(0, 5)
  return rawLabel
}

/**
 * Quota badge and popover shown in the composer status row.
 * Displays rate limit / usage window for supported agents (Codex, Antigravity).
 */
export function ComposerQuotaBadge({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.quota")
  const store = useConnectionStore()

  const tabAgentType = useTabStore((s) => {
    const tab = s.tabs.find((x) => x.id === tabId)
    return tab?.agentType ?? null
  })

  const subscribeConn = useCallback(
    (cb: () => void) => {
      if (!tabId) return () => {}
      return store.subscribeKey(tabId, cb)
    },
    [store, tabId]
  )

  const getConnSnapshot = useCallback(
    () => (tabId ? store.getConnection(tabId) : undefined),
    [store, tabId]
  )
  const conn = useSyncExternalStore(
    subscribeConn,
    getConnSnapshot,
    getConnSnapshot
  )

  const getPendingSnapshot = useCallback(
    () => (tabId ? store.getConnectPending(tabId) : undefined),
    [store, tabId]
  )
  const connectPending = useSyncExternalStore(
    subscribeConn,
    getPendingSnapshot,
    getPendingSnapshot
  )

  const getConnectErrorSnapshot = useCallback(
    () => (tabId ? store.getConnectError(tabId) : undefined),
    [store, tabId]
  )
  const connectError = useSyncExternalStore(
    subscribeConn,
    getConnectErrorSnapshot,
    getConnectErrorSnapshot
  )

  const failedConnect = !conn && !connectPending ? connectError : undefined

  const agentType =
    conn?.agentType ??
    connectPending?.agentType ??
    failedConnect?.agentType ??
    tabAgentType ??
    null

  const isSupported = agentType != null && SUPPORTED_AGENTS.has(agentType)

  const subscribeAgentQuota = useCallback(
    (cb: () => void) => {
      if (!agentType) return () => {}
      return subscribeQuota(agentType, cb)
    },
    [agentType]
  )

  const getQuotaSnapshot = useCallback(() => {
    return agentType ? (quotaCache.get(agentType)?.info ?? null) : null
  }, [agentType])

  const quota = useSyncExternalStore(
    subscribeAgentQuota,
    getQuotaSnapshot,
    getQuotaSnapshot
  )

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => (tick + 1) % 100000)
    }, 10_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!agentType || !SUPPORTED_AGENTS.has(agentType)) return

    let mounted = true
    const cached = quotaCache.get(agentType)
    const isStale = !cached || Date.now() - cached.fetchedAt > 60_000

    if (isStale) {
      setLoading(true)
      getAgentQuota(agentType)
        .then((info) => {
          if (!mounted) return
          quotaCache.set(agentType, { info, fetchedAt: Date.now() })
          notifyQuotaChanged(agentType)
        })
        .catch(() => {})
        .finally(() => {
          if (mounted) setLoading(false)
        })
    }

    const timer = setInterval(() => {
      getAgentQuota(agentType)
        .then((info) => {
          if (!mounted) return
          quotaCache.set(agentType, { info, fetchedAt: Date.now() })
          notifyQuotaChanged(agentType)
        })
        .catch(() => {})
    }, 60_000)

    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [agentType])

  if (!isSupported || !agentType) {
    return null
  }

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!agentType || refreshing) return
    setRefreshing(true)
    try {
      const info = await refreshAgentQuota(agentType)
      quotaCache.set(agentType, { info, fetchedAt: Date.now() })
      notifyQuotaChanged(agentType)
    } catch (err) {
      console.error("Failed to refresh agent quota:", err)
    } finally {
      setRefreshing(false)
    }
  }

  const agentLabel = getAgentLabel(agentType)

  // Show whichever window is actually binding — the one with less left. A
  // plan whose short window never bites (e.g. ChatGPT Pro, whose 5-hour window
  // sits near 100% while the weekly one drains) should read its weekly figure,
  // not a reassuring but irrelevant 5h number. Ties keep the short window.
  const bindingWindow = pickBindingWindow(quota)

  let shortText = ""
  if (bindingWindow) {
    shortText = `${getShortWindowLabel(bindingWindow.label)}: ${Math.round(bindingWindow.remainingPercent)}%`
  } else if (quota?.planName) {
    shortText = quota.planName
  } else {
    shortText = t("title")
  }

  const isLowQuota =
    (quota?.shortWindow != null && quota.shortWindow.remainingPercent <= 20) ||
    (quota?.weeklyWindow != null && quota.weeklyWindow.remainingPercent <= 20)
  const isCriticalQuota =
    (quota?.shortWindow != null && quota.shortWindow.remainingPercent <= 5) ||
    (quota?.weeklyWindow != null && quota.weeklyWindow.remainingPercent <= 5)

  const triggerTitle = quota
    ? `${agentLabel} ${t("title")}${quota.planName ? ` (${quota.planName})` : ""}: ${shortText}`
    : `${agentLabel} ${t("title")}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={triggerTitle}
          aria-label={t("triggerAria")}
          className={cn(
            "flex items-center gap-1 transition-colors text-xs hover:text-foreground",
            isCriticalQuota
              ? "text-red-500 font-medium"
              : isLowQuota
                ? "text-amber-500 font-medium"
                : "text-muted-foreground"
          )}
        >
          <Zap
            className={cn(
              "size-3.5 shrink-0",
              isCriticalQuota
                ? "text-red-500"
                : isLowQuota
                  ? "text-amber-500"
                  : "text-current"
            )}
          />
          <span>{shortText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-64 gap-2.5 p-3 text-xs"
      >
        {/* Header: Agent Icon + Agent Label + Plan Badge + Refresh Button */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <AgentIcon agentType={agentType} className="size-4 shrink-0" />
            <span className="font-medium truncate">{agentLabel}</span>
            {quota?.planName ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground shrink-0">
                {quota.planName}
              </span>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            disabled={refreshing}
            title={refreshing ? t("refreshing") : t("refresh")}
            aria-label={refreshing ? t("refreshing") : t("refresh")}
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
          </Button>
        </div>

        {/* Short Window Section */}
        {quota?.shortWindow ? (
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">
                {quota.shortWindow.label || t("shortWindow")}
              </span>
              <span
                className={cn(
                  "tabular-nums text-2xs font-medium",
                  quota.shortWindow.remainingPercent <= 5
                    ? "text-red-500"
                    : quota.shortWindow.remainingPercent <= 20
                      ? "text-amber-500"
                      : "text-muted-foreground"
                )}
              >
                {t("remaining")}{" "}
                {Math.round(quota.shortWindow.remainingPercent)}%
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full transition-all duration-300 rounded-full",
                  quota.shortWindow.remainingPercent <= 5
                    ? "bg-red-500"
                    : quota.shortWindow.remainingPercent <= 20
                      ? "bg-amber-500"
                      : "bg-foreground/70"
                )}
                style={{
                  width: `${Math.max(0, Math.min(100, quota.shortWindow.remainingPercent))}%`,
                }}
              />
            </div>
            {formatCountdown(
              quota.shortWindow.resetInSeconds,
              quota.shortWindow.resetsAt,
              t
            ) ? (
              <div className="text-2xs text-muted-foreground">
                {formatCountdown(
                  quota.shortWindow.resetInSeconds,
                  quota.shortWindow.resetsAt,
                  t
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Weekly Window Section */}
        {quota?.weeklyWindow ? (
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">
                {quota.weeklyWindow.label || t("weeklyWindow")}
              </span>
              <span
                className={cn(
                  "tabular-nums text-2xs font-medium",
                  quota.weeklyWindow.remainingPercent <= 5
                    ? "text-red-500"
                    : quota.weeklyWindow.remainingPercent <= 20
                      ? "text-amber-500"
                      : "text-muted-foreground"
                )}
              >
                {t("remaining")}{" "}
                {Math.round(quota.weeklyWindow.remainingPercent)}%
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full transition-all duration-300 rounded-full",
                  quota.weeklyWindow.remainingPercent <= 5
                    ? "bg-red-500"
                    : quota.weeklyWindow.remainingPercent <= 20
                      ? "bg-amber-500"
                      : "bg-foreground/70"
                )}
                style={{
                  width: `${Math.max(0, Math.min(100, quota.weeklyWindow.remainingPercent))}%`,
                }}
              />
            </div>
            {formatCountdown(
              quota.weeklyWindow.resetInSeconds,
              quota.weeklyWindow.resetsAt,
              t
            ) ? (
              <div className="text-2xs text-muted-foreground">
                {formatCountdown(
                  quota.weeklyWindow.resetInSeconds,
                  quota.weeklyWindow.resetsAt,
                  t
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Spend Limit Section */}
        {quota?.spendLimit ? (
          <div className="flex items-center justify-between text-2xs text-muted-foreground border-t border-border pt-1.5">
            <span>{t("spendLimit")}</span>
            <span className="tabular-nums">
              ${quota.spendLimit.usedUsd.toFixed(2)} / $
              {quota.spendLimit.limitUsd.toFixed(2)}
            </span>
          </div>
        ) : null}

        {/* Empty state if quota is null */}
        {!quota && !loading ? (
          <div className="py-2 text-center text-2xs text-muted-foreground">
            {t("noQuota")}
          </div>
        ) : null}

        {/* Footer: Last Updated */}
        {quota?.lastUpdated ? (
          <div className="text-3xs text-muted-foreground/70 border-t border-border/50 pt-1 text-right">
            {t("lastUpdated", {
              time: new Date(quota.lastUpdated).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            })}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

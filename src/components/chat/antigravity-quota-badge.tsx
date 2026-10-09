"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Gauge,
  Loader2,
  RefreshCw,
  Users,
  Check,
  ChevronDown,
  Clock,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  acpAntigravityGetQuota,
  acpAntigravityListAccounts,
  acpAntigravitySwitchAccount,
  type AntigravityAccountsState,
  type AntigravityQuotaSummary,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

function formatCountdown(isoString?: string | null): string {
  if (!isoString) return "-"
  const target = new Date(isoString).getTime()
  if (isNaN(target)) return "-"
  const diff = target - Date.now()
  if (diff <= 0) return "已重置"

  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}分`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return `${hours}时${remMins}分`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return `${days}天${remHours}时`
}

function formatResetDate(isoString?: string | null): string {
  if (!isoString) return "-"
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return "-"
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function getFractionColor(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return "text-muted-foreground"
  if (fraction > 0.5) return "text-emerald-500 dark:text-emerald-400"
  if (fraction > 0.2) return "text-amber-500 dark:text-amber-400"
  return "text-rose-500 dark:text-rose-400 font-medium"
}

export function AntigravityQuotaBadge() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [quota, setQuota] = useState<AntigravityQuotaSummary | null>(null)
  const [accountsState, setAccountsState] = useState<AntigravityAccountsState | null>(null)

  const loadData = useCallback(async (isManual = false) => {
    setLoading(true)
    try {
      const [quotaRes, accsRes] = await Promise.all([
        acpAntigravityGetQuota().catch((e) => {
          console.warn("Failed to get Antigravity quota", e)
          return null
        }),
        acpAntigravityListAccounts().catch((e) => {
          console.warn("Failed to list Antigravity accounts", e)
          return null
        }),
      ])
      if (quotaRes) setQuota(quotaRes)
      if (accsRes) setAccountsState(accsRes)
      if (isManual) {
        toast.success("额度信息已更新")
      }
    } catch (e) {
      if (isManual) {
        toast.error(`刷新额度失败: ${toErrorMessage(e)}`)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
    // Periodic refresh every 90 seconds
    const interval = setInterval(() => {
      void loadData()
    }, 90_000)
    return () => clearInterval(interval)
  }, [loadData])

  const handleSwitchAccount = async (accountId: string) => {
    if (switching) return
    setSwitching(true)
    try {
      const updated = await acpAntigravitySwitchAccount(accountId)
      setAccountsState(updated)
      toast.success("已切换账号")
      // Immediately reload quota for the new account
      void loadData()
    } catch (e) {
      toast.error(`切换账号失败: ${toErrorMessage(e)}`)
    } finally {
      setSwitching(false)
    }
  }

  // Active account
  const activeAccount = accountsState?.accounts.find((a) => a.isActive) ??
    accountsState?.accounts.find((a) => a.id === accountsState.activeAccountId)

  // If no quota and no accounts loaded yet, show subtle loading indicator
  if (!quota && loading) {
    return (
      <div className="flex items-center gap-1 px-1.5 py-0.5 text-3xs text-muted-foreground animate-pulse">
        <Gauge className="size-3" />
        <span>获取额度中...</span>
      </div>
    )
  }

  if (!quota || (!quota.isAvailable && !quota.email)) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-3xs text-muted-foreground hover:text-foreground gap-1"
        onClick={() => void loadData(true)}
        title={quota?.error ?? "点击获取 Antigravity 额度"}
      >
        <Gauge className="size-3" />
        <span>额度未知</span>
      </Button>
    )
  }

  const fiveHourPct = quota.fiveHourFraction != null ? Math.round(quota.fiveHourFraction * 100) : null
  const weeklyPct = quota.weeklyFraction != null ? Math.round(quota.weeklyFraction * 100) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors cursor-pointer"
          title="点击查看 Antigravity 详细额度与切换账号"
        >
          <Gauge className="size-3 shrink-0 text-muted-foreground" />
          {fiveHourPct != null ? (
            <span className="flex items-center gap-0.5">
              <span>5h:</span>
              <span className={getFractionColor(quota.fiveHourFraction)}>
                {fiveHourPct}%
              </span>
              {quota.fiveHourResetTime && (
                <span className="opacity-75">
                  ({formatCountdown(quota.fiveHourResetTime)})
                </span>
              )}
            </span>
          ) : null}

          {weeklyPct != null ? (
            <span className="flex items-center gap-0.5 ml-1">
              <span>周:</span>
              <span className={getFractionColor(quota.weeklyFraction)}>
                {weeklyPct}%
              </span>
              {quota.weeklyResetTime && (
                <span className="opacity-75">
                  ({formatCountdown(quota.weeklyResetTime)})
                </span>
              )}
            </span>
          ) : null}

          {loading ? <Loader2 className="size-2.5 animate-spin ml-0.5" /> : null}
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-3 space-y-3 text-xs" align="start" side="top">
        {/* Account Info & Switcher */}
        <div className="flex items-center justify-between pb-2 border-b border-border/60">
          <div className="flex items-center gap-2 min-w-0">
            {activeAccount?.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeAccount.picture}
                alt="avatar"
                className="size-6 rounded-full shrink-0"
              />
            ) : (
              <div className="size-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-3xs font-semibold text-primary">
                {(quota.email ?? "A")[0].toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium text-xs truncate" title={quota.email ?? ""}>
                {quota.email ?? "Antigravity 账号"}
              </p>
              {activeAccount?.name && (
                <p className="text-3xs text-muted-foreground truncate">{activeAccount.name}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {accountsState && accountsState.accounts.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-1.5 text-3xs gap-1"
                    disabled={switching}
                  >
                    <Users className="size-3" />
                    <span>切号</span>
                    <ChevronDown className="size-2.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 text-xs">
                  {accountsState.accounts.map((acc) => (
                    <DropdownMenuItem
                      key={acc.id}
                      onClick={() => void handleSwitchAccount(acc.id)}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{acc.email}</p>
                        {acc.name && <p className="truncate text-3xs text-muted-foreground">{acc.name}</p>}
                      </div>
                      {acc.isActive ? <Check className="size-3.5 text-primary shrink-0" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              disabled={loading}
              onClick={() => void loadData(true)}
              title="刷新当前额度"
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Quota Progress */}
        <div className="space-y-2.5">
          {/* 5-Hour Limit */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-2xs">
              <span className="font-medium flex items-center gap-1">
                <Clock className="size-3 text-muted-foreground" />
                5小时限额
              </span>
              <span className={`font-semibold ${getFractionColor(quota.fiveHourFraction)}`}>
                {fiveHourPct != null ? `${fiveHourPct}%` : "-"}
              </span>
            </div>
            <Progress
              value={fiveHourPct ?? 0}
              className="h-1.5"
            />
            <div className="flex items-center justify-between text-3xs text-muted-foreground">
              <span>重置倒计时: {formatCountdown(quota.fiveHourResetTime)}</span>
              <span>重置时间: {formatResetDate(quota.fiveHourResetTime)}</span>
            </div>
          </div>

          {/* Weekly Limit */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-2xs">
              <span className="font-medium flex items-center gap-1">
                <Sparkles className="size-3 text-muted-foreground" />
                一周限额
              </span>
              <span className={`font-semibold ${getFractionColor(quota.weeklyFraction)}`}>
                {weeklyPct != null ? `${weeklyPct}%` : "-"}
              </span>
            </div>
            <Progress
              value={weeklyPct ?? 0}
              className="h-1.5"
            />
            <div className="flex items-center justify-between text-3xs text-muted-foreground">
              <span>重置倒计时: {formatCountdown(quota.weeklyResetTime)}</span>
              <span>重置时间: {formatResetDate(quota.weeklyResetTime)}</span>
            </div>
          </div>
        </div>

        {/* Other Model Groups if present */}
        {quota.groups && quota.groups.length > 1 && (
          <div className="pt-2 border-t border-border/50 space-y-1.5">
            {quota.groups.slice(1).map((group) => (
              <div key={group.displayName} className="space-y-1">
                <p className="text-3xs font-medium text-muted-foreground">{group.displayName}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.buckets.map((b) => (
                    <div key={b.bucketId} className="rounded bg-muted/40 p-1.5 text-3xs">
                      <div className="flex justify-between items-center mb-0.5">
                        <span className="truncate">{b.displayName || b.bucketId}</span>
                        <span className={getFractionColor(b.remainingFraction)}>
                          {Math.round(b.remainingFraction * 100)}%
                        </span>
                      </div>
                      <span className="text-muted-foreground text-3xs block">
                        重置: {formatCountdown(b.resetTime)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-1 text-3xs text-muted-foreground flex justify-between items-center">
          <span>更新于: {new Date(quota.updatedAt * 1000).toLocaleTimeString()}</span>
          <span>可在“设置-Antigravity”添加多账号</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

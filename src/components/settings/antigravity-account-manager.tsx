"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Users,
  UserPlus,
  Trash2,
  CheckCircle2,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  Clock,
  Sparkles,
  AlertCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { BrowserLink } from "@/components/ui/browser-link"
import {
  acpAntigravityAddAccountStart,
  acpAntigravityCheckPendingLogin,
  acpAntigravityDeleteAccount,
  acpAntigravityGetQuota,
  acpAntigravityListAccounts,
  acpAntigravityLoginCancel,
  acpAntigravityLoginFinish,
  acpAntigravitySwitchAccount,
  type AntigravityAccount,
  type AntigravityAccountsState,
  type AntigravityLoginStart,
  type AntigravityQuotaSummary,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"

type PendingAddAccount = Extract<AntigravityLoginStart, { alreadySignedIn: false }>

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

export function AntigravityAccountManager({
  method,
  disabled,
}: {
  method: string
  disabled: boolean
}) {
  const [state, setState] = useState<AntigravityAccountsState | null>(null)
  const [quotas, setQuotas] = useState<Record<string, AntigravityQuotaSummary>>({})
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  // Add account flow state
  const [isAdding, setIsAdding] = useState(false)
  const [pending, setPending] = useState<PendingAddAccount | null>(null)
  const [redirect, setRedirect] = useState("")
  const [copied, setCopied] = useState(false)

  // Auto-detect when sign-in finishes via browser redirect
  useEffect(() => {
    if (!pending?.handle) return
    const handle = pending.handle
    let cancelled = false

    const interval = setInterval(async () => {
      if (cancelled) return
      try {
        const newState = await acpAntigravityCheckPendingLogin(handle)
        if (newState && !cancelled) {
          toast.success("账号授权成功并已添加！")
          setPending(null)
          setRedirect("")
          setIsAdding(false)
          setState(newState)
        }
      } catch {
        // Ignore polling errors
      }
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [pending?.handle])

  const pendingRef = useRef<PendingAddAccount | null>(null)
  pendingRef.current = pending

  // Cancel pending login if component unmounts
  useEffect(() => {
    return () => {
      const abandoned = pendingRef.current
      pendingRef.current = null
      if (abandoned) {
        void acpAntigravityLoginCancel(abandoned.handle).catch(() => {})
      }
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await acpAntigravityListAccounts()
      setState(res)

      // Fetch active account quota first
      if (res.activeAccountId || res.accounts.length > 0) {
        const activeId = res.activeAccountId ?? res.accounts[0]?.id
        if (activeId) {
          void acpAntigravityGetQuota(activeId).then((q) => {
            setQuotas((prev) => ({ ...prev, [activeId]: q }))
          }).catch(() => {})
        }
      }
    } catch (e) {
      console.warn("Failed to load Antigravity accounts", e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  const fetchQuotaForAccount = async (account: AntigravityAccount) => {
    setBusyAction(`quota-${account.id}`)
    try {
      const q = await acpAntigravityGetQuota(account.id)
      setQuotas((prev) => ({ ...prev, [account.id]: q }))
      toast.success(`已更新 ${account.email} 的额度`)
    } catch (e) {
      toast.error(`获取额度失败: ${toErrorMessage(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleSwitch = async (accountId: string) => {
    setBusyAction(`switch-${accountId}`)
    try {
      const newState = await acpAntigravitySwitchAccount(accountId)
      setState(newState)
      toast.success("已成功切换账号")
      // Update quota for the newly active account
      void acpAntigravityGetQuota(accountId).then((q) => {
        setQuotas((prev) => ({ ...prev, [accountId]: q }))
      }).catch(() => {})
    } catch (e) {
      toast.error(`切换账号失败: ${toErrorMessage(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleDelete = async (account: AntigravityAccount) => {
    if (!confirm(`确定要移除账号 ${account.email} 吗？`)) return
    setBusyAction(`delete-${account.id}`)
    try {
      const newState = await acpAntigravityDeleteAccount(account.id)
      setState(newState)
      setQuotas((prev) => {
        const next = { ...prev }
        delete next[account.id]
        return next
      })
      toast.success(`已移除账号 ${account.email}`)
    } catch (e) {
      toast.error(`移除账号失败: ${toErrorMessage(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleStartAdd = async () => {
    setIsAdding(true)
    setBusyAction("add-start")
    setPending(null)
    setRedirect("")
    try {
      const started = await acpAntigravityAddAccountStart(method)
      if (started.alreadySignedIn) {
        // If already signed in, simply re-sync accounts
        await loadAccounts()
        toast.info("已读取到当前登录的账号")
        setIsAdding(false)
      } else {
        setPending(started)
      }
    } catch (e) {
      toast.error(`启动添加账号失败: ${toErrorMessage(e)}`)
      setIsAdding(false)
    } finally {
      setBusyAction(null)
    }
  }

  const handleFinishAdd = async () => {
    if (!pending || !redirect.trim()) return
    setBusyAction("add-finish")
    try {
      const outcome = await acpAntigravityLoginFinish(pending.handle, redirect.trim())
      if (outcome.signedIn) {
        toast.success("账号授权成功并已添加！")
        setPending(null)
        setRedirect("")
        setIsAdding(false)
        await loadAccounts()
      } else {
        toast.error(`授权未完成: ${outcome.message ?? "未知错误"}`)
        if (!outcome.retryable) {
          setPending(null)
          setIsAdding(false)
        }
      }
    } catch (e) {
      toast.error(`完成授权失败: ${toErrorMessage(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleCancelAdd = async () => {
    if (pending) {
      const handle = pending.handle
      setPending(null)
      await acpAntigravityLoginCancel(handle).catch(() => {})
    }
    setRedirect("")
    setIsAdding(false)
    await loadAccounts()
  }

  const copyLink = async () => {
    if (!pending?.authUrl) return
    if (await copyTextToClipboard(pending.authUrl)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const accounts = state?.accounts ?? []

  return (
    <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">多账号管理</span>
          <span className="text-3xs text-muted-foreground">
            ({accounts.length} 个账号)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => void loadAccounts()}
            disabled={loading}
            title="刷新账号列表"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {!isAdding ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-3xs gap-1"
              disabled={disabled || busyAction !== null}
              onClick={() => void handleStartAdd()}
            >
              <UserPlus className="size-3" />
              <span>添加账号</span>
            </Button>
          ) : null}
        </div>
      </div>

      <p className="text-3xs text-muted-foreground">
        支持同时储存多个 Google 账号。额度用尽时可一键切换，系统自动维持授权无感轮换。
      </p>

      {/* Account List */}
      <div className="space-y-1.5">
        {accounts.length === 0 && !loading && (
          <div className="rounded border border-dashed p-3 text-center text-3xs text-muted-foreground">
            暂无已保存的 Antigravity 账号，请点击下方登录或添加账号。
          </div>
        )}

        {accounts.map((acc) => {
          const quota = quotas[acc.id]
          const isAct = acc.isActive || state?.activeAccountId === acc.id
          const fiveH = quota?.fiveHourFraction != null ? Math.round(quota.fiveHourFraction * 100) : null
          const week = quota?.weeklyFraction != null ? Math.round(quota.weeklyFraction * 100) : null

          return (
            <div
              key={acc.id}
              className={`rounded-md border p-2 flex flex-col gap-1.5 transition-colors ${
                isAct
                  ? "border-primary/50 bg-primary/5 dark:bg-primary/10"
                  : "border-border/70 hover:border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {acc.picture ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={acc.picture}
                      alt="avatar"
                      className="size-6 rounded-full shrink-0"
                    />
                  ) : (
                    <div className="size-6 rounded-full bg-muted flex items-center justify-center shrink-0 text-3xs font-semibold">
                      {(acc.email || "A")[0].toUpperCase()}
                    </div>
                  )}

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-xs truncate" title={acc.email}>
                        {acc.email}
                      </span>
                      {isAct ? (
                        <Badge variant="default" className="h-4 px-1 text-3xs font-normal">
                          <CheckCircle2 className="size-2.5 mr-0.5" />
                          当前使用
                        </Badge>
                      ) : null}
                    </div>
                    {acc.name ? (
                      <p className="text-3xs text-muted-foreground truncate">{acc.name}</p>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {!isAct ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-3xs"
                      disabled={busyAction !== null}
                      onClick={() => void handleSwitch(acc.id)}
                    >
                      {busyAction === `switch-${acc.id}` ? (
                        <Loader2 className="size-3 animate-spin mr-1" />
                      ) : null}
                      切换
                    </Button>
                  ) : null}

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    disabled={busyAction !== null}
                    onClick={() => void fetchQuotaForAccount(acc)}
                    title="刷新此账号额度"
                  >
                    <RefreshCw
                      className={`size-3 ${busyAction === `quota-${acc.id}` ? "animate-spin" : ""}`}
                    />
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    disabled={busyAction !== null}
                    onClick={() => void handleDelete(acc)}
                    title="移除账号"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>

              {/* Quota snippet */}
              <div className="flex items-center justify-between text-3xs text-muted-foreground bg-background/50 rounded px-1.5 py-1">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Clock className="size-2.5 text-muted-foreground" />
                    <span>5h:</span>
                    <span className={fiveH != null && fiveH <= 20 ? "text-rose-500 font-semibold" : "text-foreground font-medium"}>
                      {fiveH != null ? `${fiveH}%` : "-"}
                    </span>
                    {quota?.fiveHourResetTime && (
                      <span className="opacity-70">({formatCountdown(quota.fiveHourResetTime)})</span>
                    )}
                  </span>

                  <span className="flex items-center gap-1">
                    <Sparkles className="size-2.5 text-muted-foreground" />
                    <span>周:</span>
                    <span className={week != null && week <= 20 ? "text-rose-500 font-semibold" : "text-foreground font-medium"}>
                      {week != null ? `${week}%` : "-"}
                    </span>
                    {quota?.weeklyResetTime && (
                      <span className="opacity-70">({formatCountdown(quota.weeklyResetTime)})</span>
                    )}
                  </span>
                </div>

                {quota?.error ? (
                  <span className="text-rose-500 flex items-center gap-0.5" title={quota.error}>
                    <AlertCircle className="size-2.5" />
                    额度异常
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {/* Add Account Inline Form */}
      {isAdding ? (
        <div className="mt-2 space-y-2 rounded-md border border-dashed border-primary/40 bg-primary/5 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-medium text-primary">添加新 Google 账号</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-3xs text-muted-foreground"
              onClick={() => void handleCancelAdd()}
            >
              取消
            </Button>
          </div>

          {busyAction === "add-start" ? (
            <div className="flex items-center gap-2 py-3 justify-center text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>正在启动 Google 授权流程...</span>
            </div>
          ) : pending ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <p className="text-3xs text-muted-foreground">
                  第 1 步：在浏览器中打开授权链接，登录并选择新的 Google 账号：
                </p>
                <div className="flex items-start gap-1.5">
                  <code className="block flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
                    {pending.authUrl}
                  </code>
                  <Button
                    className="h-7 w-7 shrink-0"
                    onClick={() => void copyLink()}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  </Button>
                  <BrowserLink href={pending.authUrl}>
                    <Button className="h-7 w-7 shrink-0" size="icon" type="button" variant="outline">
                      <ExternalLink className="size-3" />
                    </Button>
                  </BrowserLink>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-3xs text-muted-foreground">
                    第 2 步：完成授权（系统将自动检测，若未自动完成可手动粘贴地址）：
                  </p>
                  <span className="flex items-center gap-1 text-3xs text-primary/80">
                    <Loader2 className="size-2.5 animate-spin" />
                    <span>等待浏览器授权中...</span>
                  </span>
                </div>
                <Input
                  className="h-7 text-xs font-mono"
                  disabled={busyAction === "add-finish"}
                  onChange={(e) => setRedirect(e.target.value)}
                  placeholder="http://localhost:port/?state=...&code=..."
                  value={redirect}
                />
              </div>

              <div className="flex items-center justify-end gap-1.5 pt-1">
                <Button
                  className="h-7 px-2.5 text-xs"
                  disabled={busyAction === "add-finish"}
                  onClick={() => void handleCancelAdd()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  取消
                </Button>
                <Button
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  disabled={busyAction === "add-finish" || !redirect.trim()}
                  onClick={() => void handleFinishAdd()}
                  size="sm"
                  type="button"
                >
                  {busyAction === "add-finish" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  完成添加
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

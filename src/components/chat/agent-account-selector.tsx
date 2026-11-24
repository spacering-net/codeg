"use client"

import { useTranslations } from "next-intl"
import { Plus, Settings2, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentAccount } from "@/lib/agent-accounts"

export function AgentAccountSelector(
  props: Parameters<typeof AccountChoices>[0]
) {
  const t = useTranslations("AgentAccounts")
  const empty = !props.accounts.some((a) => !a.removed)
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <AccountChoices {...props} />
      {props.onManage && (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs max-sm:min-h-11"
          onClick={props.onManage}
          disabled={props.switching}
        >
          {empty ? (
            <Plus className="size-3.5" />
          ) : (
            <Settings2 className="size-3.5" />
          )}
          {empty ? t("add") : t("manage")}
        </Button>
      )}
    </div>
  )
}

function AccountChoices({
  accounts,
  value,
  onChange,
  disabled = false,
  persisted = false,
  canSwitch = false,
  nativeSwitch = true,
  switching = false,
  remoteControlActive = false,
  loading = false,
  loadError = false,
  onRetry,
}: {
  accounts: AgentAccount[]
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  persisted?: boolean
  canSwitch?: boolean
  nativeSwitch?: boolean
  switching?: boolean
  remoteControlActive?: boolean
  loading?: boolean
  loadError?: boolean
  onRetry?: () => void
  onManage?: () => void
}) {
  const t = useTranslations("AgentAccounts")
  const available = accounts.filter((account) => !account.removed)
  if (!value && available.length === 0) return null
  const selected = accounts.find((a) => a.id === value)
  if (value && !selected && (loading || loadError)) {
    return (
      <div
        className="flex min-h-8 items-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <UserRound className="size-3.5 shrink-0" aria-hidden />
        <span>{loading ? t("loading") : t("loadFailed")}</span>
        {loadError && onRetry && (
          <button
            type="button"
            className="min-h-8 underline underline-offset-2"
            onClick={onRetry}
          >
            {t("retry")}
          </button>
        )}
      </div>
    )
  }
  if (persisted && !canSwitch) {
    const label = value ? (selected?.name ?? t("unavailable")) : t("default")
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground"
        title={label}
      >
        <UserRound className="size-3.5 shrink-0" />
        <span className="truncate">
          {label}
          {selected?.removed ? ` (${t("unavailable")})` : ""}
        </span>
      </span>
    )
  }
  return (
    <Select
      value={value ?? "default"}
      onValueChange={(id) => {
        const next = id === "default" ? null : id
        if (next !== value) onChange(next)
      }}
      disabled={disabled || switching || remoteControlActive}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-auto min-w-28 max-w-full max-sm:min-h-11"
        aria-label={persisted ? t("switchAccount") : t("account")}
        aria-busy={switching}
        aria-description={
          remoteControlActive
            ? t("remoteControlHint")
            : (selected?.name ?? t("default"))
        }
        title={
          remoteControlActive
            ? t("remoteControlHint")
            : persisted
              ? t(nativeSwitch ? "switchHint" : "portableSwitchHint")
              : undefined
        }
      >
        <UserRound className="size-3.5 shrink-0" />
        {switching ? t("switching") : <SelectValue />}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t("default")}</SelectItem>
        {value && (!selected || selected.removed) && (
          <SelectItem value={value} disabled>
            {t("unavailable")}
          </SelectItem>
        )}
        {available.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

"use client"

import { useTranslations } from "next-intl"
import { UserRound } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentAccount } from "@/lib/agent-accounts"

export function AgentAccountSelector({
  accounts,
  value,
  onChange,
  disabled = false,
  persisted = false,
  canSwitch = false,
  switching = false,
  remoteControlActive = false,
}: {
  accounts: AgentAccount[]
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  persisted?: boolean
  canSwitch?: boolean
  switching?: boolean
  remoteControlActive?: boolean
}) {
  const t = useTranslations("AgentAccounts")
  const available = accounts.filter((account) => !account.removed)
  if (!value && available.length === 0) return null
  const selected = accounts.find((a) => a.id === value)
  if (persisted && !canSwitch) {
    if (!value) return null
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground"
        title={selected?.name ?? t("unavailable")}
      >
        <UserRound className="size-3.5 shrink-0" />
        <span className="truncate">
          {selected?.name ?? t("unavailable")}
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
        className="h-8 w-auto min-w-28 max-w-full"
        aria-label={persisted ? t("switchAccount") : t("account")}
        aria-busy={switching}
        aria-description={
          remoteControlActive ? t("remoteControlHint") : undefined
        }
        title={
          remoteControlActive
            ? t("remoteControlHint")
            : persisted
              ? t("switchHint")
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

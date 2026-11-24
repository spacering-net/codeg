"use client"

import { useTranslations } from "next-intl"
import { Gauge } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  useSubscriptionQuota,
  type QuotaRequest,
} from "@/hooks/use-subscription-quota"
import { familyFromAgentType } from "@/lib/subscription-quota"
import { QuotaDetails, quotaRow } from "@/components/token-usage/quota-details"

export function SessionQuotaChip(props: QuotaRequest) {
  if (
    !familyFromAgentType(props.agentType) &&
    !props.agentType.startsWith("custom:")
  )
    return null
  return <QuotaChip {...props} />
}

function QuotaChip(props: QuotaRequest) {
  const t = useTranslations("TokenUsage")
  const accounts = useTranslations("AgentAccounts")
  const { data, loading, refresh } = useSubscriptionQuota(props)
  const row = quotaRow(data)
  const family = data?.family ?? familyFromAgentType(props.agentType)
  // Custom agents only advertise usage once their saved configuration resolves
  // to a supported family. An arbitrary ACP agent need not have a quota API.
  if (!family) return null
  const remainingLabel =
    row?.kind === "remaining-subscription" && row.hasModelLimits
      ? t("quotaModelLimits")
      : row?.kind === "remaining-subscription" &&
          !(row.remaining === 0 && row.hasOtherCapacity)
        ? t("quotaRemaining", {
            remaining: Math.round(row.remaining),
            limit: 100,
          })
        : loading
          ? t("quotaLoading")
          : t("quotaUnavailable")
  const label =
    family === "opencode" ? `${remainingLabel} · Go` : remainingLabel
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 max-w-32 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground"
          aria-label={label}
          title={label}
        >
          <Gauge className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate tabular-nums">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)] space-y-3 p-3"
      >
        <div>
          <p className="text-sm font-semibold">{t("quotaTitle")}</p>
          {data && (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {data.name ?? accounts("default")}
            </p>
          )}
        </div>
        <QuotaDetails
          data={data}
          family={family}
          loading={loading}
          refresh={refresh}
        />
      </PopoverContent>
    </Popover>
  )
}

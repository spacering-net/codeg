"use client"

import { RefreshCw } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  HARNESS_UPDATES,
  checkHarnessUpdates,
  type HarnessCheckError,
  type HarnessUpdateItem,
} from "@/lib/harness/updates"
import { cn } from "@/lib/utils"

function reasonKey(error: HarnessCheckError) {
  switch (error.code) {
    case "network":
      return "network"
    case "rate_limited":
      return "rateLimited"
    case "server":
      return "server"
    default:
      return "other"
  }
}

/**
 * When the host last checked an installed Harness item for updates, what
 * came of the last try, and "Check now". Shown in the Harness part of an
 * MCP server's or a skill's detail.
 *
 * A failed check keeps the states the last good one gave; this line says so,
 * and from when they are. Nothing at all where the catalog is switched off,
 * or before the host has answered (an older Codeg has no update check).
 */
export function HarnessUpdateStatus({
  itemId,
  inline = false,
  className,
}: {
  /** The item the detail is of: its own "not checked yet" is said too. */
  itemId?: string
  /** One line in a card's footer: "Check now" a link after the words. */
  inline?: boolean
  className?: string
}) {
  const t = useTranslations("Harness.updateCheck")
  const format = useFormatter()
  const { slots } = useHarnessView()
  const [state] = useHarnessSlot(HARNESS_UPDATES)
  const value = state.value
  if (!value?.enabled) return null

  // The host's own check (the daily one) is said, but holds nothing back:
  // "Check now" during it waits for it and answers with its result.
  const checking = state.checking || value.checking
  const item: HarnessUpdateItem | undefined = itemId
    ? value.items.find((entry) => entry.id === itemId)
    : undefined
  const when = (at: string) => {
    const date = new Date(at)
    return Number.isFinite(date.getTime())
      ? format.relativeTime(date, new Date())
      : at
  }

  const lines: string[] = []
  if (checking) {
    lines.push(t("checking"))
  } else if (value.error) {
    lines.push(
      t("failed", {
        reason: t(`reasons.${reasonKey(value.error)}`, {
          status: String(value.error.status ?? ""),
        }),
      })
    )
    lines.push(
      value.checked_at
        ? t("shownFrom", { time: when(value.checked_at) })
        : t("never")
    )
  } else {
    lines.push(
      value.checked_at
        ? t("checked", { time: when(value.checked_at) })
        : t("never")
    )
  }
  if (!checking && item?.state === "unknown") {
    lines.push(
      item.unknown === "unavailable"
        ? t("itemUnavailable")
        : t("itemNotChecked")
    )
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        className
      )}
    >
      <p aria-live="polite" className="min-w-0 break-words">
        {lines.join(" ")}
      </p>
      <Button
        type="button"
        variant={inline ? "link" : "ghost"}
        size="sm"
        disabled={state.checking}
        onClick={() => void checkHarnessUpdates(slots, true)}
        className={cn(
          "text-xs max-md:h-9",
          inline
            ? "h-auto gap-1 p-0 text-primary hover:no-underline hover:opacity-80 [&_svg]:size-3.5"
            : "-ms-2 h-7 px-2"
        )}
      >
        {(!inline || checking) && (
          <RefreshCw
            aria-hidden="true"
            className={cn(
              checking && "animate-spin motion-reduce:animate-none"
            )}
          />
        )}
        {t("checkNow")}
      </Button>
    </div>
  )
}

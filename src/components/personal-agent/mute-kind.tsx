"use client"

/**
 * "Don't suggest these" (6.7, 10.2): on a card one of codeg's proposal
 * rules raised, and on an assistant's own suggestion, a quiet button that
 * dismisses the card and turns the whole rule off; the preferences turn it
 * on again. A card the owner's own settings raised ("confirm") has none.
 * Once pressed, the card says so, with the way back.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BellOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { str, usePageScope } from "./shared"

export function MuteKindButton({
  noticeId,
  disabled,
  onFailed,
}: {
  noticeId: number
  disabled?: boolean
  onFailed?: (error: string) => void
}) {
  const t = useTranslations("PersonalAgent.rules")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const [busy, setBusy] = useState(false)
  if (readOnly || !Number.isFinite(noticeId)) return null
  const mute = async () => {
    if (busy) return
    setBusy(true)
    try {
      await personalAgentNoticeAct(noticeId, "mute", botId)
    } catch (e) {
      onFailed?.(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      disabled={disabled || busy}
      onClick={() => void mute()}
      data-pa-mute-kind
    >
      {busy ? <SyncedSpinner small className="size-3.5" /> : null}
      {t("mute")}
    </Button>
  )
}

/** The line a card shows once its kind was muted from it. */
export function MutedNote({
  data,
  className = "mt-1.5",
}: {
  data: unknown
  /** Its room over it: none inside a card's band, which spaces its lines. */
  className?: string
}) {
  const t = useTranslations("PersonalAgent.rules")
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const fields =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null
  if (!str(fields, "muted")) return null
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground",
        className
      )}
      data-pa-muted
    >
      <BellOff className="size-3 shrink-0" aria-hidden />
      <span>{t("muted")}</span>
      <button
        type="button"
        className="underline-offset-2 hover:underline"
        onClick={() => openSettings("proactive")}
      >
        {t("mutedRestore")}
      </button>
    </p>
  )
}

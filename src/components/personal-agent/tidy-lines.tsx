"use client"

/**
 * Last night's tidy-ups under the morning brief (7.7): a line for each
 * assistant that tidied its memory — what it did, [View] (its card, in its
 * conversation) and [Undo all]; a draft, [Apply] and [Not this one]. Each
 * line reads its card as it stands now, so what was answered there, or
 * here, says so.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { personalAgentNoticeAct, personalAgentTimelineRows } from "@/lib/api"
import type { TimelineRow, TodayRow } from "@/lib/types"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import { memoryFilesOf, useMemorySummary } from "./memory-card"
import { str, useBotName, usePageScope } from "./shared"

/** The tidy-up rows of a brief: those of kind `tidy`. */
export function tidyRowsOf(v: unknown): TodayRow[] {
  return Array.isArray(v)
    ? v.filter(
        (r): r is TodayRow =>
          r != null &&
          typeof r === "object" &&
          (r as TodayRow).kind === "tidy" &&
          typeof (r as TodayRow).key === "string"
      )
    : []
}

export function TidyLines({ rows }: { rows: TodayRow[] }) {
  const t = useTranslations("PersonalAgent.tidy")
  if (rows.length === 0) return null
  return (
    <section data-pa-brief-tidied className="flex flex-col gap-1.5">
      <h4 className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
        <Sparkles className="size-3 shrink-0" aria-hidden />
        {t("lines")}
      </h4>
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <TidyLine key={r.key} row={r} />
        ))}
      </div>
    </section>
  )
}

function TidyLine({ row }: { row: TodayRow }) {
  const t = useTranslations("PersonalAgent.tidy")
  const tm = useTranslations("PersonalAgent.memory")
  const tn = useTranslations("PersonalAgent.notice")
  const summarize = useMemorySummary()
  const { readOnly } = usePageScope()
  const entries = useRoster()
  const botName = useBotName()
  const [card, setCard] = useState<TimelineRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The card as it stands now: it may have been answered in its own
  // conversation.
  useEffect(() => {
    if (row.row_id == null) return
    let gone = false
    personalAgentTimelineRows([row.row_id], row.bot_id)
      .then((rows) => {
        if (!gone && rows[0]) setCard(rows[0])
      })
      .catch(() => {})
    return () => {
      gone = true
    }
  }, [row.row_id, row.bot_id])
  const entry =
    row.bot_id != null ? entries?.find((e) => e.id === row.bot_id) : undefined
  const name = botName(entry ?? { id: row.bot_id ?? 0, kind: "worker" })
  const state = (card ? str(card.data, "state") : null) ?? row.state ?? "acted"
  // What it did, in the owner's words — once its card is read.
  const text = card
    ? summarize(memoryFilesOf(card.data?.files)).join(tm("sep"))
    : "…"
  const act = async (action: "undo" | "apply" | "dismiss") => {
    if (row.notice_id == null || busy) return
    setBusy(true)
    setFailed(null)
    try {
      setCard(await personalAgentNoticeAct(row.notice_id, action, row.bot_id))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const view = () => {
    if (row.bot_id == null) return
    const ui = usePersonalAgentUi.getState()
    ui.setViewBot(entry?.kind === "primary" ? null : row.bot_id)
    ui.closeSettings()
    ui.setPendingJump(
      row.row_id != null ? { bot: row.bot_id, row: row.row_id } : null
    )
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-foreground/10 bg-card px-2.5 py-2"
      data-pa-tidy-line={state}
      data-key={row.key}
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatar
          avatar={entry?.avatar}
          name={name}
          size={18}
          star={entry?.kind === "primary"}
        />
        <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug break-words">
          {t(`line.${state === "draft" ? "draft" : "done"}` as "line.done", {
            name,
            text,
          })}
        </span>
      </div>
      {state !== "acted" && state !== "draft" ? (
        <p className="ps-[1.625rem] text-[0.6875rem] text-muted-foreground">
          {t(`state.${state}` as "state.undone")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 ps-[1.625rem]">
        <Button
          size="xs"
          variant="ghost"
          onClick={view}
          data-pa-tidy-line-act="view"
        >
          {t("view")}
        </Button>
        {!readOnly && (state === "acted" || state === "applied") ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void act("undo")}
            data-pa-tidy-line-act="undo"
          >
            {busy ? <SyncedSpinner small className="size-3" /> : null}
            {t("undoAll")}
          </Button>
        ) : null}
        {!readOnly && state === "draft" ? (
          <>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void act("apply")}
              data-pa-tidy-line-act="apply"
            >
              {busy ? <SyncedSpinner small className="size-3" /> : null}
              {t("apply")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("dismiss")}
              data-pa-tidy-line-act="dismiss"
            >
              {t("dismiss")}
            </Button>
          </>
        ) : null}
      </div>
      {failed ? (
        <p
          role="alert"
          className="ps-[1.625rem] text-xs break-words text-destructive"
        >
          {tn("failed", { error: failed })}
        </p>
      ) : null}
    </div>
  )
}

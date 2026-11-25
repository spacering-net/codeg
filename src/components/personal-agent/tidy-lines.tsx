"use client"

/**
 * Last night's tidy-ups under the morning brief (7.7): a row for each
 * assistant that tidied its memory, as the brief's lists are drawn
 * (`list-row`) — its face, who tidied over what it did, [View] (its card,
 * in its conversation) and [Undo all]; a draft, [Apply] and [Not this
 * one]. Each row reads its card as it stands now, so what was answered
 * there, or here, says so. Under an assistant's brief they are a card of
 * their own, as its brief is; on the brief codeg writes, a part of it.
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
import { cn } from "@/lib/utils"

import { BotAvatar } from "./bot-avatar"
import { LIST_ROW, ROW_ACTIONS, ROW_BODY, ROW_MAIN, RowLines } from "./list-row"
import { memoryFilesOf, useMemorySummary } from "./memory-card"
import { CARD_TITLE_BAND, str, useBotName, usePageScope } from "./shared"

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

export function TidyLines({
  rows,
  framed = false,
}: {
  rows: TodayRow[]
  /** A card of their own (under an assistant's brief), not a part of one. */
  framed?: boolean
}) {
  const t = useTranslations("PersonalAgent.tidy")
  if (rows.length === 0) return null
  return (
    <section
      data-pa-brief-tidied
      // A card of its own: its buttons their own colours, as a card's are.
      data-pa-surface={framed ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-col",
        // On a card of their own: its title a band across it, as an
        // assistant's card's is; the band's hairline and the card's edge
        // close the rows — none of their own over the first or under the
        // last.
        framed
          ? "overflow-hidden rounded-xl border bg-card text-card-foreground [&_[data-pa-tidy-line]:first-child]:border-t-0 [&_[data-pa-tidy-line]:last-child]:border-b-0"
          : "gap-2"
      )}
    >
      <h4
        className={
          framed
            ? CARD_TITLE_BAND
            : "flex items-center gap-1.5 text-sm leading-5 font-semibold"
        }
      >
        <Sparkles
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        {t("lines")}
      </h4>
      <div className={cn("flex min-w-0 flex-col", framed && "px-4")}>
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
    ui.showConversation()
    ui.setPendingJump(
      row.row_id != null ? { bot: row.bot_id, row: row.row_id } : null
    )
  }
  const draft = state === "draft"
  return (
    <div className={LIST_ROW} data-pa-tidy-line={state} data-key={row.key}>
      <BotAvatar
        avatar={entry?.avatar}
        name={name}
        size={32}
        star={entry?.kind === "primary"}
      />
      <div className={ROW_MAIN}>
        <div className={ROW_BODY}>
          <RowLines
            head={t(`line.${draft ? "draft" : "done"}` as "line.done", {
              name,
            })}
            text={text}
          />
          {state !== "acted" && !draft ? (
            <p className="text-xs leading-4 text-muted-foreground">
              {t(`state.${state}` as "state.undone")}
            </p>
          ) : null}
          {failed ? (
            <p
              role="alert"
              className="text-xs leading-4 break-words text-destructive"
            >
              {tn("failed", { error: failed })}
            </p>
          ) : null}
        </div>
        <div className={ROW_ACTIONS}>
          <Button
            size="sm"
            variant="secondary"
            onClick={view}
            data-pa-tidy-line-act="view"
          >
            {t("view")}
          </Button>
          {!readOnly && (state === "acted" || state === "applied") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act("undo")}
              data-pa-tidy-line-act="undo"
            >
              {busy ? <SyncedSpinner small /> : null}
              {t("undoAll")}
            </Button>
          ) : null}
          {!readOnly && draft ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act("apply")}
                data-pa-tidy-line-act="apply"
              >
                {busy ? <SyncedSpinner small /> : null}
                {t("apply")}
              </Button>
              <Button
                size="sm"
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
      </div>
    </div>
  )
}

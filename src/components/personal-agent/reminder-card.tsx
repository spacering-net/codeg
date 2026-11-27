"use client"

/**
 * A reminder that came due (6.1): a native card codeg writes itself, with
 * no model in between, so what the owner presses is what happens.
 *
 * - **notify**: the matter, when it was due, how it comes back when it
 *   repeats, how late the card came (codeg was asleep or closed) and how
 *   many times of a repeating one were skipped rather than sent one by one.
 *   [Done] closes it — a repeating one is scheduled again; [In 15 min],
 *   [In 1 hour], [Tomorrow morning] put it off; [Hand to the assistant]
 *   says so to the assistant as the owner's message quoting the card.
 * - **act**: the assistant was woken to do it — one line, no buttons.
 *
 * Once answered — here, on the matters panel, or by the assistant — the
 * buttons give way to one line saying how it ended.
 */

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { AlarmClock, Bot } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import type { ItemRepeat } from "@/lib/types"
import { cn } from "@/lib/utils"

import { useActivityTranslate } from "./activity-text"
import { dueWhen, humanDuration, repeatText } from "./due-text"
import { useMatterError, useWorded } from "./matter-text"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { OutcomeLine, type OutcomeTone } from "./outcome-line"
import {
  CardMessage,
  num,
  SHEET_TITLE,
  SheetActions,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** A card that came this late came late: codeg was not running then. */
const LATE_SECS = 120

const SNOOZES = [
  { action: "snooze:15m", label: "snooze15m", attr: "snooze-15m" },
  { action: "snooze:1h", label: "snooze1h", attr: "snooze-1h" },
  {
    action: "snooze:tomorrow",
    label: "snoozeTomorrow",
    attr: "snooze-tomorrow",
  },
] as const

function repeatOf(v: unknown): ItemRepeat | null {
  if (!v || typeof v !== "object") return null
  const r = v as Partial<ItemRepeat>
  return typeof r.every === "string" && typeof r.at === "string"
    ? (r as ItemRepeat)
    : null
}

export function ReminderCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.reminder")
  const tn = useTranslations("PersonalAgent.notice")
  const tw = useActivityTranslate()
  const worded = useWorded()
  const errorText = useMatterError()
  const locale = useLocale()
  const botId = useBotId()
  const { readOnly, agentName } = usePageScope()
  const row = item.row
  const data = row.data
  const noticeId = Number(row.ref_id)
  const state = str(data, "state") ?? "open"
  const act = str(data, "at_due") === "act"
  const summary = str(data, "summary") ?? ""
  const dueAt = str(data, "due_at")
  const late = num(data, "late_secs") ?? 0
  const missed = num(data, "missed") ?? 0
  const repeat = repeatOf(data?.repeat)
  const until = str(data, "until")
  // What went wrong last time, in the owner's language when the card keeps
  // the words' key (an older card has only codeg's English).
  const errorKey = str(data, "error_key")
  const errorParams =
    data?.error_params && typeof data.error_params === "object"
      ? (data.error_params as Record<string, string>)
      : undefined
  const error =
    (errorKey ? worded(errorKey, errorParams) : null) ?? str(data, "error")
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The time the words are about; a card's own time does not move.
  const [now] = useState(() => Date.now())

  const answer = async (action: NoticeAction, text?: string) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(action)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, action, botId, text)
    } catch (e) {
      setFailed(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const head = [
    t("title"),
    dueAt ? dueWhen(tw, dueAt, now, locale) : null,
    repeat ? repeatText(tw, repeat, now, locale) : null,
    late >= LATE_SECS
      ? tw("due.late", { duration: humanDuration(tw, late) })
      : null,
    missed > 0 ? tw("due.missed", { count: missed }) : null,
  ].filter((p): p is string => !!p)

  const ended =
    act || state === "woke"
      ? t("state.woke")
      : state === "done"
        ? t("state.done")
        : state === "snoozed"
          ? t("state.snoozed", {
              when: until ? dueWhen(tw, until, now, locale) : "",
            })
          : state === "handed"
            ? t("state.handed")
            : state === "dropped"
              ? t("state.dropped")
              : state === "expired"
                ? t("state.expired")
                : state === "closed"
                  ? t("state.closed")
                  : null
  // How it ended, on its tone: done, handed on or woken through; put off
  // later; let go or past quiet.
  const endedTone: OutcomeTone =
    act || state === "woke"
      ? "info"
      : state === "snoozed"
        ? "later"
        : state === "dropped" || state === "expired"
          ? "off"
          : "done"
  const open = !act && state === "open"
  const shownError = failed ?? (open ? error : null)
  const disabled = readOnly || busy != null
  const spin = (a: NoticeAction) =>
    busy === a ? <SyncedSpinner small className="size-3.5" /> : null

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: summary, at: row.created_at }}
    >
      <CardMessage
        data-pa-notice={state}
        data-pa-reminder={act ? "act" : "notify"}
        head={
          <>
            <AlarmClock aria-hidden />
            {head.map((part, i) => (
              <span
                key={i}
                className={cn(
                  i === 0 && "font-medium",
                  i > 0 && "before:me-1.5 before:content-['·']"
                )}
              >
                {part}
              </span>
            ))}
          </>
        }
      >
        {/* What it is about, and how it ended. */}
        <SheetPart className="flex flex-col gap-1.5">
          <p className={cn(SHEET_TITLE, "whitespace-pre-wrap")}>{summary}</p>
          {!open && ended ? (
            <OutcomeLine
              tone={endedTone}
              icon={act || state === "woke" ? Bot : undefined}
              data-pa-reminder-state={act ? "woke" : state}
            >
              {ended}
            </OutcomeLine>
          ) : null}
        </SheetPart>
        {open ? (
          <SheetActions>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => void answer("done")}
              data-pa-reminder-act="done"
            >
              {spin("done")}
              {t("done")}
            </Button>
            {SNOOZES.map((s) => (
              <Button
                key={s.action}
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => void answer(s.action)}
                data-pa-reminder-act={s.attr}
              >
                {spin(s.action)}
                {t(s.label)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                void answer("hand_over", t("handOverText", { summary }))
              }
              data-pa-reminder-act="hand-over"
            >
              {spin("hand_over")}
              {t("handOver", { name: agentName })}
            </Button>
          </SheetActions>
        ) : null}
        {shownError ? (
          <SheetNote>
            <p role="alert" className="break-words text-destructive">
              {tn("failed", { error: shownError })}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

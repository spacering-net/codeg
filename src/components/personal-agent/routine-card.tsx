"use client"

/**
 * A routine's card (6.9), codeg's own:
 * - made or changed as the owner said: what it is now, [Undo] [Edit];
 * - suggested by the assistant: in full, [Make it] / [Do it] and [Not now];
 * - an offer to make a request the owner keeps making a routine: [Make it a
 *   routine] opens the editor prefilled, [Not now];
 * - paused by codeg (three failed runs, or nothing set for its work to run
 *   on): why, [Set it] for the latter, [Resume], and [Open routines].
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Clock3,
  Play,
  Repeat,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import type { RoutineDraft, RoutineEventSpec, RoutineKind } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { MutedNote, MuteKindButton } from "./mute-kind"
import { OutcomeLine, type OutcomeTone } from "./outcome-line"
import { asDraft, precheckWords, RoutineWhen } from "./routine-bits"
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

type What = "made" | "changed" | "proposal" | "repeat" | "paused"
const WHATS: readonly What[] = [
  "made",
  "changed",
  "proposal",
  "repeat",
  "paused",
]

const ICONS: Record<What, LucideIcon> = {
  made: CalendarCheck,
  changed: CalendarClock,
  proposal: CalendarPlus,
  repeat: Repeat,
  paused: CalendarX,
}

interface Shown {
  id?: number | null
  title?: string
  what?: string
  kind?: RoutineKind
  cron?: string | null
  timezone?: string | null
  event?: RoutineEventSpec | null
  precheck?: RoutineDraft["precheck"]
}

function shownOf(v: unknown): Shown | null {
  if (!v || typeof v !== "object") return null
  return v as Shown
}

export function RoutineCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.routines.card")
  const tr = useTranslations("PersonalAgent.routines")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const showRoutines = usePersonalAgentUi((s) => s.showRoutines)
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const row = item.row
  const data = (row.data ?? {}) as Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const raw = str(data, "what")
  const what: What = (WHATS as readonly string[]).includes(raw ?? "")
    ? (raw as What)
    : "made"
  const state = str(data, "state") ?? "open"
  const draft = asDraft(data.draft)
  // What it is: the routine as it stands, or the draft it would be.
  const r =
    shownOf(data.routine) ??
    (draft
      ? {
          title: draft.title ?? "",
          what: draft.what ?? "",
          kind: draft.kind ?? "brain",
          cron: draft.cron,
          timezone: draft.timezone,
          event: draft.event,
          precheck: draft.precheck,
        }
      : null)
  const routineId = r?.id ?? num(data, "routine_id")
  const reason = str(data, "reason")
  const action = str(data, "action")
  const error = str(data, "error")
  const open = state === "open"
  const Icon = ICONS[what]

  const answer = async (a: NoticeAction) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(a)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, a, botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const spin = (a: NoticeAction) =>
    busy === a ? <SyncedSpinner small className="size-3.5" /> : null

  // Shown first because the owner asked so (13.5), not suggested.
  const confirm = data.confirm === true
  const heading =
    what === "proposal"
      ? routineId != null
        ? t(confirm ? "confirmChange" : "proposalChange")
        : t(confirm ? "confirm" : "proposal")
      : t(what)
  const stateNote = (() => {
    if (state === "undone") return t("undone")
    if (state === "dismissed") return t("dismissed")
    if (state === "resumed") return t("resumed")
    if (state === "made" && (what === "proposal" || what === "repeat"))
      return t("madeNote")
    return null
  })()
  const stateTone: OutcomeTone =
    state === "undone" ? "back" : state === "dismissed" ? "off" : "done"
  const precheck = r ? precheckWords(tr, r.precheck) : null
  const changeWord =
    what === "changed" || (what === "proposal" && routineId != null)
      ? action && action !== "edit"
        ? t(`action.${action}` as "action.pause")
        : t("action.edit")
      : null
  const tone =
    what === "paused"
      ? "text-amber-700 dark:text-amber-300"
      : what === "made"
        ? "text-emerald-700 dark:text-emerald-300"
        : "text-muted-foreground"
  const pausedWhy = str(data, "reason")
  // A band only for what it has to say: notes, and buttons.
  const notes =
    (r?.what && what !== "paused") ||
    what === "repeat" ||
    what === "paused" ||
    (what === "made" && num(data, "trial_run_id") != null) ||
    reason ||
    stateNote
  const acts =
    !readOnly &&
    (((what === "made" || what === "changed") && state === "made") ||
      (open && (what === "proposal" || what === "repeat" || what === "paused")))

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text: [heading, r?.title].filter(Boolean).join(" · "),
        at: row.created_at,
      }}
    >
      <CardMessage
        data-pa-routine-card={what}
        data-pa-routine-card-state={state}
        head={
          <>
            <Icon aria-hidden className={tone} />
            <span className={cn("font-medium", tone)}>{heading}</span>
            {changeWord ? <span>· {changeWord}</span> : null}
          </>
        }
      >
        {/* The routine: what it is called, and when it runs. */}
        {r ? (
          <SheetPart className="flex flex-col gap-1">
            <p className={SHEET_TITLE} data-pa-routine-title>
              {r.title}
            </p>
            <p className="flex min-w-0 items-start gap-1.5 text-xs leading-5 break-words text-muted-foreground">
              <Clock3
                className="mt-[0.1875rem] size-3.5 shrink-0"
                aria-hidden
              />
              <span className="min-w-0">
                <RoutineWhen cron={r.cron} event={r.event} zone={r.timezone} />
                {r.kind ? ` · ${tr(`kind.${r.kind}` as "kind.brain")}` : null}
                {precheck ? ` · ${precheck}` : null}
              </span>
            </p>
          </SheetPart>
        ) : null}
        {/* What it does, and what this news says of it. */}
        {notes ? (
          <SheetPart className="flex flex-col gap-2">
            {r?.what && what !== "paused" ? (
              <p className="line-clamp-4 border-s-2 border-border ps-3 text-sm leading-5 break-words whitespace-pre-wrap text-foreground/90">
                {r.what}
              </p>
            ) : null}
            {what === "repeat" ? (
              <p
                className="text-xs text-muted-foreground"
                data-pa-routine-repeat
              >
                {t("repeatBody", { count: num(data, "count") ?? 3 })}
              </p>
            ) : null}
            {what === "paused" ? (
              <OutcomeLine tone="warn">
                {pausedWhy === "work_agent"
                  ? t("pausedWorkAgent")
                  : t("pausedFailures")}
                {str(data, "why") ? ` — ${str(data, "why")}` : null}
              </OutcomeLine>
            ) : null}
            {what === "made" && num(data, "trial_run_id") != null ? (
              <OutcomeLine tone="info" icon={Play}>
                {t("trial")}
              </OutcomeLine>
            ) : null}
            {reason && what !== "paused" ? (
              <p className="text-xs break-words text-muted-foreground">
                {t("reason", { reason })}
              </p>
            ) : null}
            {stateNote ? (
              <OutcomeLine tone={stateTone} data-pa-routine-note>
                {stateNote}
              </OutcomeLine>
            ) : null}
          </SheetPart>
        ) : null}
        {acts ? (
          <SheetActions>
            {(what === "made" || what === "changed") && state === "made" ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy != null}
                  onClick={() => void answer("undo")}
                  data-pa-routine-card-act="undo"
                >
                  {spin("undo")}
                  {t("undo")}
                </Button>
                {routineId != null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      openEditor({
                        botId,
                        routineId,
                        draft: null,
                        noticeId: null,
                      })
                    }
                    data-pa-routine-card-act="edit"
                  >
                    {t("edit")}
                  </Button>
                ) : null}
              </>
            ) : null}
            {what === "proposal" && open ? (
              <>
                <Button
                  size="sm"
                  disabled={busy != null}
                  onClick={() => void answer("accept")}
                  data-pa-routine-card-act="accept"
                >
                  {spin("accept")}
                  {routineId != null ? t("acceptChange") : t("accept")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy != null}
                  onClick={() => void answer("dismiss")}
                  data-pa-routine-card-act="dismiss"
                >
                  {spin("dismiss")}
                  {t("dismiss")}
                </Button>
                {confirm ? null : (
                  <MuteKindButton noticeId={noticeId} disabled={busy != null} />
                )}
              </>
            ) : null}
            {what === "repeat" && open ? (
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    openEditor({
                      botId,
                      routineId: null,
                      draft,
                      noticeId: Number.isFinite(noticeId) ? noticeId : null,
                    })
                  }
                  data-pa-routine-card-act="make"
                >
                  {t("makeIt")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy != null}
                  onClick={() => void answer("dismiss")}
                  data-pa-routine-card-act="dismiss"
                >
                  {spin("dismiss")}
                  {t("dismiss")}
                </Button>
                <MuteKindButton noticeId={noticeId} disabled={busy != null} />
              </>
            ) : null}
            {what === "paused" && open ? (
              <>
                {pausedWhy === "work_agent" ? (
                  <Button
                    size="sm"
                    onClick={() => openBotPage("identity")}
                    data-pa-routine-card-act="work_agent"
                  >
                    {t("setWorkAgent")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={pausedWhy === "work_agent" ? "secondary" : "default"}
                  disabled={busy != null}
                  onClick={() => void answer("resume")}
                  data-pa-routine-card-act="resume"
                >
                  {spin("resume")}
                  {t("resume")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => showRoutines(routineId)}
                  data-pa-routine-card-act="open"
                >
                  {t("open")}
                </Button>
              </>
            ) : null}
          </SheetActions>
        ) : null}
        {str(data, "muted") || failed || error ? (
          <SheetNote>
            <MutedNote data={data} className="" />
            {failed || error ? (
              <p className="break-words text-destructive">{failed ?? error}</p>
            ) : null}
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

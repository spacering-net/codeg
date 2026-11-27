"use client"

/** The buttons that settle a matter on its row (C1), by whose move it is:
 *
 *  - **needs you** — the owner's: one main button (done, done for this
 *    time, answer) and the rest beside it (put off, hand to the assistant,
 *    not needed);
 *  - **under way** — someone else's: only "not needed" (a message: taken
 *    back, or no longer waited for);
 *  - **coming up** — not yet: done early or skip this time, set a time for
 *    one set aside, not needed.
 *
 *  Each says what it will do before it is pressed (its hint), and what it
 *  did after — a toast with [Undo], the panel's acts taken back within ten
 *  minutes. Handed-out work still moving settles itself. */

import { useId, useState, type ReactElement, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  Clock,
  MessageCircleQuestionMark,
  Send,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  personalAgentItemAct,
  personalAgentItemUndo,
  personalAgentNoticeAct,
} from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import type {
  ActivityRow,
  DispatchInfo,
  ItemActResult,
  ItemInfo,
} from "@/lib/types"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import {
  usePersonalAgentUi,
  type ActivityGroup,
} from "@/stores/personal-agent-ui-store"

import {
  messageText,
  peerName,
  useMatterError,
  useWhenInSentence,
} from "../../matter-text"
import { useActivityTranslate } from "../../activity-text"
import { repeatText } from "../../due-text"
import { useBotName } from "../../shared"
import { MOVING } from "../use-work"
import { useActSettle, waitForSettle } from "./act-settle"

const SNOOZES = [
  { until: "15m", label: "in15m" },
  { until: "1h", label: "in1h" },
  { until: "tomorrow", label: "tomorrow" },
] as const

type Until = (typeof SNOOZES)[number]["until"]

/** How long a toast with [Undo] stays. */
const UNDO_TOAST_MS = 8_000

/** Whether a matter has a way to settle it on its row: handed-out work
 *  still moving settles itself. */
export function hasItemActions(item: ItemInfo, dispatch: DispatchInfo | null) {
  const state = dispatch?.state ?? item.dispatch_state
  return !(item.kind === "dispatch" && state != null && MOVING.has(state))
}

/** Whether a matter's time is still ahead of now (not fired for it). */
export function timeAhead(item: ItemInfo, now: number): boolean {
  if (!item.due_at) return false
  const due = Date.parse(item.due_at)
  const fired = item.fired_at != null && Date.parse(item.fired_at) >= due - 1000
  return due > now && !fired
}

/** The name of the assistant a row is of. */
export function useRowBotName(): (bot: number | null) => string {
  const entries = useRoster()
  const botName = useBotName()
  return (bot) => {
    if (bot == null) return ""
    const entry = entries?.find((e) => e.id === bot)
    return botName(entry ?? { id: bot, kind: "worker" })
  }
}

/** A matter's title as the owner reads it: a message's, what was written. */
export function matterTitleOf(item: ItemInfo): string {
  return item.kind === "message" ? messageText(item) : item.summary
}

/** Its assistant's conversation, the row shown there. */
function useShowConversation(): (
  bot: number,
  rowId: number | null,
  inDrawer: boolean
) => void {
  const entries = useRoster()
  return (bot, rowId, inDrawer) => {
    const primary = entries?.find((e) => e.id === bot)?.kind === "primary"
    const ui = usePersonalAgentUi.getState()
    ui.setViewBot(primary ? null : bot)
    ui.showConversation()
    if (rowId != null) ui.setPendingJump({ bot, row: rowId })
    if (inDrawer) ui.setAuxOpen(false)
  }
}

/** A refusal because the matter was written since the button read it:
 *  the activity is read again, so the next press acts on it as it is. */
export function refreshIfChanged(e: unknown) {
  const key = extractAppCommandError(e)?.i18n_key
  if (
    key === "matterErrors.changed" ||
    key === "matterErrors.reminderAnswered"
  ) {
    refreshActivity()
  }
}

/** The undo tokens being taken back: an [Undo] pressed again — on the row,
 *  or on the toast that carries the same token — while one is under way
 *  does nothing. */
const undoing = new Set<number>()

/** Take back an act from the panel (`undo`, its token): what the owner is
 *  told either way, and the matter as the undo left it (`null`: not taken
 *  back). */
export function useUndoMatter(): (
  bot: number | null,
  itemId: number,
  undo: number,
  /** What to say once it is taken back (a generic "Undone" else). */
  said?: string
) => Promise<ItemInfo | null> {
  const t = useTranslations("PersonalAgent.matter.toast")
  const errorText = useMatterError()
  return (bot, itemId, undo, said) => {
    if (undoing.has(undo)) return Promise.resolve(null)
    undoing.add(undo)
    return personalAgentItemUndo(bot, itemId, undo)
      .then((item) => {
        toast.success(said ?? t("undone"))
        refreshActivity()
        return item
      })
      .catch((e) => {
        undoing.delete(undo)
        refreshIfChanged(e)
        toast.error(errorText(e))
        return null
      })
  }
}

type Act =
  | { op: "done"; how: "done" | "doneThis" | "doneEarly" }
  | { op: "skip" }
  | { op: "done"; how: "merged" | "ack" }
  | { op: "drop"; how: "drop" | "stop" }
  | { op: "snooze"; until: Until }

export function MatterActions({
  row,
  item,
  group,
  dispatch,
  now,
  inDrawer,
}: {
  row: ActivityRow
  item: ItemInfo
  group: ActivityGroup
  dispatch: DispatchInfo | null
  now: number
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent.matter")
  const tr = useTranslations("PersonalAgent.reminder")
  const tw = useActivityTranslate()
  const locale = useLocale()
  const errorText = useMatterError()
  const when = useWhenInSentence()
  const undoMatter = useUndoMatter()
  const showConversation = useShowConversation()
  const name = useRowBotName()(row.bot_id)
  const bot = row.bot_id
  const [acting, setActing] = useState(false)
  // Done, the buttons stay off until the row as read shows it.
  const settleKey = `item:${item.id}`
  const settle = useActSettle(settleKey, item.updated_at)
  const busy = acting || settle.waiting
  const hintId = useId()
  if (!hasItemActions(item, dispatch)) return null

  const title = matterTitleOf(item)
  const peer = peerName(item)
  const repeating = item.repeat != null
  const ahead = timeAhead(item, now)
  const acts = item.at_due === "act"

  // What the act did, in the owner's words, with [Undo] when it can be.
  const tell = (act: Act, res: ItemActResult | undefined) => {
    const left = res?.item ?? item
    const ended = left.status === "done" || left.status === "dropped"
    const next = left.due_at ? when(left.due_at) : ""
    let text: string
    if (act.op === "snooze") {
      text = left.due_at
        ? acts
          ? t("toast.snoozeAct", { name, when: next })
          : t("toast.snoozeNotify", { when: next })
        : t("toast.dropped", { title })
    } else if (act.op === "drop") {
      if (item.kind === "message" && res?.withdrawn === true)
        text = t("toast.withdrawn", { peer })
      else if (item.kind === "message")
        text = t("toast.notWithdrawn", { name, peer })
      else if (act.how === "stop") text = t("toast.stopped", { title })
      else text = t("toast.dropped", { title })
    } else if (act.op === "skip") {
      text = ended ? t("toast.skipEnded") : t("toast.skipNext", { when: next })
    } else if (act.how === "doneThis") {
      text = ended ? t("toast.doneEnded") : t("toast.doneNext", { when: next })
    } else {
      text = t("toast.done", { title })
    }
    const undo = res?.undo
    const notRefreshed = t("toast.notRefreshed")
    toast.success(text, {
      duration: UNDO_TOAST_MS,
      action:
        undo != null
          ? {
              label: t("act.undo"),
              // The row may be drawn elsewhere by now (another group): it
              // waits by its key, wherever it is.
              onClick: () =>
                void undoMatter(
                  bot,
                  item.id,
                  undo,
                  act.op === "skip" ? t("toast.undoneSkip") : undefined
                ).then((back) => {
                  if (back) {
                    waitForSettle(
                      settleKey,
                      { atLeast: back.updated_at },
                      notRefreshed
                    )
                  }
                }),
            }
          : undefined,
    })
  }

  // Every act carries the version the button read: one the row's read went
  // past (a stale button) is refused, never done to the matter as it is
  // now — a repeating one's next time skipped too.
  const run = (act: Act) => {
    setActing(true)
    const call =
      act.op === "snooze"
        ? personalAgentItemAct(
            bot,
            item.id,
            "snooze",
            act.until,
            "panel",
            item.updated_at
          )
        : personalAgentItemAct(
            bot,
            item.id,
            act.op,
            undefined,
            "panel",
            item.updated_at
          )
    call
      .then((res) => {
        const wrote = res?.item?.updated_at
        if (wrote) settle.waitFor({ atLeast: wrote })
        refreshActivity()
        tell(act, res)
      })
      .catch((e) => {
        refreshIfChanged(e)
        toast.error(errorText(e))
      })
      .finally(() => setActing(false))
  }

  // [Hand to …]: the owner's message quoting the open reminder card.
  const handOver = () => {
    const notice = row.card_notice_id
    if (notice == null) return
    setActing(true)
    const seen = item.updated_at
    personalAgentNoticeAct(
      notice,
      "hand_over",
      bot,
      tr("handOverText", { summary: title }),
      seen
    )
      .then(() => {
        // Handed over writes the matter: off until the row is read past
        // the version this press saw (or it moves to "under way").
        settle.waitFor({ differs: seen })
        toast.success(t("toast.handed", { name }))
        refreshActivity()
      })
      .catch((e) => {
        refreshIfChanged(e)
        toast.error(errorText(e))
      })
      .finally(() => setActing(false))
  }

  // [Answer]: its assistant's conversation, at the reply that asked, the
  // box set to answer it.
  const answer = () => {
    if (bot == null) return
    usePersonalAgentUi
      .getState()
      .setPendingAnswer({ bot, itemId: item.id, summary: item.summary })
    showConversation(bot, item.origin_timeline_id, inDrawer)
  }

  // What a button will do, before it is pressed: a tooltip on pointer and
  // focus, and its description for a screen reader (always there, not only
  // while the tooltip shows).
  const hinted = (key: string, hint: string | null, trigger: ReactElement) =>
    hint ? (
      <TooltipProvider key={key} delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
        <span id={`${hintId}-${key}`} className="sr-only">
          {hint}
        </span>
      </TooltipProvider>
    ) : (
      trigger
    )

  const button = (
    key: string,
    label: string,
    hint: string | null,
    onClick: () => void,
    opts: {
      main?: boolean
      icon?: ReactNode
      quiet?: boolean
    } = {}
  ) =>
    hinted(
      key,
      hint,
      <Button
        key={key}
        size="sm"
        variant={opts.main ? "default" : opts.quiet ? "ghost" : "outline"}
        className={opts.quiet ? "text-muted-foreground" : undefined}
        disabled={busy}
        onClick={onClick}
        aria-describedby={hint ? `${hintId}-${key}` : undefined}
        data-pa-item-act={key}
      >
        {opts.icon}
        {label}
      </Button>
    )

  const timeMenu = (key: "snooze" | "setTime") => {
    const hint =
      key === "snooze"
        ? acts
          ? t("hint.snoozeAct", { name })
          : t("hint.snoozeNotify")
        : acts
          ? t("hint.setTimeAct", { name })
          : t("hint.setTimeNotify")
    return (
      <DropdownMenu key={key}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-describedby={`${hintId}-${key}`}
                  data-pa-item-act={`${key}-menu`}
                >
                  <Clock aria-hidden />
                  {t(`act.${key}`)}
                  <ChevronDown aria-hidden className="-ms-0.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span id={`${hintId}-${key}`} className="sr-only">
          {hint}
        </span>
        <DropdownMenuContent align="start">
          {SNOOZES.map((c) => (
            <DropdownMenuItem
              key={c.until}
              onSelect={() => run({ op: "snooze", until: c.until })}
              data-pa-item-act={`snooze-${c.until}`}
            >
              {t(`act.${c.label}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // How a repeating one goes on after this time: by its rule.
  const rule = item.repeat ? repeatText(tw, item.repeat, now, locale) : ""
  const nextHint = (doneKey: "doneNext" | "skipNext") =>
    rule ? t(`hint.${doneKey}`, { rule }) : null

  const dropButton = (how: "drop" | "stop") => {
    const hint =
      how === "stop"
        ? t("hint.stop")
        : item.kind === "message"
          ? t("hint.dropMessage", { name, peer })
          : item.kind === "question"
            ? t("hint.dropQuestion", { name })
            : t("hint.drop", { name })
    return button(how, t(`act.${how}`), hint, () => run({ op: "drop", how }), {
      quiet: true,
    })
  }

  const handOverButton =
    row.card_notice_id != null && bot != null
      ? button(
          "hand-over",
          t("act.handOver", { name }),
          t("hint.handOver", { name }),
          handOver,
          {
            icon: <Send aria-hidden />,
          }
        )
      : null

  const answerButton = (main: boolean) =>
    button("answer", t("act.answer"), t("hint.answer", { name }), answer, {
      main,
      icon: <MessageCircleQuestionMark aria-hidden />,
    })

  // Handed-out work no longer moving: closed by the owner — a pull request
  // as merged, anything else as seen.
  if (item.kind === "dispatch") {
    const state = dispatch?.state ?? item.dispatch_state
    const merged = state === "completed" && item.waits_for === "external"
    return (
      <>
        {button(
          merged ? "merged" : "ack",
          t(merged ? "act.merged" : "act.ack"),
          merged ? t("hint.merged", { name }) : t("hint.ack"),
          () => run({ op: "done", how: merged ? "merged" : "ack" }),
          { icon: <Check aria-hidden /> }
        )}
        {dropButton("drop")}
      </>
    )
  }

  if (item.kind === "when_mentioned") return dropButton("stop")

  // Someone else's move: only "not needed".
  if (group === "watching" || item.kind === "message") return dropButton("drop")

  if (group === "next") {
    if (item.kind === "question")
      return (
        <>
          {answerButton(false)}
          {dropButton("drop")}
        </>
      )
    if (repeating && item.due_at)
      return (
        <>
          {button("skip", t("act.skipThis"), nextHint("skipNext"), () =>
            run({ op: "skip" })
          )}
          {dropButton("stop")}
        </>
      )
    if (ahead)
      return (
        <>
          {button(
            "done",
            t("act.doneEarly"),
            null,
            () => run({ op: "done", how: "doneEarly" }),
            { icon: <Check aria-hidden /> }
          )}
          {dropButton("drop")}
        </>
      )
    return (
      <>
        {timeMenu("setTime")}
        {dropButton("drop")}
      </>
    )
  }

  // Needs you.
  if (item.kind === "question")
    return (
      <>
        {answerButton(true)}
        {timeMenu("snooze")}
        {dropButton("drop")}
      </>
    )
  return (
    <>
      {button(
        "done",
        t(repeating ? "act.doneThis" : "act.done"),
        repeating ? nextHint("doneNext") : null,
        () => run({ op: "done", how: repeating ? "doneThis" : "done" }),
        { main: true, icon: <Check aria-hidden /> }
      )}
      {timeMenu("snooze")}
      {handOverButton}
      {dropButton(repeating ? "stop" : "drop")}
    </>
  )
}

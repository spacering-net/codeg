"use client"

/** What a row of the activity waits on, in a word (5.2) — "no reply",
 *  "queued for Dev", "nobody's fixing it" — and what stops a row under way:
 *  its work, the board task, or the assistant's turn. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Square } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { personalAgentCancelTurn } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { ActivityRow, DispatchInfo, RowWhy } from "@/lib/types"
import { cn } from "@/lib/utils"
import { refreshActivity } from "@/stores/personal-agent-activity-store"

import { WorkStopButton } from "../../task-strip"
import { StatusPill, type PillTone } from "../kit/status-pill"
import { useRowBotName } from "./matter-actions"

const WHY_TONE: Record<RowWhy["kind"], PillTone> = {
  no_reply: "amber",
  unfinished: "amber",
  nobody_fixing: "amber",
  failed: "red",
  fix_pending: "violet",
  fixing: "violet",
  platform_blocked: "muted",
  merge_queued: "teal",
  merging: "sky",
  check_preparing: "muted",
  check_settling: "muted",
  queued: "muted",
  redelivering: "muted",
  in_turn: "sky",
  looking: "muted",
  no_trigger: "muted",
  read_failed: "red",
  checks_slow: "amber",
  review_pending: "muted",
  review_slow: "amber",
}

/** The kinds a watch's failed read is worded by; any other, `other`. */
const READ_KINDS = new Set([
  "auth",
  "no_account",
  "config",
  "network",
  "api",
  "timeout",
])

/** Why a row is where it is, in a word on its tone. */
export function WhyChip({ why }: { why: RowWhy }) {
  const t = useTranslations("PersonalAgent.feed.why")
  const nameOf = useRowBotName()
  const words = (() => {
    switch (why.kind) {
      case "no_reply":
        return t("no_reply", { name: nameOf(why.peer) })
      case "nobody_fixing":
        return t(why.cause === "conflict" ? "conflict" : "checks")
      case "queued":
      case "redelivering":
        return t("queued", { name: nameOf(why.bot) })
      case "in_turn":
      case "looking":
        return t(why.kind, { name: nameOf(why.bot) })
      case "read_failed":
        return t(
          `readFailed.${READ_KINDS.has(why.error) ? why.error : "other"}` as "readFailed.other"
        )
      case "checks_slow":
        return t("checks_slow", { hours: why.hours })
      case "review_slow":
        return t("review_slow", { days: why.days })
      default:
        return t(why.kind)
    }
  })()
  return (
    <StatusPill
      tone={WHY_TONE[why.kind]}
      pulse={why.kind === "in_turn" || why.kind === "merging"}
      data-pa-row-why={why.kind}
    >
      {words}
    </StatusPill>
  )
}

/** [Stop] on a row under way: its work's (the version the list read), the
 *  board's cancel for a task no assistant handed out, or the assistant's
 *  turn. Nothing read-only, nor when the work it names was not read. */
export function RowStopButton({
  row,
  dispatches,
  readOnly,
  cancelTask,
  className,
}: {
  row: ActivityRow
  dispatches: DispatchInfo[]
  readOnly: boolean
  /** The board's cancel for task `id` (its dialog), of run `runSeq`. */
  cancelTask: ((id: number, runSeq?: number | null) => void) | null
  className?: string
}) {
  const t = useTranslations("PersonalAgent.feed.stop")
  const nameOf = useRowBotName()
  const [stopping, setStopping] = useState(false)
  const stop = row.stop
  if (!stop || readOnly) return null
  const red =
    "text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-300"
  if (stop.kind === "dispatch") {
    const d = dispatches.find((x) => x.id === stop.id)
    return d ? (
      <WorkStopButton
        d={d}
        bot={row.bot_id}
        from="activity"
        className={className}
      />
    ) : null
  }
  if (stop.kind === "task") {
    if (!cancelTask) return null
    return (
      <Button
        size="sm"
        variant="outline"
        className={cn(red, className)}
        onClick={() => cancelTask(stop.id, stop.run_seq)}
        data-pa-row-stop="task"
      >
        <Square aria-hidden className="size-2.5 fill-current" />
        {t("task")}
      </Button>
    )
  }
  const { bot, batch } = stop
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn(red, className)}
      disabled={stopping}
      onClick={() => {
        setStopping(true)
        // That turn only: one over since, another begun, is left — the
        // list read again says where things stand.
        personalAgentCancelTurn(bot, batch)
          .then(() => refreshActivity())
          .catch((e) => toast.error(toErrorMessage(e)))
          .finally(() => setStopping(false))
      }}
      data-pa-row-stop="turn"
    >
      <Square aria-hidden className="size-2.5 fill-current" />
      {t("turn", { name: nameOf(bot) })}
    </Button>
  )
}

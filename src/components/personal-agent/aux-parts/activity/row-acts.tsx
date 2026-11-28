"use client"

/** A row's own buttons on the activity (6.5, 7.3): what moves the thing on,
 *  there — failed work tried again or handed to its assistant, its session
 *  opened; a reviewed task landed; a pull request merged or opened; a
 *  message its receiver left unanswered asked again; a reminder its
 *  assistant left unfinished handed again. A button needing an action the
 *  codeg on the other end does not have shows only when it says it does. */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { mustDeliverToPr } from "@/components/tasks/task-acceptance"
import { Button } from "@/components/ui/button"
import {
  personalAgentDispatchHand,
  personalAgentMessageNudge,
  personalAgentNoticeAct,
  personalAgentPrMerge,
  personalAgentWorkRetry,
  openSettingsWindow,
  type NoticeAction,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import type { ActivityRow, DispatchInfo } from "@/lib/types"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import {
  leaveRow,
  returnRow,
  rowsCool,
  type LeaveToken,
} from "@/stores/personal-agent-activity-leaving-store"

import { canOpenWork, useOpenWork, workTargetOf } from "../../shared"
import { refreshIfChanged, useRowBotName } from "./matter-actions"
import { answersInline, RowAskActions } from "./row-ask"
import type { RowScope } from "./work-cards"

/** The task reasons a reviewed task lands from (B2). */
const LANDS: ReadonlySet<string> = new Set([
  "review",
  "merge_ready",
  "needs_delivery",
])

/** The row's own buttons; `null` when it has none (it draws no row of
 *  them). `dispatch`: the work the row is of, as read. */
export function useRowActs(
  row: ActivityRow,
  scope: RowScope,
  dispatch: DispatchInfo | null,
  /** The group it is drawn in: what it leaves once acted on (7.4). */
  group: string
): ReactNode | null {
  const t = useTranslations("PersonalAgent.work")
  const tr = useTranslations("PersonalAgent.reminder")
  const ta = useTranslations("PersonalAgent.acceptance")
  const nameOf = useRowBotName()
  const openWork = useOpenWork()
  const [busy, setBusy] = useState(false)
  if (scope.readOnly || scope.mode !== "v2") return null
  const today = row.today
  const item = row.item
  const bot = row.bot_id
  const name = nameOf(bot)

  // Done: the list read again; refused for a change meanwhile, read again
  // too, so the next press acts on it as it is.
  // The row leaves its group at once (7.4); back if the act fails.
  const run = <T,>(
    call: Promise<T>,
    then?: (res: T, left: LeaveToken) => void
  ) => {
    setBusy(true)
    const left = leaveRow(row.key, group, scope.list)
    call
      .then((res) => {
        then?.(res, left)
        refreshActivity()
      })
      .catch((e) => {
        returnRow(left)
        refreshIfChanged(e)
        toast.error(toErrorMessage(e))
      })
      .finally(() => setBusy(false))
  }
  const button = (
    key: string,
    label: string,
    onClick: () => void,
    main = false
  ) => (
    <Button
      key={key}
      size="sm"
      variant={main ? "default" : "outline"}
      disabled={busy}
      onClick={(e) => {
        // The second click of one meant for a row that just left.
        if (!rowsCool(e.detail)) onClick()
      }}
      data-pa-row-act={key}
    >
      {label}
    </Button>
  )
  const out: ReactNode[] = []

  // What it asks, answered here (7.5).
  if (row.ask && scope.can("ask_inline") && answersInline(row.ask)) {
    // Keyed by the request: a note half-written for one never goes with
    // the next one the same session asks.
    const a = row.ask
    const request =
      a.kind === "permission"
        ? a.request_id
        : a.kind === "question"
          ? a.question_id
          : a.kind === "plan"
            ? a.approval_id
            : String(a.notice_id)
    const on = a.kind === "choice" ? "" : (a.connection_id ?? "")
    out.push(
      <RowAskActions
        key={`ask:${a.kind}:${on}:${request}`}
        ask={a}
        bot={bot}
        rowKey={row.key}
        group={group}
        list={scope.list}
      />
    )
  }

  // Failed work: tried again, handed to its assistant, its session opened
  // — not while its assistant is to pick it up first. An assistant's board
  // task that failed is its work's, the task as the row read it with it.
  const rowTask = row.task ?? null
  const failedTask =
    today?.kind === "task" && today.reason === "failed" ? rowTask : null
  const failedWork =
    today?.kind === "failed" &&
    today.reason !== "looking" &&
    row.why?.kind !== "looking"
      ? today.dispatch_id
      : failedTask?.dispatch_id != null &&
          bot != null &&
          row.why?.kind !== "looking"
        ? failedTask.dispatch_id
        : !today &&
            item?.kind === "dispatch" &&
            (item.dispatch_state === "failed" ||
              item.dispatch_state === "interrupted") &&
            row.why?.kind !== "looking"
          ? item.dispatch_id
          : null
  if (failedWork != null) {
    const d =
      dispatch?.id === failedWork
        ? dispatch
        : (scope.dispatches.find((x) => x.id === failedWork) ?? null)
    if (d && scope.can("work_retry")) {
      // A board task's work runs again on the board, as the row read the
      // task: one that failed before the board took it has none to read.
      if (d.mode !== "task" || failedTask) {
        out.push(
          button(
            "retry",
            t("retry"),
            () =>
              run(
                personalAgentWorkRetry(
                  bot,
                  { dispatchId: d.id },
                  d.updated_at,
                  failedTask?.updated_at
                ),
                () => toast.success(t("toast.retried"))
              ),
            true
          )
        )
      }
      if (bot != null) {
        out.push(
          button("hand", t("handTo", { name }), () =>
            run(personalAgentDispatchHand(bot, d.id, d.updated_at), () =>
              toast.success(t("toast.handed", { name }))
            )
          )
        )
      }
    }
    const target = workTargetOf(d ?? undefined)
    if (d && canOpenWork(target)) {
      out.push(
        button("session", t("viewSession"), () => {
          // Its sheet opens over the drawer: closed, the activity is
          // there again.
          openWork(target)
        })
      )
    }
  }

  // The owner's own board task that failed: run again, as the row read it.
  if (
    failedTask &&
    failedTask.dispatch_id == null &&
    bot == null &&
    scope.can("work_retry")
  ) {
    out.push(
      button(
        "retry",
        t("retry"),
        () =>
          run(
            personalAgentWorkRetry(
              null,
              { taskId: failedTask.id },
              failedTask.updated_at
            ),
            () => toast.success(t("toast.retried"))
          ),
        true
      )
    )
  }

  // A reviewed task of the board's, landed — merged, or delivered as a
  // pull request — on the run the row read (its dialog holds to it).
  const boardTask =
    today?.kind === "task" && today.task_id != null
      ? (scope.tasks.find((x) => x.id === today.task_id) ?? null)
      : null
  const task =
    boardTask && rowTask && boardTask.run_seq === rowTask.run_seq
      ? boardTask
      : null
  const handlers = task && scope.taskHandlers ? scope.taskHandlers(task) : null
  if (
    task &&
    handlers &&
    task.status === "review" &&
    LANDS.has(today?.reason ?? "review")
  ) {
    if (mustDeliverToPr(task)) {
      out.push(button("deliver", t("pushBack"), handlers.onDeliverPr, true))
    } else {
      out.push(
        button(
          "merge",
          task.base_branch
            ? t("mergeTo", { base: task.base_branch })
            : t("merge"),
          handlers.onMerge,
          true
        )
      )
      out.push(button("deliver", t("createPr"), handlers.onDeliverPr))
    }
  }

  // A card the row is, answered there (7.3): an acceptance the owner is
  // asked — accepted, or sent back as it says — or one to check again; a
  // merge of a watched pull request waiting for their approval.
  const notice = row.notice
  const cardAct = (
    key: string,
    label: string,
    action: NoticeAction,
    main = false
  ) =>
    button(
      key,
      label,
      () => {
        if (notice) {
          run(personalAgentNoticeAct(notice.id, action, bot), () =>
            toast.success(t("toast.done"))
          )
        }
      },
      main
    )
  if (notice?.kind === "acceptance") {
    if (notice.phase === "asked") {
      if (notice.has_message) {
        out.push(cardAct("revise", ta("revise"), "revise"))
      }
      out.push(cardAct("accept", ta("accept"), "accept", true))
    } else if (notice.phase === "void" || notice.phase === "changed") {
      out.push(cardAct("recheck", ta("recheck"), "recheck", true))
    }
  }
  if (
    notice?.kind === "confirm" &&
    notice.phase === "approve" &&
    row.pr &&
    row.why?.kind !== "read_failed" &&
    today?.kind !== "pr_ready"
  ) {
    out.push(
      cardAct(
        "approve-merge",
        t(row.pr.is_mr ? "mergeMr" : "mergePr"),
        "accept",
        true
      )
    )
  }

  // A watched pull request: merged at the head the row read, when it can
  // be; opened on its forge.
  const pr = row.pr
  if (pr) {
    const mr = pr.is_mr
    const head = pr.head_sha
    // Ready to merge: its card's row, or — the card gone — its own.
    // Not on a read it cannot vouch for (6.6): the platform has the last
    // word, and codeg could not hear it.
    const unread = row.why?.kind === "read_failed"
    const ready =
      today?.kind === "pr_ready" ||
      (today?.kind === "pr" && today.state === "mergeable")
    if (ready && head && !unread && scope.can("pr_merge")) {
      out.push(
        button(
          "merge-pr",
          t(mr ? "mergeMr" : "mergePr"),
          () =>
            run(personalAgentPrMerge(bot, pr.watch_id, head), (res, left) => {
              switch (res.outcome) {
                case "merging":
                  toast.success(t("toast.merging"))
                  break
                case "merged":
                  toast.success(t("toast.merged"))
                  break
                case "asked":
                  toast.message(t("toast.mergeAsked"))
                  break
                case "changed":
                  // Not merged: back as it is, for the list read again.
                  returnRow(left)
                  toast.message(t("toast.mergeChanged"))
                  break
                default:
                  returnRow(left)
                  toast.error(res.why ?? t("toast.mergeChanged"))
              }
            }),
          true
        )
      )
    }
    const url = pr.url
    if (url) {
      out.push(
        button("open-pr", t(mr ? "openMr" : "openPr"), () => {
          openInSystemBrowser(url).catch((e) => toast.error(toErrorMessage(e)))
        })
      )
    }
  }

  // A watched pull request its forge account cannot read: the account
  // seen to where codeg keeps them (6.6).
  const why = row.why
  if (
    why?.kind === "read_failed" &&
    (why.error === "auth" || why.error === "no_account") &&
    scope.can("watch_health")
  ) {
    out.push(
      button(
        "reconnect",
        t("reconnect"),
        () => {
          openSettingsWindow("version-control").catch((e) =>
            toast.error(toErrorMessage(e))
          )
        },
        true
      )
    )
  }

  // A message its receiver ended its turn on without answering: asked
  // again.
  if (
    row.why?.kind === "no_reply" &&
    item?.kind === "message" &&
    scope.can("message_nudge")
  ) {
    const peer = nameOf(row.why.peer)
    out.push(
      button(
        "nudge",
        t("nudge"),
        () =>
          run(personalAgentMessageNudge(bot, item.id), (fresh) =>
            fresh
              ? toast.success(t("toast.nudged", { name: peer }))
              : toast.message(t("toast.nudgedAlready", { name: peer }))
          ),
        true
      )
    )
  }

  // A reminder handed to its assistant, whose turn on it is over with it
  // still open: handed again.
  const handNotice = today?.notice_id ?? row.hand_notice_id ?? null
  if (
    row.why?.kind === "unfinished" &&
    item &&
    handNotice != null &&
    bot != null &&
    scope.can("rehand")
  ) {
    out.push(
      button(
        "rehand",
        t("rehand", { name }),
        () =>
          run(
            personalAgentNoticeAct(
              handNotice,
              "hand_again",
              bot,
              tr("handOverText", { summary: item.summary }),
              item.updated_at
            ),
            () => toast.success(t("toast.rehanded", { name }))
          ),
        true
      )
    )
  }

  return out.length > 0 ? <>{out}</> : null
}

"use client"

/** What a row waiting on the owner asks, answered on the row itself (7.5):
 *  a permission request's own options (never one that clears the context),
 *  a single question's choices, a plan approved — through the assistant
 *  whose request it is, the ask card an executor's was forwarded on (so it
 *  is recorded as the owner's answer on the page), or the session's own
 *  connection. What cannot be answered in a word (several questions, one
 *  to type, a secret, several to pick) stays the card's to open. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  acpAnswerPlanApproval,
  acpAnswerQuestion,
  acpRespondPermission,
  personalAgentAnswerPlan,
  personalAgentAnswerQuestion,
  personalAgentAskAnswer,
  personalAgentChoiceAnswer,
  personalAgentRespondPermission,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { parsePermissionToolCall } from "@/lib/permission-request"
import type { PlanApprovalAnswer, QuestionAnswer, RowAsk } from "@/lib/types"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import {
  leaveRow,
  returnRow,
  rowsCool,
} from "@/stores/personal-agent-activity-leaving-store"

import { refreshIfChanged } from "./matter-actions"

/** How many of a plan's steps the row shows. */
const PLAN_STEPS = 3

/** A plan's first steps, as its list says them. */
export function planSteps(plan: string, count = PLAN_STEPS): string[] {
  return plan
    .split("\n")
    .map((l) => l.trim())
    .map((l) => /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l)?.[1] ?? null)
    .filter((l): l is string => l != null && l.length > 0)
    .slice(0, count)
}

/** An answer refused because the request is no longer there to answer —
 *  answered in another window, withdrawn, its session gone: nothing went
 *  wrong, the row only has not been read again yet. */
const SETTLED_ELSEWHERE =
  /answered already|was answered|already answered|withdrawn|connection not found|no live session|no such card|no such question card|no question card/i

/** Whether `ask` can be answered in a word on its row. */
export function answersInline(ask: RowAsk): boolean {
  if (ask.kind !== "choice" && ask.via === "session" && !ask.connection_id) {
    return false
  }
  switch (ask.kind) {
    case "permission":
      return ask.options.some((o) => !o.option_id.includes("clear"))
    case "question": {
      const qs = Array.isArray(ask.questions) ? ask.questions : []
      const q = qs.length === 1 ? qs[0] : null
      return (
        q != null && !q.multi_select && !q.is_secret && q.options.length > 0
      )
    }
    case "plan":
      return true
    case "choice":
      return ask.options.length > 0
  }
}

/** The buttons answering `ask` on its row ([`answersInline`]). */
export function RowAskActions({
  ask,
  bot,
  rowKey,
  group,
  list,
}: {
  ask: RowAsk
  bot: number | null
  /** The row it is on, and its group: what leaves once answered (7.4). */
  rowKey: string
  group: string
  list: string
}) {
  const t = useTranslations("PersonalAgent.feed.ask")
  const [busy, setBusy] = useState(false)
  const [wholePlan, setWholePlan] = useState(false)
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState("")
  // Answered elsewhere first, or withdrawn: the list read again says so,
  // and the owner is told in a word — no error.
  const run = (
    call: () => Promise<unknown>,
    click?: { detail: number },
    /** It leaves its group as it is sent (7.4) — not one sent with words
     *  written for it, kept on the row until the answer took. */
    leave = true
  ) => {
    // The second click of one meant for a row that just left.
    if (click && rowsCool(click.detail)) return
    setBusy(true)
    const left = leave ? leaveRow(rowKey, group, list) : null
    call()
      .then((res) => {
        refreshActivity()
        // An ask answered on its card says what came of it: answered by
        // someone first, or withdrawn — told in a word.
        const state =
          res != null && typeof res === "object"
            ? (res as { state?: unknown }).state
            : null
        if (state === "already_answered" || state === "withdrawn") {
          toast.message(t("settled"))
        } else {
          toast.success(t("answered"))
        }
      })
      .catch((e) => {
        const message = toErrorMessage(e)
        if (SETTLED_ELSEWHERE.test(message)) {
          refreshActivity()
          toast.message(t("settled"))
          return
        }
        if (left != null) returnRow(left)
        refreshIfChanged(e)
        toast.error(message)
      })
      .finally(() => setBusy(false))
  }
  const session = ask.kind !== "choice" && ask.via === "session"
  const conn =
    ask.kind !== "choice" && ask.connection_id ? ask.connection_id : null
  if (session && !conn) return null

  switch (ask.kind) {
    case "permission": {
      // Never one that clears the context (as an ask's plan option is
      // chosen, `asks.rs`).
      const options = ask.options.filter((o) => !o.option_id.includes("clear"))
      if (options.length === 0) return null
      const main = options.find((o) => o.kind.startsWith("allow"))
      // What it asks to do, from the request itself: the row's own words
      // may be its work's title.
      const parsed = parsePermissionToolCall(ask.tool_call)
      const what = parsed.description ?? parsed.title
      return (
        <>
          {what ? (
            <span
              className="basis-full truncate text-xs text-foreground/80"
              title={what}
              data-pa-row-ask-title
            >
              {what}
            </span>
          ) : null}
          {parsed.command ? (
            <code
              className="basis-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              title={parsed.command}
              data-pa-row-ask-command
            >
              {parsed.command}
            </code>
          ) : null}
          {options.map((o) => (
            <Button
              key={o.option_id}
              size="xs"
              variant={o === main ? "default" : "outline"}
              disabled={busy}
              onClick={(e) =>
                run(
                  () =>
                    conn
                      ? acpRespondPermission(conn, ask.request_id, o.option_id)
                      : personalAgentRespondPermission(
                          ask.request_id,
                          o.option_id,
                          bot
                        ),
                  e
                )
              }
              data-pa-row-ask={o.option_id}
            >
              {o.name}
            </Button>
          ))}
          {ask.queued ? (
            <span className="text-xs text-muted-foreground">
              {t("queued", { count: ask.queued })}
            </span>
          ) : null}
        </>
      )
    }
    case "question": {
      const qs = Array.isArray(ask.questions) ? ask.questions : []
      const q = qs.length === 1 ? qs[0] : null
      if (!q || q.multi_select || q.is_secret || q.options.length === 0) {
        return null
      }
      const answerOf = (label: string): QuestionAnswer => ({
        answers: [{ questionId: q.id, labels: [label] }],
        declined: false,
      })
      const send = (label: string) => () =>
        ask.via === "ask" && ask.ask_id != null
          ? personalAgentAskAnswer({
              askId: ask.ask_id,
              answer: answerOf(label),
            })
          : conn
            ? acpAnswerQuestion(conn, ask.question_id, answerOf(label))
            : personalAgentAnswerQuestion(ask.question_id, answerOf(label), bot)
      return (
        <>
          <span
            className="basis-full text-xs text-foreground/80"
            data-pa-row-ask-question
          >
            {q.question}
          </span>
          {q.options.map((o, i) => (
            <Button
              key={o.label}
              size="xs"
              variant={i === 0 ? "default" : "outline"}
              disabled={busy}
              title={o.description || undefined}
              onClick={(e) => run(send(o.label), e)}
              data-pa-row-ask={`option-${i}`}
            >
              {o.label}
            </Button>
          ))}
        </>
      )
    }
    case "plan": {
      const steps = planSteps(ask.plan)
      // More to it than its first steps say: the whole of it, as written.
      const lines = ask.plan.split("\n").filter((l) => l.trim().length > 0)
      const more = lines.length > steps.length
      const answer = (decision: "approve" | "revise", feedback?: string) => {
        // Approved, it says no more than that; sent back, what to change.
        const plan: PlanApprovalAnswer =
          decision === "approve"
            ? { decision: "approve" }
            : { decision: "request_changes", feedback }
        return ask.via === "ask" && ask.ask_id != null
          ? personalAgentAskAnswer(
              feedback === undefined
                ? { askId: ask.ask_id, decision }
                : { askId: ask.ask_id, decision, feedback }
            )
          : conn
            ? acpAnswerPlanApproval(conn, ask.approval_id, plan)
            : personalAgentAnswerPlan(ask.approval_id, plan, bot)
      }
      const sendBack = () => {
        const words = note.trim()
        if (!words) return
        run(() => answer("revise", words), undefined, false)
      }
      return (
        <>
          {wholePlan ? (
            <div
              className="max-h-64 basis-full overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground"
              data-pa-row-ask-plan
            >
              {ask.plan}
            </div>
          ) : steps.length > 0 ? (
            <ol
              className="basis-full list-inside list-decimal text-xs text-muted-foreground"
              data-pa-row-ask-steps
            >
              {steps.map((s, i) => (
                <li key={i} className="truncate">
                  {s}
                </li>
              ))}
            </ol>
          ) : null}
          {revising ? (
            <Textarea
              className="basis-full text-xs"
              rows={2}
              value={note}
              placeholder={t("planReviseHint")}
              onChange={(e) => setNote(e.target.value)}
              data-pa-row-ask-note
            />
          ) : null}
          {revising ? (
            <>
              <Button
                size="xs"
                disabled={busy || note.trim().length === 0}
                onClick={sendBack}
                data-pa-row-ask="send-back"
              >
                {t("planReviseSend")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setRevising(false)}
              >
                {t("planReviseCancel")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                disabled={busy}
                onClick={(e) => run(() => answer("approve"), e)}
                data-pa-row-ask="approve-plan"
              >
                {t("approvePlan")}
              </Button>
              {more ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setWholePlan((w) => !w)}
                  data-pa-row-ask="whole-plan"
                >
                  {wholePlan ? t("planLess") : t("planAll")}
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setRevising(true)}
                data-pa-row-ask="revise-plan"
              >
                {t("planRevise")}
              </Button>
            </>
          )}
        </>
      )
    }
    case "choice":
      return (
        <>
          {ask.options.map((o, i) => (
            <Button
              key={o.key}
              size="xs"
              variant={i === 0 ? "default" : "outline"}
              disabled={busy}
              onClick={(e) =>
                run(
                  () =>
                    personalAgentChoiceAnswer(
                      ask.notice_id,
                      { key: o.key },
                      bot
                    ),
                  e
                )
              }
              data-pa-row-ask={`choice-${o.key}`}
            >
              {o.label}
            </Button>
          ))}
        </>
      )
  }
}

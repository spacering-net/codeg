"use client"

/**
 * One round of acceptance (7.5) of code work an assistant
 *   handed out — a native card codeg writes itself. Which round of how
 *   many, who did the work and who checked it, what the check found (or
 *   that nobody else could check it), what the assistant concluded and why —
 *   both, when it went against the check — or that codeg went by the check,
 *   or that the owner decided. When it is the owner's call: the question,
 *   what sending it back would say, [Send it back as written] [Accept it]
 *   [Open task]. When the worktree changed during or after its check:
 *   [Check again]. Earlier rounds under it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import type {
  AcceptanceCardData,
  AcceptanceState,
  CheckVerdict,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { asVerdict, VerdictChip } from "./acceptance-bits"
import { CollapsedText } from "./event-card"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import {
  AGENT_SURFACE,
  canOpenWork,
  num,
  PaSheet,
  str,
  useOpenWork,
  usePageScope,
  workTargetOf,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

type Decision = "accept" | "revise" | "ask_owner"

function asDecision(v: unknown): Decision | null {
  return v === "accept" || v === "revise" || v === "ask_owner" ? v : null
}

/** A conclusion that goes against what the check found. */
function against(decision: Decision | null, verdict: CheckVerdict | null) {
  return (
    (decision === "accept" && verdict === "fail") ||
    (decision === "revise" && verdict === "pass")
  )
}

export function AcceptanceCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.acceptance")
  const tn = useTranslations("PersonalAgent.notice")
  const botId = useBotId()
  const { dispatchById } = usePersonalAgent()
  const { readOnly } = usePageScope()
  const openWork = useOpenWork()
  const row = item.row
  const data = (row.data ?? {}) as Partial<AcceptanceCardData> &
    Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const phase = (str(data, "phase") ?? "deciding") as AcceptanceState
  const round = num(data, "round") ?? 1
  const max = num(data, "max_rounds") ?? 0
  const verdict = asVerdict(data.verdict)
  const unchecked = data.unchecked === true
  // Checked again since: this round asks nothing more.
  const superseded = data.superseded === true
  const decision = asDecision(data.decision)
  const decidedBy = str(data, "decided_by")
  const reason = str(data, "reason")
  const message = str(data, "message")
  const question = str(data, "question")
  const evidence = str(data, "evidence")
  const executor = str(data, "executor")
  const checker = str(data, "checker")
  const title = str(data, "title") ?? row.body.split("\n")[0]
  const mergeCommit = str(data, "merge_commit")
  const deliveredHead = str(data, "delivered_head")
  const history = Array.isArray(data.history) ? data.history : []

  const dispatchId = num(data, "dispatch_id")
  const info = dispatchId != null ? dispatchById.get(dispatchId) : undefined
  const target = workTargetOf(info, {
    ...row,
    dispatch_id: dispatchId,
    data: {
      mode: "task",
      work_task_id: num(data, "work_task_id"),
      folder_id: num(data, "folder_id"),
      title,
    },
  })

  const answer = async (action: NoticeAction) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(action)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, action, botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const spin = (a: NoticeAction) =>
    busy === a ? <SyncedSpinner small className="size-3.5" /> : null
  const disabled = readOnly || busy != null

  const head = max > 0 ? t("titleMax", { round, max }) : t("title", { round })
  const people =
    executor && checker
      ? t("people", { executor, checker })
      : executor
        ? t("peopleUnchecked", { executor })
        : null
  const decisionWord = decision ? t(`decision.${decision}`) : null
  // What the conclusion was, and on whose word.
  const conclusion =
    decidedBy === "fallback"
      ? t("fallback")
      : decidedBy === "owner" && decisionWord
        ? t("owner", { decision: decisionWord })
        : decision && decision !== "ask_owner" && decisionWord
          ? against(decision, verdict) && reason
            ? t("against", {
                verdict: t(`verdict.${verdict ?? "unverified"}`),
                decision: decisionWord,
                reason,
              })
            : reason
              ? t("assistantWhy", { decision: decisionWord, reason })
              : t("assistant", { decision: decisionWord })
          : null
  const ended =
    phase === "accepted"
      ? t("accepted")
      : phase === "revised"
        ? t("revised")
        : phase === "void"
          ? t("void")
          : phase === "changed"
            ? decision === "accept"
              ? t("changedAfterAccept")
              : t("changed")
            : phase === "stale"
              ? t("stale")
              : null
  const asked = phase === "asked" && !superseded
  const recheck = (phase === "void" || phase === "changed") && !superseded
  const canOpen = canOpenWork(target)

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-acceptance={phase}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <ClipboardCheck className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">{head}</span>
          {people ? (
            <span className="before:me-1.5 before:content-['·']">{people}</span>
          ) : null}
        </p>
        <PaSheet>
          <p className="text-sm font-medium break-words">{title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            {unchecked ? (
              <span
                data-pa-unchecked
                className="inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 font-medium text-amber-700 dark:text-amber-300"
              >
                {t("unchecked")}
              </span>
            ) : (
              <>
                <span className="text-muted-foreground">{t("check")}</span>
                <VerdictChip verdict={verdict} />
              </>
            )}
            {phase === "accepted" && !unchecked && verdict === "unverified" ? (
              <span
                data-pa-not-verified
                className="inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 font-medium text-amber-700 dark:text-amber-300"
              >
                {t("notVerified")}
              </span>
            ) : null}
          </div>
          {conclusion ? (
            <p
              data-pa-conclusion
              className="mt-1.5 text-xs break-words text-muted-foreground"
            >
              {conclusion}
            </p>
          ) : null}
          {evidence ? (
            <div className="text-xs" data-pa-evidence>
              <CollapsedText text={evidence} />
            </div>
          ) : null}
          {asked ? (
            <div className="mt-2.5 space-y-2">
              {question ? (
                <p className="text-sm break-words" data-pa-question>
                  {t("question", { question })}
                </p>
              ) : null}
              {max > 0 && round >= max ? (
                <p className="text-xs text-muted-foreground" data-pa-used-up>
                  {t("usedUp", { count: round })}
                </p>
              ) : null}
              {message ? (
                <div data-pa-revise-message>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("wouldSend")}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">
                    {message}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          {phase === "revised" && message ? (
            <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">
              {message}
            </p>
          ) : null}
          {ended ? (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-pa-accept-ended={phase}
            >
              {ended}
              {superseded && (phase === "void" || phase === "changed") ? (
                <span
                  data-pa-superseded
                  className="before:mx-1.5 before:content-['·']"
                >
                  {t("superseded")}
                </span>
              ) : null}
            </p>
          ) : null}
          {phase === "accepted" && mergeCommit ? (
            <p className="mt-1 text-xs text-muted-foreground" data-pa-merged>
              {t("merged", { commit: mergeCommit.slice(0, 7) })}
            </p>
          ) : null}
          {phase === "accepted" && deliveredHead && !mergeCommit ? (
            <p className="mt-1 text-xs text-muted-foreground" data-pa-delivered>
              {t("delivered", { head: deliveredHead.slice(0, 7) })}
            </p>
          ) : null}
          {asked || recheck || canOpen ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {asked && message ? (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void answer("revise")}
                  data-pa-accept-act="revise"
                >
                  {spin("revise")}
                  {t("revise")}
                </Button>
              ) : null}
              {asked ? (
                <Button
                  size="sm"
                  variant={message ? "secondary" : "default"}
                  disabled={disabled}
                  onClick={() => void answer("accept")}
                  data-pa-accept-act="accept"
                >
                  {spin("accept")}
                  {t("accept")}
                </Button>
              ) : null}
              {recheck ? (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void answer("recheck")}
                  data-pa-accept-act="recheck"
                >
                  {spin("recheck")}
                  {t("recheck")}
                </Button>
              ) : null}
              {/* A button that looks one — alone on a card settled, a ghost
                one reads as text set in from the rest. */}
              {canOpen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openWork(target)}
                  data-pa-accept-act="open"
                >
                  {t("openTask")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {history.length > 0 ? (
            <div className="mt-2.5 border-t border-border/60 pt-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("history")}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {history.map((h) => {
                  const n = typeof h.round === "number" ? h.round : 0
                  const m = typeof h.message === "string" ? h.message : ""
                  const line =
                    h.state === "revised"
                      ? t("historyRevised", { round: n, message: m })
                      : h.state === "accepted"
                        ? t("historyAccepted", { round: n })
                        : h.state === "changed"
                          ? t("historyChanged", { round: n })
                          : h.state === "asked"
                            ? t("historyAsked", { round: n })
                            : t("historyOpen", { round: n })
                  return (
                    <li key={`${n}-${h.state}`} data-pa-history={n}>
                      {line}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
        </PaSheet>
        {failed ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {tn("failed", { error: failed })}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}

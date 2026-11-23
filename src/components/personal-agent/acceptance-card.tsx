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
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Undo2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import type {
  AcceptanceCardData,
  AcceptanceState,
  CheckVerdict,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { asVerdict, VerdictChip } from "./acceptance-bits"
import { splitLine } from "./list-row"
import { CollapsedText } from "./event-card"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import {
  canOpenWork,
  num,
  CardMessage,
  SHEET_TITLE,
  SheetActions,
  SheetField,
  SheetFields,
  SheetLabel,
  SheetNote,
  SheetPart,
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

/** What sending the work back says (or said): set in as a quote is. */
const SENT_BACK =
  "border-s-2 border-border ps-3 text-sm leading-5 break-words whitespace-pre-wrap text-foreground/90"

/** How a round ended, on its tone: through green, sent back amber, void
 *  or out of date quiet. */
const ENDED_TONE: Partial<Record<AcceptanceState, string>> = {
  accepted: "text-emerald-700 dark:text-emerald-400",
  revised: "text-amber-700 dark:text-amber-400",
  changed: "text-amber-700 dark:text-amber-400",
}

function EndedIcon({ phase }: { phase: AcceptanceState }) {
  const Icon =
    phase === "accepted"
      ? CircleCheck
      : phase === "revised"
        ? Undo2
        : CircleAlert
  return <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
}

/** A label as a fact's: its own colon left to the layout. */
function bare(label: string): string {
  return label.replace(/\s*[:：]\s*$/u, "")
}

function NotVerified({ label }: { label: string }) {
  return (
    <span
      data-pa-not-verified
      className="inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 font-medium text-amber-700 dark:text-amber-300"
    >
      {label}
    </span>
  )
}

/** An earlier round's line: one line, cut where it runs over, a chevron
 *  at its end to read it whole. */
function HistoryLine({ text }: { text: string }) {
  const t = useTranslations("PersonalAgent.event")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLSpanElement>(text)
  return (
    <span className="flex w-full min-w-0 items-start gap-1">
      <span
        ref={contentRef}
        id={contentId}
        data-pa-history-text
        className={cn(
          "min-w-0 flex-1 text-foreground/80",
          expanded ? "whitespace-pre-wrap" : "line-clamp-1"
        )}
      >
        {text}
      </span>
      {isOverflowing ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? t("less") : t("more")}
          title={expanded ? t("less") : t("more")}
          data-pa-history-toggle
          className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </span>
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
  const decisionWord = decision ? t(`decision.${decision}`) : null
  // What the conclusion was, and on whose word: whose as a fact's label
  // (the owner's, the assistant's — the check's verdict stands over it,
  // so one that goes against it shows both), codeg's fallback a line.
  const said =
    decidedBy === "fallback"
      ? null
      : decidedBy === "owner" && decisionWord
        ? t("owner", { decision: decisionWord })
        : decision && decision !== "ask_owner" && decisionWord
          ? reason
            ? t("assistantWhy", { decision: decisionWord, reason })
            : t("assistant", { decision: decisionWord })
          : null
  const conclusion =
    decidedBy === "fallback"
      ? { line: t("fallback"), split: null }
      : said
        ? { line: said, split: splitLine(said) }
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
  // A round that ended as it was decided: how it ended says the decision
  // already — whose word it was goes on that line, the assistant's reason
  // a fact of its own, not a conclusion line saying "accept" once more.
  const endedAsDecided =
    (phase === "accepted" && decision === "accept") ||
    (phase === "revised" && decision === "revise")
  const byWord =
    endedAsDecided && decidedBy === "owner"
      ? t("by.owner")
      : endedAsDecided && decidedBy === "assistant"
        ? t("by.assistant")
        : null
  const againstCheck = against(decision, verdict)
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
      <CardMessage
        data-pa-acceptance={phase}
        head={
          <>
            <ClipboardCheck aria-hidden />
            <span className="font-medium">{head}</span>
          </>
        }
      >
        {/* What it is and how it stands: the check, the conclusion and
              whose, how it ended. */}
        <SheetPart>
          <p className={SHEET_TITLE}>{title}</p>
          <SheetFields className="mt-2">
            {unchecked ? (
              <p className="col-span-2 flex">
                <span
                  data-pa-unchecked
                  className="inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 font-medium text-amber-700 dark:text-amber-300"
                >
                  {t("unchecked")}
                </span>
              </p>
            ) : (
              <SheetField label={bare(t("check"))}>
                <VerdictChip verdict={verdict} />
                {phase === "accepted" && verdict === "unverified" ? (
                  <NotVerified label={t("notVerified")} />
                ) : null}
              </SheetField>
            )}
            {conclusion && !byWord ? (
              conclusion.split ? (
                <SheetField
                  label={conclusion.split.head}
                  data-pa-conclusion
                  data-pa-against={againstCheck ? "" : undefined}
                >
                  {/* Against the check: on the caution's tone. */}
                  <span
                    className={cn(
                      againstCheck && "text-amber-700 dark:text-amber-300"
                    )}
                  >
                    {conclusion.split.text}
                  </span>
                </SheetField>
              ) : (
                <p
                  data-pa-conclusion
                  className="col-span-2 [overflow-wrap:anywhere] text-muted-foreground"
                >
                  {conclusion.line}
                </p>
              )
            ) : null}
            {ended ? (
              <SheetField label={t("result")} data-pa-result-field>
                <span
                  className={cn(
                    "flex items-start gap-1.5",
                    ENDED_TONE[phase] ?? "text-muted-foreground"
                  )}
                >
                  <EndedIcon phase={phase} />
                  <span>
                    <span data-pa-accept-ended={phase}>
                      {ended}
                      {superseded &&
                      (phase === "void" || phase === "changed") ? (
                        <span
                          data-pa-superseded
                          className="before:mx-1.5 before:content-['·']"
                        >
                          {t("superseded")}
                        </span>
                      ) : null}
                    </span>
                    {/* Whose word it ended on, when the conclusion line
                        would only have said it again; against the check
                        on the caution's tone. */}
                    {byWord ? (
                      <span
                        data-pa-decided-by={decidedBy}
                        data-pa-against={againstCheck ? "" : undefined}
                        className={cn(
                          "before:mx-1.5 before:content-['·']",
                          againstCheck
                            ? "text-amber-700 dark:text-amber-300"
                            : "text-muted-foreground"
                        )}
                      >
                        {byWord}
                      </span>
                    ) : null}
                    {phase === "accepted" && mergeCommit ? (
                      <span
                        className="text-muted-foreground before:mx-1.5 before:content-['·']"
                        data-pa-merged
                      >
                        {t("merged", { commit: mergeCommit.slice(0, 7) })}
                      </span>
                    ) : null}
                    {phase === "accepted" && deliveredHead && !mergeCommit ? (
                      <span
                        className="text-muted-foreground before:mx-1.5 before:content-['·']"
                        data-pa-delivered
                      >
                        {t("delivered", { head: deliveredHead.slice(0, 7) })}
                      </span>
                    ) : null}
                  </span>
                </span>
              </SheetField>
            ) : null}
            {byWord && decidedBy === "assistant" && reason ? (
              <SheetField label={t("why")} data-pa-reason>
                <span className="text-foreground/80">{reason}</span>
              </SheetField>
            ) : null}
          </SheetFields>
        </SheetPart>
        {/* What the check found. */}
        {evidence ? (
          <SheetPart className="text-xs" data-pa-evidence>
            <CollapsedText text={evidence} />
          </SheetPart>
        ) : null}
        {/* The owner's call: the question, what sending it back says. */}
        {asked && (question || (max > 0 && round >= max) || message) ? (
          <SheetPart className="flex flex-col gap-2">
            {question ? (
              <p
                className="text-sm leading-5 font-medium break-words"
                data-pa-question
              >
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
                <SheetLabel className="mb-1">{t("wouldSend")}</SheetLabel>
                <p className={SENT_BACK}>{message}</p>
              </div>
            ) : null}
          </SheetPart>
        ) : null}
        {phase === "revised" && message ? (
          <SheetPart>
            <p className={SENT_BACK}>{message}</p>
          </SheetPart>
        ) : null}
        {asked || recheck || canOpen ? (
          <SheetActions>
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
          </SheetActions>
        ) : null}
        {/* The rounds before this one, each its round and how it went. */}
        {history.length > 0 ? (
          <SheetPart>
            <SheetLabel>{t("history")}</SheetLabel>
            <SheetFields className="text-muted-foreground">
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
                const split = splitLine(line)
                return split ? (
                  <SheetField
                    key={`${n}-${h.state}`}
                    label={split.head}
                    data-pa-history={n}
                  >
                    <HistoryLine text={split.text} />
                  </SheetField>
                ) : (
                  <p
                    key={`${n}-${h.state}`}
                    data-pa-history={n}
                    className="col-span-2 flex min-w-0 [overflow-wrap:anywhere]"
                  >
                    <HistoryLine text={line} />
                  </p>
                )
              })}
            </SheetFields>
          </SheetPart>
        ) : null}
        {failed ? (
          <SheetNote>
            <p role="alert" className="break-words text-destructive">
              {tn("failed", { error: failed })}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

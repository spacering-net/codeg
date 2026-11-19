"use client"

/**
 * What a pull request an assistant watches came to (7.4) — a native card
 * codeg writes itself, one per place it reached on its head: its checks
 * failed (which ones, with their links), green again, a conflict, ready to
 * merge, merged, closed. The card says which head its checks are of. A
 * newer card supersedes it ("it moved on since"). [View PR]; while it is the
 * latest: [Got it] and [Stop watching].
 *
 * Phase 3 (7.4): what codeg does about it by itself — a round its task runs
 * to fix failed checks or a conflict (or, asked first, [Fix it]); fixed as
 * often as allowed, the rounds and what each changed — and review feedback
 * the owner is asked to hand to the task ([Hand it to the task]).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestArrow,
  MessageSquareDiff,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import type {
  PrCardData,
  PrCheckTally,
  PrEvent,
  PrFeedbackShown,
  PrFixState,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import {
  AGENT_SURFACE,
  PaSheet,
  SHEET_TITLE,
  SheetActions,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const EVENTS: readonly PrEvent[] = [
  "checks_failed",
  "checks_passed",
  "conflict",
  "mergeable",
  "no_conflict",
  "merged",
  "closed",
  "feedback",
]

const ICONS: Record<PrEvent, LucideIcon> = {
  checks_failed: CircleX,
  checks_passed: CircleCheck,
  conflict: TriangleAlert,
  mergeable: GitPullRequestArrow,
  no_conflict: GitPullRequestArrow,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  feedback: MessageSquareDiff,
}

/** Its tone: failing red, stuck amber, ready teal, merged green. */
function toneOf(event: PrEvent): string {
  switch (event) {
    case "checks_failed":
      return "text-red-700 dark:text-red-300"
    case "conflict":
    case "feedback":
      return "text-amber-700 dark:text-amber-300"
    case "mergeable":
      return "text-teal-700 dark:text-teal-300"
    case "merged":
    case "checks_passed":
      return "text-emerald-700 dark:text-emerald-300"
    default:
      return "text-muted-foreground"
  }
}

function tallyOf(v: unknown): PrCheckTally | null {
  if (!v || typeof v !== "object") return null
  const t = v as Partial<PrCheckTally>
  return {
    available: t.available === true,
    partial: t.partial === true,
    total: Number(t.total ?? 0),
    passed: Number(t.passed ?? 0),
    failed: Number(t.failed ?? 0),
    pending: Number(t.pending ?? 0),
    neutral: Number(t.neutral ?? 0),
    failing: Array.isArray(t.failing) ? t.failing : [],
  }
}

/** Final: nothing more to watch for. */
function settles(event: PrEvent): boolean {
  return event === "merged" || event === "closed"
}

const FIX_STATES: readonly PrFixState["state"][] = [
  "starting",
  "started",
  "failed",
  "none",
  "busy",
  "ask",
  "told",
  "off",
  "gave_up",
]

function fixOf(v: unknown): PrFixState | null {
  if (!v || typeof v !== "object") return null
  const f = v as Partial<PrFixState>
  if (!f.state || !FIX_STATES.includes(f.state)) return null
  return {
    ...f,
    state: f.state,
    cause: f.cause === "conflict" ? "conflict" : "checks",
    rounds: Array.isArray(f.rounds) ? f.rounds : [],
  }
}

function feedbackOf(v: unknown): PrFeedbackShown[] {
  return Array.isArray(v)
    ? v.filter(
        (x): x is PrFeedbackShown =>
          !!x && typeof x === "object" && typeof x.id === "string"
      )
    : []
}

/** What codeg does about failed checks or a conflict, in a line. */
function FixLine({ fix }: { fix: PrFixState }) {
  const t = useTranslations("PersonalAgent.pr.fix")
  const what = fix.cause === "conflict" ? "conflict" : "checks"
  let text: string | null = null
  switch (fix.state) {
    case "starting":
    case "started":
      text = t(`${fix.how === "followup" ? "followup" : "task"}.${what}`, {
        n: fix.n ?? 1,
      })
      break
    case "failed":
      text = t("failed", { error: fix.error ?? "" })
      break
    case "none":
      text = t("none", { why: fix.why ?? "" })
      break
    case "busy":
      text = t("busy")
      break
    case "ask":
      text = t(`ask.${what}`)
      break
    case "told":
      text = t("told")
      break
    case "off":
      text = t("off")
      break
    case "gave_up":
      text = null
      break
  }
  if (fix.state === "gave_up") {
    const rounds = fix.rounds ?? []
    return (
      <SheetPart className="text-xs" data-pa-pr-fix="gave_up">
        <p className="font-medium text-red-700 dark:text-red-300">
          {t("gaveUp", { n: rounds.length })}
        </p>
        {rounds.length > 0 ? (
          <ol className="mt-1 flex flex-col gap-1" data-pa-pr-rounds>
            {rounds.map((r) => (
              <li key={`${r.n}-${r.dispatch_id}`} className="min-w-0">
                <span className="font-medium tabular-nums">
                  {t("round", { n: r.n })}
                </span>{" "}
                <span className="text-muted-foreground">
                  {t(`cause.${r.cause === "conflict" ? "conflict" : "checks"}`)}
                  {r.files != null
                    ? ` · ${t("lines", {
                        files: r.files,
                        added: r.additions ?? 0,
                        removed: r.deletions ?? 0,
                      })}`
                    : ""}
                </span>
                {r.summary ? (
                  <span className="block break-words text-muted-foreground">
                    {r.summary}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </SheetPart>
    )
  }
  if (!text) return null
  return (
    <SheetPart
      className="flex items-start gap-1 text-xs text-muted-foreground"
      data-pa-pr-fix={fix.state}
    >
      <Wrench className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </SheetPart>
  )
}

/** The review feedback a feedback card asks about. */
function FeedbackList({ items }: { items: PrFeedbackShown[] }) {
  const t = useTranslations("PersonalAgent.pr.feedback")
  return (
    <ul className="flex flex-col gap-1.5 text-xs" data-pa-pr-feedback>
      {items.map((f) => {
        const where =
          f.path != null
            ? f.line != null
              ? `${f.path}:${f.line}`
              : f.path
            : null
        const kind =
          f.kind === "review"
            ? f.verdict === "changes_requested"
              ? t("kind.changes")
              : t("kind.review")
            : f.kind === "line"
              ? t("kind.line")
              : t("kind.comment")
        return (
          <li key={f.id} className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span className="font-medium text-foreground">
                {f.author ?? t("someone")}
              </span>
              <span>{f.writer ? t("writer") : t("outsider")}</span>
              <span>· {kind}</span>
              {where ? (
                <span dir="ltr" className="font-mono">
                  · {where}
                </span>
              ) : null}
            </p>
            {f.text ? (
              f.url ? (
                <button
                  type="button"
                  className="mt-0.5 block text-start break-words underline-offset-2 hover:underline"
                  onClick={() => void openUrl(f.url ?? "")}
                >
                  {f.text}
                </button>
              ) : (
                <p className="mt-0.5 break-words">{f.text}</p>
              )
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function PrCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.pr")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const row = item.row
  const data = (row.data ?? {}) as Partial<PrCardData> & Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const event =
    typeof data.event === "string" &&
    (EVENTS as readonly string[]).includes(data.event)
      ? (data.event as PrEvent)
      : "checks_failed"
  const state = str(data, "state") ?? "open"
  const target = str(data, "target") ?? ""
  const title = str(data, "title")
  const url = str(data, "url")
  const head = str(data, "head")
  const mergeState = str(data, "merge_state")
  const tally = tallyOf(data.checks)
  const fix = fixOf(data.fix)
  const feedback = feedbackOf(data.feedback)
  const forwarded = data.forwarded
  // Ready to merge, and why codeg did not merge it by itself (7.4).
  const mergeRaw = data.merge as { state?: string; why?: string } | undefined
  const mergeNote =
    mergeRaw &&
    (mergeRaw.state === "refused" || mergeRaw.state === "unread") &&
    typeof mergeRaw.why === "string"
      ? { state: mergeRaw.state, why: mergeRaw.why }
      : null
  const Icon = ICONS[event]
  const current = state === "open"
  // Asked on it: whether its task fixes it, or has the feedback.
  const asksFix = current && fix?.state === "ask"
  const asksForward = current && event === "feedback"

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

  const facts: string[] = []
  if (head) facts.push(t("head", { head }))
  if (tally) {
    if (!tally.available) facts.push(t("checks.unknown"))
    else if (tally.total === 0) facts.push(t("checks.none"))
    else
      facts.push(
        t("checks.passed", { passed: tally.passed, total: tally.total })
      )
    if (tally.available && tally.pending > 0)
      facts.push(t("checks.running", { n: tally.pending }))
    if (tally.partial) facts.push(t("checks.partial"))
  }
  const failing = tally?.failing ?? []
  const more = tally ? Math.max(0, tally.failed - failing.length) : 0
  const why =
    (event === "conflict" || event === "checks_passed") && mergeState
      ? t("mergeState", { state: mergeState })
      : null
  const note =
    state === "later"
      ? t("state.later")
      : state === "stopped"
        ? t("state.stopped")
        : null
  const heading =
    fix?.state === "gave_up"
      ? t("fix.gaveUpHeading")
      : t(`event.${event}` as "event.mergeable")

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text: [heading, target, title].filter(Boolean).join(" · "),
        at: row.created_at,
      }}
    >
      <div
        data-bubble
        data-pa-pr={event}
        data-pa-pr-state={state}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground",
          !current && "opacity-80"
        )}
      >
        <p
          className={cn(
            "mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs",
            toneOf(event)
          )}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">{heading}</span>
        </p>
        <PaSheet>
          {/* What the pull request is, how it stands, what came of it. */}
          <SheetPart className="flex flex-col gap-1.5">
            <p className={SHEET_TITLE} data-pa-pr-title>
              <span dir="ltr">{target}</span>
              {title ? (
                <span className="font-normal text-muted-foreground">
                  {" · "}
                  {title}
                </span>
              ) : null}
            </p>
            {facts.length > 0 ? (
              <p
                className="text-xs text-muted-foreground tabular-nums"
                data-pa-pr-facts
              >
                {facts.join(" · ")}
              </p>
            ) : null}
            {mergeNote ? (
              <p
                className="text-xs break-words text-muted-foreground"
                data-pa-pr-merge={mergeNote.state}
              >
                {mergeNote.state === "unread"
                  ? t("merge.unread", { why: mergeNote.why })
                  : t("merge.refused", { why: mergeNote.why })}
              </p>
            ) : null}
            {event === "feedback" && forwarded ? (
              <p className="text-xs text-muted-foreground" data-pa-pr-forwarded>
                {forwarded.waiting
                  ? t("feedback.waiting")
                  : t("feedback.forwarded")}
              </p>
            ) : null}
            {event === "no_conflict" ? (
              <p className="text-xs text-muted-foreground">
                {t("noConflictNote")}
              </p>
            ) : null}
            {why ? (
              <p className="text-xs text-muted-foreground" data-pa-pr-why>
                {why}
              </p>
            ) : null}
            {note ? (
              <p className="text-xs text-muted-foreground" data-pa-pr-note>
                {note}
              </p>
            ) : null}
          </SheetPart>
          {/* The checks that failed. */}
          {event === "checks_failed" && failing.length > 0 ? (
            <SheetPart>
              <ul className="flex flex-col gap-0.5 text-xs" data-pa-pr-failing>
                {failing.map((c, i) => (
                  <li
                    key={`${c.name}-${i}`}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <CircleX
                      className="size-3 shrink-0 text-red-600 dark:text-red-400"
                      aria-hidden
                    />
                    {c.url ? (
                      <button
                        type="button"
                        className="min-w-0 truncate text-start underline-offset-2 hover:underline"
                        onClick={() => void openUrl(c.url ?? "")}
                      >
                        {c.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate">{c.name}</span>
                    )}
                    {c.summary ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {c.summary}
                      </span>
                    ) : null}
                  </li>
                ))}
                {more > 0 ? (
                  <li className="text-muted-foreground">
                    {t("more", { n: more })}
                  </li>
                ) : null}
              </ul>
            </SheetPart>
          ) : null}
          {/* The review's feedback. */}
          {event === "feedback" && feedback.length > 0 ? (
            <SheetPart>
              <FeedbackList items={feedback} />
            </SheetPart>
          ) : null}
          {/* Who is fixing it, or that nobody could. */}
          {fix ? <FixLine fix={fix} /> : null}
          {url || (current && !readOnly && !settles(event)) ? (
            <SheetActions>
              {url ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void openUrl(url)}
                  data-pa-pr-act="view"
                >
                  {t("view")}
                </Button>
              ) : null}
              {asksFix && !readOnly ? (
                <Button
                  size="sm"
                  disabled={busy != null}
                  onClick={() => void answer("fix")}
                  data-pa-pr-act="fix"
                >
                  {spin("fix")}
                  {fix?.cause === "conflict"
                    ? t("fix.doConflict")
                    : t("fix.doChecks")}
                </Button>
              ) : null}
              {asksForward && !readOnly ? (
                <Button
                  size="sm"
                  disabled={busy != null}
                  onClick={() => void answer("forward")}
                  data-pa-pr-act="forward"
                >
                  {spin("forward")}
                  {t("feedback.forward")}
                </Button>
              ) : null}
              {current && !readOnly && !settles(event) ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy != null}
                    onClick={() => void answer("dismiss")}
                    data-pa-pr-act="dismiss"
                  >
                    {spin("dismiss")}
                    {asksForward ? t("feedback.skip") : t("gotIt")}
                  </Button>
                  {event !== "feedback" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy != null}
                      onClick={() => void answer("unwatch")}
                      data-pa-pr-act="unwatch"
                    >
                      {spin("unwatch")}
                      {t("unwatch")}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </SheetActions>
          ) : null}
        </PaSheet>
        {failed ? (
          <p className="mt-1.5 text-xs break-words text-destructive">
            {failed}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}

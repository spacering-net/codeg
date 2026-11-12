"use client"

/**
 * What a pull request an assistant watches came to (7.4) — a native card
 * codeg writes itself, one per place it reached on its head: its checks
 * failed (which ones, with their links), green again, a conflict, ready to
 * merge, merged, closed. The card says which head its checks are of. A
 * newer card supersedes it ("it moved on since"). [View PR]; while it is the
 * latest: [Got it] and [Stop watching].
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestArrow,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import type { PrCardData, PrCheckTally, PrEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { AGENT_SURFACE, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const EVENTS: readonly PrEvent[] = [
  "checks_failed",
  "checks_passed",
  "conflict",
  "mergeable",
  "no_conflict",
  "merged",
  "closed",
]

const ICONS: Record<PrEvent, LucideIcon> = {
  checks_failed: CircleX,
  checks_passed: CircleCheck,
  conflict: TriangleAlert,
  mergeable: GitPullRequestArrow,
  no_conflict: GitPullRequestArrow,
  merged: GitMerge,
  closed: GitPullRequestClosed,
}

/** Its tone: failing red, stuck amber, ready teal, merged green. */
function toneOf(event: PrEvent): string {
  switch (event) {
    case "checks_failed":
      return "text-red-700 dark:text-red-300"
    case "conflict":
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
  const Icon = ICONS[event]
  const current = state === "open"

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
  const heading = t(`event.${event}` as "event.mergeable")

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
        <p className="text-sm font-medium break-words" data-pa-pr-title>
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
            className="mt-1.5 text-xs text-muted-foreground tabular-nums"
            data-pa-pr-facts
          >
            {facts.join(" · ")}
          </p>
        ) : null}
        {event === "checks_failed" && failing.length > 0 ? (
          <ul
            className="mt-1.5 flex flex-col gap-0.5 text-xs"
            data-pa-pr-failing
          >
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
        ) : null}
        {event === "no_conflict" ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("noConflictNote")}
          </p>
        ) : null}
        {why ? (
          <p className="mt-1.5 text-xs text-muted-foreground" data-pa-pr-why>
            {why}
          </p>
        ) : null}
        {note ? (
          <p className="mt-1.5 text-xs text-muted-foreground" data-pa-pr-note>
            {note}
          </p>
        ) : null}
        {url || (current && !readOnly && !settles(event)) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {url ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openUrl(url)}
                data-pa-pr-act="view"
              >
                {t("view")}
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
                  {t("gotIt")}
                </Button>
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
              </>
            ) : null}
          </div>
        ) : null}
        {failed ? (
          <p className="mt-1.5 text-xs break-words text-destructive">
            {failed}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}

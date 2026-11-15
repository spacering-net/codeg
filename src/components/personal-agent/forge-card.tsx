"use client"

/**
 * One thing an assistant does on a forge (7.4) — a comment, closing an
 * issue, merging a pull request — a native card codeg writes itself, at the
 * item it named once (repository, account, number). What was done and where
 * (the comment's full text, a merge's head, its checks and what vouches for
 * the version), with its link; or why not. When the owner asked to approve
 * such actions first: [Approve] [Decline]. When codeg cannot tell whether it
 * went through: [Look] [Do it again] [Let it be] — doing it again looks on
 * the forge first, so one that went through is not done twice.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleHelp,
  CircleX,
  GitMerge,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import type {
  ForgeAction,
  ForgeCardData,
  ForgeCardState,
  ForgeCardTarget,
  ForgeRefusalCode,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { CollapsedText } from "./event-card"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { MutedNote, MuteKindButton } from "./mute-kind"
import { AGENT_SURFACE, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const ACTIONS: readonly ForgeAction[] = ["comment", "close", "merge"]
const STATES: readonly ForgeCardState[] = [
  "open",
  "acting",
  "done",
  "refused",
  "failed",
  "unknown",
  "not_run",
  "dismissed",
]
const CODES: readonly ForgeRefusalCode[] = [
  "merged",
  "closed",
  "draft",
  "after_acceptance",
  "not_accepted",
  "not_delivered",
  "checks_unreadable",
  "checks_partial",
  "checks_running",
  "checks_failing",
]

const ICONS: Record<ForgeAction, LucideIcon> = {
  comment: MessageSquareText,
  close: CircleX,
  merge: GitMerge,
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v)
    ? (v as T)
    : null
}

/** `owner/repo#12` — `!12` for a GitLab merge request. */
export function forgeLabel(target: Partial<ForgeCardTarget>): string {
  const sigil = target.provider === "GitLab" && target.kind === "pr" ? "!" : "#"
  return `${target.repo ?? ""}${sigil}${target.number ?? ""}`
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function ForgeCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.forge")
  const tn = useTranslations("PersonalAgent.notice")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const row = item.row
  const data = (row.data ?? {}) as Partial<ForgeCardData> &
    Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const action = oneOf(ACTIONS, data.action) ?? "comment"
  const state = oneOf(STATES, data.state) ?? "open"
  const why = str(data, "why") ?? "direct"
  const target = (
    data.target && typeof data.target === "object" ? data.target : {}
  ) as Partial<ForgeCardTarget>
  const label = forgeLabel(target)
  const body = str(data, "body")
  const head = str(data, "head")
  const checks = str(data, "checks")
  const version = str(data, "version")
  const method = str(data, "method")
  const guaranteed = data.guaranteed !== false
  const code = oneOf(CODES, data.code)
  const reason = str(data, "reason")
  const error = str(data, "error")
  const result =
    data.result && typeof data.result === "object" ? data.result : null
  const mergeCommit =
    result && typeof result.merge_commit === "string"
      ? result.merge_commit
      : null
  const resultUrl =
    result && typeof result.url === "string" && result.url ? result.url : null
  const targetUrl = typeof target.url === "string" ? target.url : null
  const link = resultUrl ?? targetUrl

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
  const disabled = readOnly || busy != null

  const heading =
    state === "open"
      ? why === "suggest"
        ? t("heading.suggested")
        : why === "cnb"
          ? t("heading.cnb")
          : t("heading.approve")
      : state === "refused" && action === "merge"
        ? t("heading.notMerged")
        : t(`heading.${state}` as "heading.done", {
            provider: target.provider ?? "",
          })
  const Icon = state === "unknown" ? CircleHelp : ICONS[action]
  const title = t(`title.${action}` as "title.comment", { target: label })
  const who = [target.provider, target.account].filter(Boolean).join(" · ")
  const facts: string[] = []
  if (action === "merge") {
    if (head) facts.push(t("merge.head", { head: shortSha(head) }))
    if (method) facts.push(t(`merge.method.${method}` as "merge.method.merge"))
  }
  const checksLine =
    action === "merge" && checks
      ? t(`merge.checks.${checks}` as "merge.checks.green")
      : null
  const versionLine =
    action === "merge" && version
      ? t(`merge.version.${version}` as "merge.version.green")
      : null
  // What went wrong, said once: a merge's own rule, else the forge's words.
  const problem =
    state === "refused" && code
      ? t(`code.${code}` as "code.merged")
      : state === "not_run"
        ? t("notRun", { error: error ?? "" })
        : state === "failed"
          ? t("failed", { error: error ?? "" })
          : state === "unknown"
            ? t("unknown", { error: error ?? "" })
            : null
  const detail =
    state === "refused" && code && error && error !== problem ? error : null
  const shownError = failed ?? (state === "open" ? error : null)

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text: [title, body].filter(Boolean).join("\n\n"),
        at: row.created_at,
      }}
    >
      <div
        data-bubble
        data-pa-forge={state}
        data-pa-forge-action={action}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {state === "acting" ? (
            <SyncedSpinner small className="size-3.5 shrink-0" />
          ) : (
            <Icon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-medium">{heading}</span>
          {who ? (
            <span className="before:me-1.5 before:content-['·']">{who}</span>
          ) : null}
        </p>
        <p className="text-sm font-medium break-words" data-pa-forge-title>
          {title}
        </p>
        {body ? (
          <div className="text-sm" data-pa-forge-body>
            <CollapsedText text={body} />
          </div>
        ) : null}
        {facts.length > 0 ? (
          <p
            className="mt-1.5 text-xs text-muted-foreground"
            data-pa-forge-head
          >
            {facts.join(" · ")}
          </p>
        ) : null}
        {checksLine ? (
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            data-pa-forge-checks={checks ?? ""}
          >
            {checksLine}
          </p>
        ) : null}
        {versionLine ? (
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            data-pa-forge-version={version ?? ""}
          >
            {versionLine}
          </p>
        ) : null}
        {action === "merge" && !guaranteed ? (
          <p
            data-pa-forge-unguaranteed
            className="mt-1.5 inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
          >
            {t("merge.unguaranteed")}
          </p>
        ) : null}
        {state === "done" && mergeCommit ? (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-pa-forge-merge-commit
          >
            {t("merge.commit", { commit: shortSha(mergeCommit) })}
          </p>
        ) : null}
        {problem ? (
          <p
            className="mt-1.5 text-xs break-words text-amber-700 dark:text-amber-300"
            data-pa-forge-problem={code ?? state}
          >
            {problem}
          </p>
        ) : null}
        {detail ? (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">
            {detail}
          </p>
        ) : null}
        {reason ? (
          <p className="mt-1.5 text-xs break-words text-muted-foreground">
            {t("reason", { reason })}
          </p>
        ) : null}
        {state === "open" || state === "unknown" || link ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {state === "open" ? (
              <>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void answer("accept")}
                  data-pa-forge-act="accept"
                >
                  {spin("accept")}
                  {t("approve")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void answer("dismiss")}
                  data-pa-forge-act="dismiss"
                >
                  {t("decline")}
                </Button>
                {why === "suggest" ? (
                  <MuteKindButton noticeId={noticeId} disabled={disabled} />
                ) : null}
              </>
            ) : null}
            {state === "unknown" ? (
              <>
                {targetUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openUrl(targetUrl)}
                    data-pa-forge-act="look"
                  >
                    {t("look")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void answer("retry")}
                  data-pa-forge-act="retry"
                >
                  {spin("retry")}
                  {t("again")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void answer("dismiss")}
                  data-pa-forge-act="dismiss"
                >
                  {t("letBe")}
                </Button>
              </>
            ) : link ? (
              // Alone on the card: a button that looks one.
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openUrl(link)}
                data-pa-forge-act="open"
              >
                {t("open")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <MutedNote data={data} />
        {shownError ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {tn("failed", { error: shownError })}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}

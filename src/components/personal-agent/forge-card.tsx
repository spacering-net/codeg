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
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  GitCommitHorizontal,
  GitMerge,
  MessageSquareText,
  ShieldCheck,
  TriangleAlert,
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
import { MessageRow } from "./message-row"
import { MutedNote, MuteKindButton } from "./mute-kind"
import {
  CardMessage,
  SHEET_TITLE,
  SheetActions,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

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

const GOOD = "text-emerald-700 dark:text-emerald-400"
const CAUTION = "text-amber-700 dark:text-amber-400"
const BAD = "text-red-700 dark:text-red-400"

/** A merge's fact, led by its mark, on its tone. */
function Fact({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon
  tone?: string
  children: React.ReactNode
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-1.5 break-words",
        tone ?? "text-muted-foreground"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </li>
  )
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
      <CardMessage
        data-pa-forge={state}
        data-pa-forge-action={action}
        head={
          <>
            {state === "acting" ? (
              <SyncedSpinner small className="size-3.5 shrink-0" />
            ) : (
              <Icon aria-hidden />
            )}
            <span className="font-medium">{heading}</span>
            {who ? (
              <span className="before:me-1.5 before:content-['·']">{who}</span>
            ) : null}
          </>
        }
      >
        {/* What it would do and where; for a merge, what vouches for it —
            each a line led by its mark. */}
        <SheetPart className="flex flex-col gap-2">
          <p className={SHEET_TITLE} data-pa-forge-title>
            {title}
          </p>
          {facts.length > 0 ||
          checksLine ||
          versionLine ||
          (action === "merge" && !guaranteed) ||
          (state === "done" && mergeCommit) ? (
            <ul className="flex flex-col gap-1 text-xs leading-5">
              {facts.length > 0 ? (
                <Fact icon={GitCommitHorizontal}>
                  <span
                    className="font-mono text-muted-foreground"
                    dir="ltr"
                    data-pa-forge-head
                  >
                    {facts.join(" · ")}
                  </span>
                </Fact>
              ) : null}
              {checksLine ? (
                <Fact
                  icon={checks === "green" ? CircleCheck : CircleDashed}
                  tone={checks === "green" ? GOOD : undefined}
                >
                  <span data-pa-forge-checks={checks ?? ""}>{checksLine}</span>
                </Fact>
              ) : null}
              {versionLine ? (
                <Fact icon={ShieldCheck} tone={GOOD}>
                  <span data-pa-forge-version={version ?? ""}>
                    {versionLine}
                  </span>
                </Fact>
              ) : null}
              {action === "merge" && !guaranteed ? (
                <Fact icon={TriangleAlert} tone={CAUTION}>
                  <span data-pa-forge-unguaranteed>
                    {t("merge.unguaranteed")}
                  </span>
                </Fact>
              ) : null}
              {state === "done" && mergeCommit ? (
                <Fact icon={GitMerge} tone={GOOD}>
                  <span data-pa-forge-merge-commit>
                    {t("merge.commit", { commit: shortSha(mergeCommit) })}
                  </span>
                </Fact>
              ) : null}
            </ul>
          ) : null}
        </SheetPart>
        {/* Why it was not done, or would be: on its tone. */}
        {problem || detail || reason ? (
          <SheetPart className="flex flex-col gap-1.5 text-xs leading-5">
            {problem ? (
              <p
                className={cn(
                  "flex items-start gap-1.5 break-words",
                  state === "failed" ? BAD : CAUTION
                )}
              >
                {state === "failed" ? (
                  <CircleX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                ) : (
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden
                  />
                )}
                <span data-pa-forge-problem={code ?? state}>{problem}</span>
              </p>
            ) : null}
            {detail ? (
              <p className="ps-5 break-words text-muted-foreground">{detail}</p>
            ) : null}
            {reason ? (
              <p className="border-s-2 border-border ps-3 break-words text-muted-foreground">
                {t("reason", { reason })}
              </p>
            ) : null}
          </SheetPart>
        ) : null}
        {/* What it would say. */}
        {body ? (
          <SheetPart className="text-sm" data-pa-forge-body>
            <CollapsedText text={body} />
          </SheetPart>
        ) : null}
        {state === "open" || state === "unknown" || link ? (
          <SheetActions>
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
                {/* Where it would act, beside the call on it. */}
                {link ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void openUrl(link)}
                    data-pa-forge-act="open"
                  >
                    {t("open")}
                  </Button>
                ) : null}
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
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void answer("retry")}
                  data-pa-forge-act="retry"
                >
                  {spin("retry")}
                  {t("again")}
                </Button>
                {targetUrl ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void openUrl(targetUrl)}
                    data-pa-forge-act="look"
                  >
                    {t("look")}
                  </Button>
                ) : null}
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
            ) : link && state !== "open" ? (
              // Alone on the card: a button that looks one.
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openUrl(link)}
                data-pa-forge-act="open"
              >
                {t("open")}
              </Button>
            ) : null}
          </SheetActions>
        ) : null}
        {data.muted || shownError ? (
          <SheetNote>
            <MutedNote data={data} className="" />
            {shownError ? (
              <p role="alert" className="break-words text-destructive">
                {tn("failed", { error: shownError })}
              </p>
            ) : null}
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

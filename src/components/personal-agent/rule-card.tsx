"use client"

/**
 * A card one of codeg's proposal rules raised (6.7): what it found, since
 * when, and the next step — codeg does what is certain (retry, a reminder,
 * a round of acceptance, a rebase, keeping an eye on a project, closing a
 * matter); what needs judging goes to the assistant as the owner's message,
 * in their words. [Not now] keeps the topic quiet a week; "Don't suggest
 * these" turns the rule off. A card whose thing is gone says so. The weekly
 * review's questions (6.6) are such cards too: show the changes the owner
 * keeps undoing first; hide or delete a work assistant nobody woke for two
 * weeks (the delete goes through the usual confirmation).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  BellRing,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Hourglass,
  MessageCircleQuestion,
  TriangleAlert,
  Undo2,
  UserX,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import type { ProposalRule } from "@/lib/types"
import { PROPOSAL_RULES } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { BotDeleteDialog } from "./bot-delete-dialog"
import { MutedNote, MuteKindButton } from "./mute-kind"
import { useWhen } from "./routine-bits"
import { OutcomeLine, type OutcomeTone } from "./outcome-line"
import { useSessionLinkOpener } from "./session-link"
import {
  CardMessage,
  num,
  SHEET_TITLE,
  SheetActions,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>
type Facts = Record<string, unknown>

const ICONS: Partial<Record<ProposalRule, LucideIcon>> = {
  failed: TriangleAlert,
  review: Hourglass,
  session: MessageCircleQuestion,
  pr_review: GitPullRequest,
  uncommitted: FolderGit2,
  idle: BellRing,
  behind: GitBranch,
  undo: Undo2,
  idle_bot: UserX,
}

/** Each rule's next steps, the first the main one. */
const STEPS: Partial<Record<ProposalRule, readonly NoticeAction[]>> = {
  failed: ["retry", "hand"],
  review: ["check", "remind"],
  session: ["open"],
  pr_review: ["summary"],
  uncommitted: ["open", "hand"],
  idle: ["hand", "close"],
  behind: ["rebase"],
  undo: ["ask_first"],
  idle_bot: ["hide", "delete"],
}

/** The states a step leaves the card in, as the server writes them. */
const DONE_STATES = [
  "handed",
  "retried",
  "checking",
  "reminding",
  "opened",
  "closed",
  "rebasing",
  "asking_first",
  "hidden",
  "deleted",
] as const

function asRule(v: string | null): ProposalRule | null {
  return (PROPOSAL_RULES as readonly string[]).includes(v ?? "")
    ? (v as ProposalRule)
    : null
}

/** What the thing is called on the card. */
function nameOf(rule: ProposalRule, f: Facts): string {
  switch (rule) {
    case "pr_review":
      return [
        `${str(f, "project") ?? ""} #${num(f, "number") ?? ""}`,
        str(f, "title"),
      ]
        .filter(Boolean)
        .join(" ")
    case "uncommitted":
      return str(f, "name") ?? ""
    case "idle":
      return str(f, "summary") ?? ""
    case "idle_bot":
      return str(f, "name") ?? ""
    case "undo":
      return ""
    default:
      return str(f, "title") ?? ""
  }
}

export function RuleCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.rules")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const when = useWhen()
  const openSession = useSessionLinkOpener()
  const { openConversations } = useWorkbenchRoute()
  const { openNewConversationTab } = useTabActions()
  const row = item.row
  const data = (row.data ?? {}) as Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  const rule = asRule(str(data, "rule"))
  if (!rule) return null
  const facts = (data.facts ?? {}) as Facts
  const state = str(data, "state") ?? "open"
  const open = state === "open"
  const since = str(data, "since")
  const name = nameOf(rule, facts)
  const Icon = ICONS[rule] ?? BellRing
  const error = failed ?? (open ? str(data, "error") : null)

  /** The owner's words a step hands over, in their language. */
  const words = (a: NoticeAction): string | undefined => {
    const v = {
      title: str(facts, "title") ?? "",
      project: str(facts, "project") ?? "",
      number: String(num(facts, "number") ?? ""),
      url: str(facts, "url") ?? "",
      name: str(facts, "name") ?? "",
      path: str(facts, "path") ?? "",
      summary: str(facts, "summary") ?? "",
    }
    switch (`${rule}.${a}`) {
      case "failed.hand":
        return t("hand.failed", v)
      case "review.check":
        return t("hand.review", v)
      case "review.remind":
        return t("hand.remind", v)
      case "pr_review.summary":
        return t("hand.prReview", v)
      case "uncommitted.hand":
        return t("hand.uncommitted", v)
      case "idle.hand":
        return t("hand.idle", v)
      default:
        return undefined
    }
  }

  const act = async (a: NoticeAction) => {
    if (!Number.isFinite(noticeId) || busy) return
    // Deleting asks first, as everywhere: the card settles once it is gone.
    if (rule === "idle_bot" && a === "delete") {
      const id = num(facts, "bot_id")
      if (id != null) setDeleting(id)
      return
    }
    // Where it is: opened at once, the card settled after.
    if (a === "open") {
      const conv = num(facts, "conversation_id")
      const folder = num(facts, "folder_id")
      const path = str(facts, "path")
      if (rule === "session" && conv != null) openSession(conv)
      if (rule === "uncommitted" && folder != null && path) {
        openConversations()
        openNewConversationTab(folder, path)
      }
    }
    setBusy(a)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, a, botId, words(a))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const detail = (() => {
    switch (rule) {
      case "failed":
        return str(facts, "error")
      case "session":
        return [
          t(`wait.${str(facts, "wait") ?? "question"}` as "wait.question"),
          str(facts, "text"),
        ]
          .filter(Boolean)
          .join(" · ")
      case "uncommitted":
        return [
          str(facts, "path"),
          facts.worktree === true && str(facts, "project")
            ? t("worktreeOf", { project: str(facts, "project") ?? "" })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      case "behind":
        return t("behindDetail", {
          branch: str(facts, "branch") ?? "",
          base: str(facts, "base") ?? "",
        })
      case "pr_review":
        return str(facts, "author")
          ? t("byAuthor", { author: str(facts, "author") ?? "" })
          : null
      case "undo":
        return t("undoDetail", {
          undone: num(facts, "undone") ?? 0,
          made: num(facts, "made") ?? 0,
        })
      case "idle_bot":
        return t("idleBotDetail")
      default:
        return null
    }
  })()

  const stateNote = (() => {
    if (state === "dismissed" && !str(data, "muted")) {
      return data.lowered_now === true ? t("loweredNow") : t("dismissed")
    }
    if (state === "expired") return t("expired")
    if ((DONE_STATES as readonly string[]).includes(state)) {
      return t(`done.${state}` as "done.handed")
    }
    return null
  })()

  // How it ended, on its tone: done through, let be or gone quiet,
  // taken back as such.
  const stateTone: OutcomeTone =
    state === "dismissed" || state === "expired" || state === "deleted"
      ? "off"
      : "done"

  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text: [t(`heading.${rule}` as "heading.failed"), name]
          .filter(Boolean)
          .join(" · "),
        at: row.created_at,
      }}
    >
      <CardMessage
        data-pa-rule-card={rule}
        data-pa-rule-card-state={state}
        head={
          <>
            {state === "acting" ? (
              <SyncedSpinner small className="size-3.5 shrink-0" />
            ) : (
              <Icon aria-hidden />
            )}
            <span className="font-medium">
              {t(`heading.${rule}` as "heading.failed")}
            </span>
            {since ? <span>· {t("since", { when: when(since) })}</span> : null}
          </>
        }
      >
        {/* What it is about, and how it stands. */}
        {name || detail || (data.lowered === true && open) || stateNote ? (
          <SheetPart className="flex flex-col gap-1.5">
            {name ? (
              <p className={SHEET_TITLE} data-pa-rule-name>
                {name}
              </p>
            ) : null}
            {detail ? (
              <p
                className={cn(
                  "line-clamp-3 text-xs leading-5 break-words",
                  rule === "failed"
                    ? "text-red-700 dark:text-red-400"
                    : "text-muted-foreground"
                )}
              >
                {detail}
              </p>
            ) : null}
            {data.lowered === true && open ? (
              <OutcomeLine tone="info" data-pa-rule-lowered>
                {t("lowered")}
              </OutcomeLine>
            ) : null}
            {stateNote ? (
              <OutcomeLine tone={stateTone} data-pa-rule-note>
                {stateNote}
              </OutcomeLine>
            ) : null}
          </SheetPart>
        ) : null}
        {open && !readOnly ? (
          <SheetActions>
            {open ? (
              <>
                {(STEPS[rule] ?? []).map((a, i) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={i === 0 ? "default" : "secondary"}
                    disabled={busy != null}
                    onClick={() => void act(a)}
                    data-pa-rule-act={a}
                  >
                    {busy === a ? (
                      <SyncedSpinner small className="size-3.5" />
                    ) : null}
                    {t(`step.${rule}.${a}` as "step.failed.retry")}
                  </Button>
                ))}
                {rule === "pr_review" && str(facts, "url") ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void openUrl(str(facts, "url") ?? "")}
                    data-pa-rule-act="open_pr"
                  >
                    {t("openPr")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy != null}
                  onClick={() => void act("dismiss")}
                  data-pa-rule-act="dismiss"
                >
                  {t("notNow")}
                </Button>
                <MuteKindButton
                  noticeId={noticeId}
                  disabled={busy != null}
                  onFailed={setFailed}
                />
              </>
            ) : null}
          </SheetActions>
        ) : null}
        {str(data, "muted") || error ? (
          <SheetNote>
            <MutedNote data={data} className="" />
            {error ? (
              <p role="alert" className="break-words text-destructive">
                {t("failed", { error })}
              </p>
            ) : null}
          </SheetNote>
        ) : null}
      </CardMessage>
      {rule === "idle_bot" ? (
        <BotDeleteDialog
          botId={deleting}
          onOpenChange={(o) => {
            if (!o) setDeleting(null)
          }}
          onDeleted={() => {
            setBusy("delete")
            personalAgentNoticeAct(noticeId, "delete", botId)
              .catch((e) =>
                setFailed(e instanceof Error ? e.message : String(e))
              )
              .finally(() => setBusy(null))
          }}
        />
      ) : null}
    </MessageRow>
  )
}

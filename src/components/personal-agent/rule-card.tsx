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
 * weeks (the delete goes through the usual confirmation). A run of one
 * rule's cards raised together is one card (`RuleGroupCard`): the first
 * few, each with its own steps, the rest behind [Show all].
 */

import { useContext, useState } from "react"
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
import type { ProposalRule, TimelineRow } from "@/lib/types"
import { PROPOSAL_RULES } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { JumpRowContext, MessageRow } from "./message-row"
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

/**
 * What one rule card's row says and does, wherever it is drawn: on a card
 * of its own (`RuleCard`), or as one of a run of its rule's cards drawn as
 * one (`RuleGroupCard`) — each keeps its own steps, its own answer.
 */
function useRuleRow(row: TimelineRow) {
  const t = useTranslations("PersonalAgent.rules")
  const botId = useBotId()
  const openSession = useSessionLinkOpener()
  const { openConversations } = useWorkbenchRoute()
  const { openNewConversationTab } = useTabActions()
  const data = (row.data ?? {}) as Record<string, unknown>
  const noticeId = Number(row.ref_id)
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)

  const rule = asRule(str(data, "rule"))
  const facts = (data.facts ?? {}) as Facts
  const state = str(data, "state") ?? "open"
  const open = state === "open"
  const since = str(data, "since")
  const name = rule ? nameOf(rule, facts) : ""
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

  /** The assistant deleted through the usual confirmation: the card
   *  settles. */
  const onDeleted = () => {
    setBusy("delete")
    personalAgentNoticeAct(noticeId, "delete", botId)
      .catch((e) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  return {
    data,
    noticeId,
    rule,
    facts,
    state,
    open,
    since,
    name,
    detail,
    stateNote,
    stateTone,
    error,
    busy,
    setFailed,
    deleting,
    setDeleting,
    act,
    onDeleted,
  }
}

type RuleRow = ReturnType<typeof useRuleRow>

/** A card's step buttons, the first the main one, and [Not now]. */
function RuleSteps({ r }: { r: RuleRow }) {
  const t = useTranslations("PersonalAgent.rules")
  if (!r.rule) return null
  const rule = r.rule
  return (
    <>
      {(STEPS[rule] ?? []).map((a, i) => (
        <Button
          key={a}
          size="sm"
          variant={i === 0 ? "default" : "secondary"}
          disabled={r.busy != null}
          onClick={() => void r.act(a)}
          data-pa-rule-act={a}
        >
          {r.busy === a ? <SyncedSpinner small className="size-3.5" /> : null}
          {t(`step.${rule}.${a}` as "step.failed.retry")}
        </Button>
      ))}
      {rule === "pr_review" && str(r.facts, "url") ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void openUrl(str(r.facts, "url") ?? "")}
          data-pa-rule-act="open_pr"
        >
          {t("openPr")}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={r.busy != null}
        onClick={() => void r.act("dismiss")}
        data-pa-rule-act="dismiss"
      >
        {t("notNow")}
      </Button>
    </>
  )
}

/** What it is about (and `after` it, what more a card says there), and
 *  how it stands. */
function RuleFacts({ r, after }: { r: RuleRow; after?: React.ReactNode }) {
  const t = useTranslations("PersonalAgent.rules")
  return (
    <>
      {r.name ? (
        <p className={SHEET_TITLE} data-pa-rule-name>
          {r.name}
        </p>
      ) : null}
      {after}
      {r.detail ? (
        <p
          className={cn(
            "line-clamp-3 text-xs leading-5 break-words",
            r.rule === "failed"
              ? "text-red-700 dark:text-red-400"
              : "text-muted-foreground"
          )}
        >
          {r.detail}
        </p>
      ) : null}
      {r.data.lowered === true && r.open ? (
        <OutcomeLine tone="info" data-pa-rule-lowered>
          {t("lowered")}
        </OutcomeLine>
      ) : null}
      {r.stateNote ? (
        <OutcomeLine tone={r.stateTone} data-pa-rule-note>
          {r.stateNote}
        </OutcomeLine>
      ) : null}
    </>
  )
}

/** The confirmation an idle assistant's [Delete…] goes through. */
function RuleDeleteDialog({ r }: { r: RuleRow }) {
  if (r.rule !== "idle_bot") return null
  return (
    <BotDeleteDialog
      botId={r.deleting}
      onOpenChange={(o) => {
        if (!o) r.setDeleting(null)
      }}
      onDeleted={r.onDeleted}
    />
  )
}

export function RuleCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.rules")
  const { readOnly } = usePageScope()
  const when = useWhen()
  const row = item.row
  const r = useRuleRow(row)
  const { data, rule, state, open, since, name, detail, stateNote, error } = r

  if (!rule) return null
  const Icon = ICONS[rule] ?? BellRing

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
            <RuleFacts r={r} />
          </SheetPart>
        ) : null}
        {open && !readOnly ? (
          <SheetActions>
            <RuleSteps r={r} />
            <MuteKindButton
              noticeId={r.noticeId}
              disabled={r.busy != null}
              onFailed={r.setFailed}
            />
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
      <RuleDeleteDialog r={r} />
    </MessageRow>
  )
}

/** How many of a run of one rule's cards drawn as one show before
 *  [Show all]. */
export const RULE_GROUP_PREVIEW = 5

/**
 * A run of one rule's cards raised together (`ruleOfRow` in
 * message-items), drawn as one card: the first [`RULE_GROUP_PREVIEW`] of
 * them, each with what it found, since when and its own steps; the rest
 * behind [Show all], which says how many more there are, and folds back.
 * "Don't suggest these" is the rule's, so it is once, on the card's last
 * band, while any of them is open; a mute from one of them the card says,
 * with the way back. A jump to one folded away unfolds it; a right-click
 * on one quotes or copies that one.
 */
export function RuleGroupCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.rules")
  const { readOnly } = usePageScope()
  const rows = item.rules ?? [item.row]
  // A jump to one folded away unfolds the card, so it lands on it.
  const jump = useContext(JumpRowContext)
  const folded = (to: { id: number } | null) =>
    to != null && rows.slice(RULE_GROUP_PREVIEW).some((r) => r.id === to.id)
  const [expanded, setExpanded] = useState(() => folded(jump))
  const [seenJump, setSeenJump] = useState(jump)
  if (jump !== seenJump) {
    setSeenJump(jump)
    if (folded(jump)) setExpanded(true)
  }
  const [muteFailed, setMuteFailed] = useState<string | null>(null)
  const rule = asRule(str(item.row.data, "rule"))
  if (!rule || rows.length === 0) return null
  const Icon = ICONS[rule] ?? BellRing
  const shown = expanded ? rows : rows.slice(0, RULE_GROUP_PREVIEW)
  const rest = rows.length - RULE_GROUP_PREVIEW
  const muted = rows.find((r) => str(r.data, "muted"))
  // "Don't suggest these" while any of them is open — as each card of its
  // own offers it — whatever an earlier mute (the rule may be on again).
  const firstOpen = rows.find((r) => str(r.data, "state") === "open")
  const heading = t(`heading.${rule}` as "heading.failed")
  const nameOfRow = (r: TimelineRow) =>
    nameOf(rule, (r.data?.facts ?? {}) as Facts)
  // Each quoted and copied on its own from its menu; the whole copies
  // every one.
  const parts = Object.fromEntries(
    rows.map((r) => [r.id, [heading, nameOfRow(r)].filter(Boolean).join(" · ")])
  )
  const copyText = [
    `${heading} · ${t("group.count", { count: rows.length })}`,
    ...rows.map(nameOfRow).filter(Boolean),
  ].join("\n")

  return (
    <MessageRow
      rowId={item.row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: item.row.id,
        text: copyText,
        at: item.row.created_at,
        parts,
      }}
    >
      <CardMessage
        data-pa-rule-card={rule}
        data-pa-rule-group={rows.length}
        head={
          <>
            <Icon aria-hidden />
            <span className="font-medium">{heading}</span>
            <span data-pa-rule-group-count>
              · {t("group.count", { count: rows.length })}
            </span>
          </>
        }
      >
        {shown.map((r) => (
          <RuleGroupEntry key={r.id} row={r} nested={r.id !== item.row.id} />
        ))}
        {rest > 0 || (firstOpen && !readOnly) ? (
          <SheetActions>
            {rest > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                  data-pa-rule-group-toggle={expanded ? "collapse" : "expand"}
                >
                  {expanded ? t("group.collapse") : t("group.expand")}
                </Button>
                {!expanded ? (
                  <span
                    className="text-xs text-muted-foreground"
                    data-pa-rule-group-rest
                  >
                    {t("group.more", { count: rest })}
                  </span>
                ) : null}
              </>
            ) : null}
            {firstOpen && !readOnly ? (
              <span className="ms-auto">
                <MuteKindButton
                  noticeId={Number(firstOpen.ref_id)}
                  onFailed={setMuteFailed}
                />
              </span>
            ) : null}
          </SheetActions>
        ) : null}
        {muted || muteFailed ? (
          <SheetNote>
            <MutedNote data={muted?.data} className="" />
            {muteFailed ? (
              <p role="alert" className="break-words text-destructive">
                {t("failed", { error: muteFailed })}
              </p>
            ) : null}
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

/** One of a run's cards: what it found, since when, how it stands, and
 *  its own steps while it is open. */
function RuleGroupEntry({
  row,
  nested,
}: {
  row: TimelineRow
  /** Not the card's first: its row id is its own (a jump lands on it). */
  nested: boolean
}) {
  const t = useTranslations("PersonalAgent.rules")
  const { readOnly } = usePageScope()
  const when = useWhen()
  const r = useRuleRow(row)
  if (!r.rule) return null
  const mutedHere = r.state === "dismissed" && str(r.data, "muted") != null
  return (
    <SheetPart
      className="flex flex-col gap-1.5"
      data-row-id={nested ? row.id : undefined}
      data-pa-part-row={row.id}
      data-pa-rule-entry={r.state}
    >
      <RuleFacts
        r={r}
        after={
          r.since || r.state === "acting" ? (
            <p
              className="flex items-center gap-1 text-xs leading-4 text-muted-foreground"
              data-pa-rule-since
            >
              {r.state === "acting" ? (
                <SyncedSpinner small className="size-3 shrink-0" />
              ) : null}
              {r.since ? t("since", { when: when(r.since) }) : null}
            </p>
          ) : null
        }
      />
      {mutedHere ? (
        <OutcomeLine tone="off" data-pa-rule-note>
          {t("group.mutedEntry")}
        </OutcomeLine>
      ) : null}
      {r.open && !readOnly ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <RuleSteps r={r} />
        </div>
      ) : null}
      {r.error ? (
        <p role="alert" className="text-xs break-words text-destructive">
          {t("failed", { error: r.error })}
        </p>
      ) : null}
      <RuleDeleteDialog r={r} />
    </SheetPart>
  )
}

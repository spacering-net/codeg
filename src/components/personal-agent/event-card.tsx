"use client"

/**
 * News about work the assistant handed out, as a message from the assistant
 * that ran it. On top, the work's row — the one the reply that handed it out
 * carries (`WorkRow`), so the two read as the same work: that assistant's
 * avatar with its agent's mark, the work's title, who ran it as what and
 * where, how it stood when the news came, and the way to its session. Under
 * it, the note it ended with, and its result as the message's text: markdown
 * at the size of a reply's, cut at a few lines and faded, with the way to
 * read the rest under it. The latest news of a task carries its task card
 * (`TaskStrip`, 8.5) under the row. It quotes the reply that dispatched (or last
 * continued) the work, unless that is the message right above. Unread until
 * the assistant starts on it. The news of an acceptance check (7.5) says
 * which round it checked and what it found, with its evidence as the text.
 */

import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp, MoreHorizontal, Repeat } from "lucide-react"

import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DispatchInfo, RoutineDraft } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { cn } from "@/lib/utils"

import { asVerdict, CheckLabel, DoneWhen, VerdictChip } from "./acceptance-bits"
import { AcceptanceFacts } from "./acceptance-fold"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import {
  asDispatchState,
  asMode,
  BUBBLE_MARKDOWN,
  canOpenWork,
  DispatchStateChip,
  MARKDOWN_LIST_ROOM,
  num,
  CardMessage,
  SheetActions,
  SheetPart,
  str,
  UnreadMark,
  useOpenWork,
  useOtherAssistant,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import {
  asLadder,
  hasTaskActions,
  LadderChip,
  TaskActions,
  TaskStrip,
  useStoppedWords,
  useWorkStoppable,
  WorkStopButton,
} from "./task-strip"
import { StateIcon, WorkRow } from "./work-card"

type EventItem = Extract<MessageItem, { kind: "event" }>

/** The notes codeg writes itself (a restart, a lost connection, a deleted
 *  task), by what brought the news: worded in the owner's language. Any
 *  other note is an agent's own error, shown as it came. */
const OWN_NOTES = new Set(["boot", "lost", "gone"])

/** The result, as the message's text, cut at six of its lines until asked
 *  for all. A proposal card shows its prompt the same way. */
export function CollapsedText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const t = useTranslations("PersonalAgent.event")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(text)
  const clipped = !expanded
  return (
    <div data-pa-result className={className}>
      <div
        ref={contentRef}
        id={contentId}
        className={cn(
          "break-words",
          MARKDOWN_LIST_ROOM,
          clipped && "max-h-[7.5rem] overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        <JsonRenderScope>
          {/* The result is cut at a length, not at a block: close what the
              cut left open (a fence, a list) as a stream would. */}
          <MessageResponse
            parseIncompleteMarkdown
            className={cn("text-sm", BUBBLE_MARKDOWN)}
          >
            {text}
          </MessageResponse>
        </JsonRenderScope>
      </div>
      {isOverflowing ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t("less") : t("more")}
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  )
}

/** The new work that took this failed work over (B1), from the card's
 *  `replaced_by`. */
function asReplacedBy(
  v: unknown
): { dispatchId: number; title: string; rowId: number | null } | null {
  if (!v || typeof v !== "object") return null
  const r = v as Record<string, unknown>
  if (typeof r.dispatch_id !== "number") return null
  return {
    dispatchId: r.dispatch_id,
    title: typeof r.title === "string" ? r.title : `#${r.dispatch_id}`,
    rowId: typeof r.row_id === "number" ? r.row_id : null,
  }
}

/** How codeg went on from a restart's interruption (7.3), from the card's
 *  `auto_retry`: retried, retrying, asked, out of retries. */
export function useRetryLine(): (v: unknown) => string | null {
  const t = useTranslations("PersonalAgent.event.retry")
  return (v) => {
    if (!v || typeof v !== "object") return null
    const r = v as Record<string, unknown>
    const attempt = typeof r.attempt === "number" ? r.attempt : 0
    const max = typeof r.max === "number" ? r.max : 0
    switch (r.state) {
      case "pending":
        return t("pending", { attempt, max })
      case "retried":
        return t("retried", { attempt, max })
      case "failed":
        return t("failed", {
          error: typeof r.error === "string" ? r.error : "",
        })
      case "asked":
        return t("asked")
      case "exhausted":
        return t("exhausted", { max })
      default:
        return null
    }
  }
}

/** "Answered for you N times": the questions and plan approvals of the
 *  work its assistant answered for the owner (7.3.1). */
export function AnsweredForYou({
  count,
  className,
}: {
  count: number
  className?: string
}) {
  const t = useTranslations("PersonalAgent.ask")
  if (count <= 0) return null
  return (
    <p
      data-pa-answered-for-you={count}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {t("answeredForYou", { count })}
    </p>
  )
}

/** "Every week, like this": a routine handing out the same work, at this
 *  weekday and time (6.9). */
function weeklyDraft(info: DispatchInfo): RoutineDraft {
  const now = new Date()
  return {
    title: info.title,
    what: info.prompt,
    kind: "dispatch",
    cron: `${now.getMinutes()} ${now.getHours()} * * ${now.getDay()}`,
    dispatch: {
      mode: info.mode,
      project_id: info.mode === "chat" ? null : info.folder_id,
      deliverable:
        info.mode === "task"
          ? info.deliverable === "report"
            ? "report"
            : "change"
          : null,
    },
  }
}

/** The news's buttons, its card's last band: the task card's, then its
 *  own — none of it when there is no button to show. */
function EventActions({
  strip,
  live,
}: {
  strip: DispatchInfo | null
  /** The work as it is now, on its latest news: [Stop] while it moves. */
  live: DispatchInfo | null
}) {
  const stoppable = useWorkStoppable(live)
  if (!(strip && hasTaskActions(strip)) && !stoppable) return null
  return (
    <SheetActions data-pa-event-actions>
      {strip ? <TaskActions d={strip} /> : null}
      {live && stoppable ? <WorkStopButton d={live} /> : null}
    </SheetActions>
  )
}

/** The work head's ⋯ (D1): done, and not a routine's already — make it
 *  one, every week at this weekday and time to start with (6.9). */
function WorkMenu({
  info,
  botId,
}: {
  info: DispatchInfo
  botId: number | null
}) {
  const t = useTranslations("PersonalAgent")
  const openRoutineEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("routines.more")}
          title={t("routines.more")}
          data-pa-work-menu
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem
          onSelect={() =>
            openRoutineEditor({
              botId,
              routineId: null,
              draft: weeklyDraft(info),
              noticeId: null,
            })
          }
          data-pa-weekly
        >
          <Repeat aria-hidden />
          {t("event.makeRoutine")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The whole of a result's text, as the message's markdown. */
function WholeText({ text }: { text: string }) {
  return (
    <div data-pa-result className={cn("break-words", MARKDOWN_LIST_ROOM)}>
      <JsonRenderScope>
        <MessageResponse
          parseIncompleteMarkdown
          className={cn("text-sm", BUBBLE_MARKDOWN)}
        >
          {text}
        </MessageResponse>
      </JsonRenderScope>
    </div>
  )
}

/** The result's text, folded to its gist until asked for (A1): the gist in a
 *  line or two and the way to the whole — and, once a reply said what came
 *  of it (`covered`), the way to the whole alone, the gist and the note it
 *  ended with folded in with the text. Opened, it stays open while the
 *  list holds the card, kept by row in the store. A text that is itself
 *  the point (`whole`: a check's evidence) shows until a reply said it. */
function ResultText({
  rowId,
  gist,
  note,
  text,
  covered,
  whole = false,
  unfolded = false,
}: {
  rowId: number
  gist: string | null
  /** The note it ended with (a failure's reason). */
  note: string | null
  text: string | null
  covered: boolean
  whole?: boolean
  /** A card folded to a line, opened (D8): its whole text shows, and the
   *  way back is the card's own. */
  unfolded?: boolean
}) {
  const t = useTranslations("PersonalAgent.event")
  const asked = usePersonalAgentUi((s) => s.openResults[rowId] === true)
  const setOpen = usePersonalAgentUi((s) => s.setResultOpen)
  if (unfolded) {
    if (!note && !(text ?? gist)) return null
    return (
      <SheetPart className="flex flex-col gap-1.5" data-pa-result-text>
        {note ? (
          <p className="text-xs break-words text-muted-foreground">{note}</p>
        ) : null}
        {text ? (
          <WholeText text={text} />
        ) : gist ? (
          <p className="text-sm leading-5 break-words text-foreground">
            {gist}
          </p>
        ) : null}
      </SheetPart>
    )
  }
  const leads = whole && !covered
  const open = asked || leads
  const folded = covered && !open
  // Nothing more to open: the gist is the whole of it.
  const more = text != null && text.trim() !== "" && text.trim() !== gist
  if (folded && !more && !gist && !note) return null
  return (
    <SheetPart className="flex flex-col gap-1.5" data-pa-result-text>
      {note && !folded ? (
        <p className="text-xs break-words text-muted-foreground">{note}</p>
      ) : null}
      {gist && !folded && !open ? (
        <p
          className={cn(
            "text-sm leading-5 break-words text-foreground",
            // Cut only when the whole is a click away.
            more && "line-clamp-2"
          )}
          data-pa-gist
        >
          {gist}
        </p>
      ) : null}
      {/* A text that leads shows as a result always did, cut at a few lines;
          one the owner opened shows whole — the click was for all of it. */}
      {leads && text ? <CollapsedText text={text} /> : null}
      {asked && text ? <WholeText text={text} /> : null}
      {!leads && (more || (covered && (gist || note))) ? (
        <button
          type="button"
          onClick={() => setOpen(rowId, !open)}
          aria-expanded={open}
          data-pa-show-text
          className="inline-flex items-center gap-0.5 self-start rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {open ? t("hideText") : t("showText")}
          {open ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </SheetPart>
  )
}

export function EventCard({ item }: { item: EventItem }) {
  const t = useTranslations("PersonalAgent")
  const { dispatchById, botId } = usePersonalAgent()
  const { readOnly, jumpTo, agentName } = usePageScope()
  const otherAssistant = useOtherAssistant()
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const row = item.row
  const data = row.data
  const info =
    row.dispatch_id != null ? dispatchById.get(row.dispatch_id) : undefined
  // How the work stood when the news came, not how it stands now: the news
  // from before a follow-up still says the work went to review.
  const state = asDispatchState(data?.state)
  // Where it stood on the PR ladder then (8.5); older news says its state.
  const newsLadder = asLadder(data?.ladder)
  const mode = info?.mode ?? asMode(data?.mode)
  const excerpt = str(data, "excerpt")
  const cause = str(data, "cause")
  const rawNote = str(data, "note")
  const stoppedWords = useStoppedWords()
  const note =
    cause === "stopped"
      ? stoppedWords(str(data, "stopped_by"), str(data, "reason"), agentName)
      : rawNote && cause && OWN_NOTES.has(cause)
        ? t(`event.note.${cause}` as "event.note.boot")
        : rawNote
  const title = info?.title ?? str(data, "title") ?? row.body
  const retry = useRetryLine()(data?.auto_retry)
  // Taken over by new work (B1): who, and a way to it.
  const replacedBy = asReplacedBy(data?.replaced_by)
  const target = workTargetOf(info, row)
  const unread = row.read_at == null
  // The acceptance check of other work (7.5): its verdict, and its evidence
  // as the text.
  const checkFor = num(data, "check_for")
  const checkRound = num(data, "check_round")
  const verdict = asVerdict(data?.verdict)
  const evidence = str(data, "evidence")
  const shown = checkFor != null && evidence ? evidence : excerpt
  // What came of it in a sentence (A1), as the server read it; a check's
  // verdict says it, its evidence is the text.
  const gist = checkFor == null ? str(data, "gist") : null
  // Another assistant's work (handed over) is named so; its own is not.
  const by = otherAssistant(info)
  // The commit it landed as, on the news of the merge (A5).
  const mergeCommit = newsLadder === "merged" ? str(data, "merge_commit") : null
  const mergedAs = mergeCommit ? mergeCommit.slice(0, 7) : null
  // The task card, on the latest news of its work: where it stands now,
  // said again on the strip when the row above says otherwise.
  const strip = item.latest && info?.task ? info : null
  const answered = item.latest && info ? info.answered_for_you : 0
  const weekly =
    item.latest &&
    info &&
    info.state === "completed" &&
    checkFor == null &&
    info.routine_id == null &&
    !readOnly
      ? info
      : null
  // Its acceptance, folded into it as its head (A4).
  const acceptance = item.acceptance
  // The pills of its work that made way for it (P6.3 5): what done looks
  // like, as the work's own pill said it (not a follow-up's).
  const origin = item.pills.find((p) => p.data?.followup !== true) ?? null
  const doneWhen = origin
    ? (info?.done_when ?? str(origin.data, "done_when"))
    : null
  // Folded to a line (D8): news a reply reported, of work in a chat or a
  // session — not a board task's, a check's, a work's head with its
  // acceptance, nor an automatic retry that failed since (why is said on
  // it alone); and every stop. Opened, the whole card; closed, the line.
  const autoRetry = data?.auto_retry
  const retryFailed =
    autoRetry != null &&
    typeof autoRetry === "object" &&
    (autoRetry as { state?: unknown }).state === "failed"
  const stopped = cause === "stopped"
  const foldable =
    checkFor == null &&
    acceptance == null &&
    (stopped || (item.covered && mode !== "task" && !retryFailed))
  const unfolded = usePersonalAgentUi((s) => s.openResults[row.id] === true)
  const setUnfolded = usePersonalAgentUi((s) => s.setResultOpen)
  const folded = foldable && !unfolded
  const actions = {
    rowId: row.id,
    text:
      [str(data, "title"), excerpt].filter(Boolean).join("\n\n") || row.body,
    at: row.created_at,
  }
  if (folded) {
    return (
      <MessageRow
        rowId={row.id}
        side="start"
        gap={item.gap}
        tail={item.tail}
        roomy
        actions={actions}
        aside={unread ? <UnreadMark /> : null}
      >
        <CardMessage data-pa-event-card data-pa-event-line>
          <div className="flex min-w-0 items-center gap-1 px-3 py-1.5">
            <button
              type="button"
              aria-expanded={false}
              data-pa-event-unfold
              onClick={() => setUnfolded(row.id, true)}
              className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <StateIcon state={state} />
              <span className="min-w-0 truncate font-medium text-foreground">
                {title}
              </span>
              <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
                {stopped && note
                  ? note
                  : state
                    ? t(`state.${state}` as "state.completed")
                    : null}
              </span>
              <ChevronDown
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
            </button>
            {weekly ? <WorkMenu info={weekly} botId={botId} /> : null}
          </div>
        </CardMessage>
      </MessageRow>
    )
  }
  const facts =
    !!doneWhen?.trim() ||
    strip != null ||
    answered > 0 ||
    retry != null ||
    replacedBy != null ||
    checkFor != null ||
    acceptance != null
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={actions}
      aside={unread ? <UnreadMark /> : null}
    >
      {/* The work and its news one card, no bubble round it: the work its
          head — the way to the reply it answers at the end of its line,
          when that is not the message above (A2) — then where it stands,
          what came of it and its buttons, a hairline between. */}
      <CardMessage data-pa-event-card>
        <WorkRow
          flat
          mode={mode}
          title={title}
          // The commit a merge landed as ends the line under the title
          // (A5), where a narrow card cuts it rather than the menu.
          meta={[
            meta({
              by,
              mode,
              folder: info?.folder_name ?? null,
            }),
            mergedAs,
          ]
            .filter(Boolean)
            .join(" · ")}
          menu={
            weekly || foldable ? (
              <>
                {weekly ? <WorkMenu info={weekly} botId={botId} /> : null}
                {foldable ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t("event.fold")}
                    title={t("event.fold")}
                    aria-expanded
                    data-pa-event-fold
                    onClick={() => setUnfolded(row.id, false)}
                  >
                    <ChevronUp aria-hidden className="size-4" />
                  </Button>
                ) : null}
              </>
            ) : null
          }
          source={
            row.reply_to != null && !item.quotesPrevious
              ? {
                  label: t("event.source"),
                  onClick: () => jumpTo(row.reply_to!),
                }
              : null
          }
          chip={
            newsLadder ? (
              <LadderChip ladder={newsLadder} />
            ) : (
              <DispatchStateChip state={state} />
            )
          }
          onOpen={canOpenWork(target) ? () => openWork(target) : null}
        />
        {/* Where it stands, what it said in passing, what a check found. */}
        {facts ? (
          <SheetPart className="flex flex-col gap-1.5" data-pa-event-facts>
            {doneWhen ? <DoneWhen text={doneWhen} /> : null}
            {strip ? (
              <TaskStrip d={strip} chip={newsLadder !== strip.ladder} />
            ) : null}
            {answered > 0 ? <AnsweredForYou count={answered} /> : null}
            {retry ? (
              <p
                className="text-xs break-words text-muted-foreground"
                data-pa-retry
              >
                {retry}
              </p>
            ) : null}
            {replacedBy ? (
              <p
                className="text-xs break-words text-muted-foreground"
                data-pa-replaced-by={replacedBy.dispatchId}
              >
                {replacedBy.rowId != null ? (
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-foreground hover:underline focus-visible:underline"
                    onClick={() => jumpTo(replacedBy.rowId!)}
                  >
                    {t("event.replacedBy", { title: replacedBy.title })}
                  </button>
                ) : (
                  t("event.replacedBy", { title: replacedBy.title })
                )}
              </p>
            ) : null}
            {checkFor != null ? (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-pa-check-result={verdict ?? ""}
              >
                <CheckLabel round={checkRound} />
                {data?.verdict !== undefined && data?.verdict !== null ? (
                  <VerdictChip verdict={verdict} />
                ) : null}
              </div>
            ) : null}
            {acceptance ? (
              <AcceptanceFacts
                fold={acceptance}
                now={item.latest ? (info ?? null) : null}
              />
            ) : null}
          </SheetPart>
        ) : null}
        {/* What came of it: its gist, the note it ended with, the way to
            the whole text. */}
        <ResultText
          rowId={row.id}
          gist={gist}
          note={note}
          text={shown}
          // The news of a merge is the work's head alone (A5): what came of
          // the work its earlier card said, and the owner merged it.
          covered={item.covered || newsLadder === "merged"}
          whole={checkFor != null}
          unfolded={foldable}
        />
        {/* The task card's buttons, and [Stop] for the work while it moves
            — on its latest news only. */}
        <EventActions
          strip={strip}
          live={item.latest ? (info ?? null) : null}
        />
      </CardMessage>
    </MessageRow>
  )
}

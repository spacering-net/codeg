"use client"

import { useEffect, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, Loader2 } from "lucide-react"

import { MessageNavList } from "@/components/message/conversation-message-nav"
import { getPriorityKey, getStatusKey } from "@/components/message/plan-card"
import { SessionViewerHost } from "@/components/message/session-viewer-host"
import { useSessionDetailsSectionOpen } from "@/lib/session-details-prefs"
import type { PlanEntryInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  demandTranscriptNav,
  useTranscriptInsightsPart,
} from "@/stores/transcript-insights-store"

interface SessionDetailsInsightsProps {
  /** The active tab's runtime conversation id (`runtimeConversationId ??
   *  conversationId`) — the key its transcript publishes under. */
  conversationId: number | null
  /** The panel and this tab are on screen. The navigator's rows are only
   *  computed while they are. */
  active: boolean
}

/**
 * The part of the Session Details side panel that follows the conversation's
 * transcript: the agent's plan and the message navigator, whose messages carry
 * the sub-agents they started and the files they changed — what the
 * conversation page used to stack as chips over the messages' top inline-start
 * corner. The transcript derives them and publishes them to the insights store
 * (see `MessageListView`'s `insightsInSidebar`); each section reads its own
 * part and renders nothing while that part is empty.
 *
 * Both lay their rows, headers included, on one grid: a left column of fixed
 * width — the headers' chevrons, the plan's step icons, the navigator's
 * message numbers — and the text beside it.
 *
 * The navigator's sub-agent cards open their "查看会话" drawer through a host
 * of their own: the transcript's host is in another branch of the tree, and
 * keeping the drawer here rather than in a card means a card leaving the list
 * doesn't close it. File rows use it too, to open a file beside the transcript
 * on routes that cover the workspace's file column.
 */
export function SessionDetailsInsights({
  conversationId,
  active,
}: SessionDetailsInsightsProps) {
  return (
    // The sections are the tab's own children, spaced like the rest of it.
    <SessionViewerHost>
      <PlanSection conversationId={conversationId} />
      <MessageNavSection conversationId={conversationId} active={active} />
    </SessionViewerHost>
  )
}

/**
 * A section of the panel: a header row — the chevron that folds it, then its
 * title and a summary of what it holds — then its body. The chevron takes the
 * rows' left column, over their step icons and message numbers, so the title
 * lines up with the text of the rows under it. The body renders in either
 * state: what a section still shows while folded is its own business. A
 * `sticky` header stays at the top of the panel while the section scrolls
 * under it.
 */
function InsightsSection({
  title,
  summary,
  open,
  onOpenChange,
  sticky = false,
  children,
}: {
  title: string
  summary: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  sticky?: boolean
  children: ReactNode
}) {
  return (
    <section className="min-w-0">
      <h3
        className={cn(
          "min-w-0",
          // Edge to edge over the panel's padding, so rows scrolling under it
          // never show at its sides.
          sticky && "ws-surface sticky top-0 z-10 -mx-3 px-3"
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="group/section flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
            <ChevronDown
              className={cn(
                "size-3.5 text-muted-foreground transition-transform group-hover/section:text-foreground",
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
          </span>
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {summary}
          </span>
        </button>
      </h3>
      {children}
    </section>
  )
}

/** The plan's progress, one segment per step: done, under way, to do. */
function PlanProgress({ entries }: { entries: readonly PlanEntryInfo[] }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "mt-0.5 mb-1.5 flex",
        entries.length > 12 ? "gap-0.5" : "gap-1"
      )}
    >
      {entries.map((entry, index) => (
        <span
          key={index}
          data-plan-segment={entry.status}
          className={cn(
            "h-1 min-w-0 flex-1 rounded-full",
            entry.status === "completed"
              ? "bg-emerald-500"
              : entry.status === "in_progress"
                ? "bg-blue-500"
                : "bg-muted-foreground/15"
          )}
        />
      ))}
    </div>
  )
}

function PlanStepIcon({
  status,
  streaming,
}: {
  status: string
  streaming: boolean
}) {
  if (status === "completed") {
    return (
      <span className="flex size-3.5 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  if (status === "in_progress") {
    // Spinning only while the agent is at work; a reply that stopped leaves
    // the step it was on marked, not moving.
    return streaming ? (
      <Loader2 className="size-3.5 animate-spin text-blue-500" />
    ) : (
      <span className="flex size-3.5 items-center justify-center rounded-full border-[1.5px] border-blue-500">
        <span className="size-1.5 rounded-full bg-blue-500" />
      </span>
    )
  }
  return (
    <span className="size-3.5 rounded-full border-[1.5px] border-muted-foreground/35" />
  )
}

/** Plan steps, one line each, the whole step — with its status and priority
 *  — in its tooltip. The step under way is tinted. */
function PlanSteps({
  entries,
  streaming,
}: {
  entries: readonly PlanEntryInfo[]
  streaming: boolean
}) {
  const t = useTranslations("Folder.chat.agentPlanOverlay")
  return (
    <ul className="space-y-px">
      {entries.map((entry, index) => {
        const status = t(getStatusKey(entry.status))
        const priority = t(getPriorityKey(entry.priority))
        return (
          <li
            key={`${entry.content}-${index}`}
            title={`${entry.content}\n${status} · ${priority}`}
            className={cn(
              "-mx-1.5 flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5",
              entry.status === "in_progress" && "bg-blue-500/[0.08]"
            )}
          >
            <span
              aria-hidden="true"
              className="flex w-7 shrink-0 justify-center"
            >
              <PlanStepIcon status={entry.status} streaming={streaming} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[0.8125rem]",
                entry.status === "completed"
                  ? "text-muted-foreground line-through decoration-muted-foreground/40"
                  : entry.status === "in_progress"
                    ? "font-medium text-foreground"
                    : "text-foreground/85"
              )}
            >
              {entry.content}
            </span>
            <span className="sr-only">{status}</span>
          </li>
        )
      })}
    </ul>
  )
}

function PlanSection({ conversationId }: { conversationId: number | null }) {
  const t = useTranslations("Folder.chat.agentPlanOverlay")
  const plan = useTranscriptInsightsPart(conversationId, (i) => i.plan)
  const [open, setOpen] = useSessionDetailsSectionOpen("plan")
  if (plan == null || plan.entries.length === 0) return null
  const completed = plan.entries.filter(
    (entry) => entry.status === "completed"
  ).length
  // Folded, the plan still shows how far it has come and the step under way:
  // what the agent is doing now.
  const steps = open
    ? plan.entries
    : plan.entries.filter((entry) => entry.status === "in_progress")
  return (
    <InsightsSection
      title={t("title")}
      summary={`${completed}/${plan.entries.length}`}
      open={open}
      onOpenChange={setOpen}
    >
      <PlanProgress entries={plan.entries} />
      {steps.length > 0 && (
        <PlanSteps entries={steps} streaming={plan.streaming} />
      )}
    </InsightsSection>
  )
}

function MessageNavSection({
  conversationId,
  active,
}: {
  conversationId: number | null
  active: boolean
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const nav = useTranscriptInsightsPart(conversationId, (i) => i.nav)
  const actions = useTranscriptInsightsPart(conversationId, (i) => i.actions)
  const [open, setOpen] = useSessionDetailsSectionOpen("messageNav")
  const count = nav?.count ?? 0
  // Ask the transcript for the rows only while they are on screen: building
  // them parses every turn's diffs.
  const showRows = active && open && count > 0
  useEffect(() => {
    if (!showRows || conversationId == null) return
    return demandTranscriptNav(conversationId)
  }, [showRows, conversationId])
  if (nav == null || actions == null || count === 0) return null
  return (
    <InsightsSection
      title={t("title")}
      summary={count}
      open={open}
      onOpenChange={setOpen}
      sticky
    >
      {open && (
        <MessageNavList
          // What is open is one conversation's: turn ids repeat across
          // conversations.
          key={conversationId}
          entries={nav.entries}
          onSelect={actions.selectNavEntry}
          revealingTurnId={nav.revealingTurnId}
          currentTurnId={nav.currentTurnId}
          earlier={nav.earlier}
          onRetryEarlier={actions.retryEarlierNav}
        />
      )}
    </InsightsSection>
  )
}

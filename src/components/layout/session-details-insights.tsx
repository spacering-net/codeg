"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Check,
  ChevronDown,
  ListChecks,
  Loader2,
  MessageCircleQuestionMark,
  MessagesSquare,
  ShieldCheck,
  Unlink,
} from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { useDetachAskConversation } from "@/components/conversations/use-detach-ask-conversation"
import { MessageNavList } from "@/components/message/conversation-message-nav"
import { useIdentityAssistant } from "@/components/message/delegation-identity"
import { BotAvatar } from "@/components/personal-agent/bot-avatar"
import { getPriorityKey, getStatusKey } from "@/components/message/plan-card"
import { SessionViewerHost } from "@/components/message/session-viewer-host"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  useLinkedConversations,
  type LinkedConversationKind,
} from "@/hooks/use-ask-conversations"
import { formatConversationTitle } from "@/lib/conversation-title"
import { useSessionDetailsSectionOpen } from "@/lib/session-details-prefs"
import type {
  ConversationStatus,
  DbConversationSummary,
  PlanEntryInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAskConversationDrawerStore } from "@/stores/ask-conversation-drawer-store"
import {
  demandTranscriptNav,
  useTranscriptInsightsPart,
} from "@/stores/transcript-insights-store"

interface SessionDetailsInsightsProps {
  /** The active tab's runtime conversation id (`runtimeConversationId ??
   *  conversationId`) — the key its transcript publishes under. */
  conversationId: number | null
  /** The active tab's persisted conversation id — what its ask and check
   *  conversations are linked to. */
  dbConversationId: number | null
  /** The panel and this tab are on screen. The navigator's rows are only
   *  computed while they are. */
  active: boolean
}

/**
 * The part of the Session Details side panel that follows the conversation's
 * transcript, each part a card like the summary above it: the agent's plan,
 * the ask conversations opened from it ("ask about this selection"), the
 * personal agent's checks of its messages ("is this right?") and the message
 * navigator, whose messages carry
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
  dbConversationId,
  active,
}: SessionDetailsInsightsProps) {
  return (
    // The sections are the tab's own children, spaced like the rest of it.
    <SessionViewerHost>
      <PlanSection conversationId={conversationId} />
      <LinkedConversationsSection
        kind="ask"
        parentConversationId={dbConversationId}
      />
      <LinkedConversationsSection
        kind="check"
        parentConversationId={dbConversationId}
      />
      <MessageNavSection conversationId={conversationId} active={active} />
    </SessionViewerHost>
  )
}

/** The panel's cards: the summary card's tint, hairline and corners. */
const CARD = "min-w-0 rounded-xl border border-border/70 bg-muted/40"

/** A card's own colour (its `bg-muted/40` over the page), for the ring that
 *  cuts a status dot out of the icon it sits on. */
const CARD_RING =
  "ring-[color-mix(in_oklab,var(--muted)_40%,var(--background))]"

/**
 * A section of the panel, as a card: a header row — the section's icon and
 * title, then at its end a summary of what it holds and the chevron that
 * folds it — then its body. The icon takes the rows' left column, over their
 * step icons and message numbers, so the title lines up with the text of the
 * rows under it. The body renders in either state: what a section still shows
 * while folded is its own business. A `sticky` header stays at the top of the
 * panel while the section scrolls under it, painted the card's colour over
 * the page's so the rows going under it don't show through.
 */
function InsightsSection({
  icon,
  title,
  summary,
  open,
  onOpenChange,
  sticky = false,
  children,
}: {
  icon: ReactNode
  title: string
  summary: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  sticky?: boolean
  children: ReactNode
}) {
  return (
    <section className={cn(CARD, "px-3 pt-1", open ? "pb-2" : "pb-1")}>
      <h3
        className={cn(
          "min-w-0",
          // Across the card's padding, so rows scrolling under it never show
          // at its sides; rounded with the card's inner corners.
          sticky &&
            "ws-surface sticky top-0 z-10 -mx-3 rounded-t-[calc(var(--radius-lg)-1px)]"
        )}
      >
        <span
          className={cn(
            "block",
            sticky && "rounded-[inherit] bg-muted/40 px-3"
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
            className="group/section flex h-9 w-full min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              className="flex w-7 shrink-0 justify-center text-foreground [&>svg]:size-4"
            >
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground">
              {title}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums transition-colors group-hover/section:text-foreground">
              {summary}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "me-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/section:text-foreground",
                // Folded it points along the line, at the end it sits at;
                // open, down at what it shows.
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
          </button>
        </span>
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
      icon={<ListChecks />}
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

/** What each list of `LinkedConversationsSection` is called and drawn by. */
const LINKED_SECTION = {
  ask: {
    namespace: "Folder.askConversations",
    icon: <MessageCircleQuestionMark />,
    pref: "askConversations",
  },
  check: {
    namespace: "Folder.checkConversations",
    icon: <ShieldCheck />,
    pref: "checkConversations",
  },
} as const

/**
 * The conversations linked to this one, newest first — the same rows the
 * sidebar nests under it: the asks opened from its transcript ("ask about this
 * selection"), or the personal agent's checks of its messages ("is this
 * right?"), a card each. A row opens its conversation in the ask drawer to go
 * on with it (or watch it), and its button turns it into an ordinary
 * conversation, which moves it to the root of the sidebar. Renders nothing
 * while there are none.
 */
function LinkedConversationsSection({
  kind,
  parentConversationId,
}: {
  kind: LinkedConversationKind
  parentConversationId: number | null
}) {
  const section = LINKED_SECTION[kind]
  // The words of converting, and its dialog's, are the asks' for both.
  const t = useTranslations("Folder.askConversations")
  const tSection = useTranslations(section.namespace)
  const asks = useLinkedConversations(parentConversationId, kind)
  const [open, setOpen] = useSessionDetailsSectionOpen(section.pref)
  const openExisting = useAskConversationDrawerStore((s) => s.openExisting)
  const openId = useAskConversationDrawerStore(
    (s) => s.target?.conversationId ?? null
  )
  const detach = useDetachAskConversation()
  // The row to confirm converting, kept after the dialog closes so its text
  // doesn't empty out while it animates away.
  const [confirming, setConfirming] = useState<{
    id: number
    title: string
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The section outlives a switch to another tab — it is handed the new
  // tab's conversation — so a confirmation left open belongs to the last
  // one: drop it rather than let it convert that conversation's row from here.
  const [confirmParentId, setConfirmParentId] = useState(parentConversationId)
  if (confirmParentId !== parentConversationId) {
    setConfirmParentId(parentConversationId)
    setConfirmOpen(false)
    setConfirming(null)
  }
  if (parentConversationId == null || asks == null || asks.length === 0) {
    return null
  }
  const handleOpen = (ask: DbConversationSummary) => {
    const opened = openExisting({
      kind,
      parentConversationId,
      conversationId: ask.id,
      agentType: ask.agent_type,
      folderId: ask.folder_id,
      // The folder list resolves the cwd by id; this is only its fallback.
      workingDir:
        useAppWorkspaceStore
          .getState()
          .allFolders.find((folder) => folder.id === ask.folder_id)?.path ??
        null,
    })
    if (!opened) toast.warning(t("pendingFirstMessage"))
  }
  return (
    <InsightsSection
      icon={section.icon}
      title={tSection("title")}
      summary={t("total", { count: asks.length })}
      open={open}
      onOpenChange={setOpen}
    >
      {open && (
        <ul className="space-y-px">
          {asks.map((ask) => {
            const title =
              formatConversationTitle(ask.title) || tSection("untitled")
            const status = ask.status as ConversationStatus
            return (
              <li
                key={ask.id}
                className={cn(
                  "group/ask -mx-1.5 flex h-7 min-w-0 items-center rounded-md transition-colors hover:bg-foreground/[0.06]",
                  openId === ask.id && "bg-foreground/[0.06]"
                )}
              >
                {/* The agent's icon — the assistant's avatar, for a row run as
                    one — takes the header icon's column, its status a dot on
                    its corner as the summary card draws it, so the title lines
                    up with the section's. */}
                <button
                  type="button"
                  title={title}
                  onClick={() => handleOpen(ask)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md ps-1.5 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span
                    aria-hidden="true"
                    className="flex w-7 shrink-0 justify-center"
                  >
                    <span className="relative flex">
                      <LinkedRowIcon conversation={ask} />
                      <ConversationStatusDot
                        status={status}
                        size="sm"
                        className={cn(
                          "absolute -end-0.5 -bottom-0.5 ring-2",
                          CARD_RING,
                          status === "in_progress" &&
                            "motion-safe:animate-pulse"
                        )}
                      />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/85">
                    {title}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t("convertToRegular")}
                  title={t("convertToRegular")}
                  onClick={() => {
                    setConfirming({ id: ask.id, title })
                    setConfirmOpen(true)
                  }}
                  className="me-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover/ask:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 [@media(hover:none)]:opacity-100"
                >
                  <Unlink className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <AlertDialog
        open={confirmOpen && confirming != null}
        onOpenChange={setConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("convertConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("convertConfirmDescription", {
                title: confirming?.title ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) detach(confirming.id)
              }}
            >
              {t("convertConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </InsightsSection>
  )
}

/** A linked conversation's icon: the assistant it ran as, else its agent. */
function LinkedRowIcon({
  conversation,
}: {
  conversation: DbConversationSummary
}) {
  const ranAs =
    conversation.assistant_id != null || conversation.bot_uid != null
  return ranAs ? (
    <LinkedRowAssistantAvatar conversation={conversation} />
  ) : (
    <AgentIcon agentType={conversation.agent_type} className="size-4" />
  )
}

function LinkedRowAssistantAvatar({
  conversation,
}: {
  conversation: DbConversationSummary
}) {
  const assistant = useIdentityAssistant({
    assistantId: conversation.assistant_id ?? null,
    botUid: conversation.bot_uid ?? null,
  })
  return (
    <BotAvatar
      avatar={assistant?.avatar ?? null}
      name={assistant?.name ?? conversation.assistant_name ?? ""}
      size={16}
    />
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
      icon={<MessagesSquare />}
      title={t("title")}
      summary={t("total", { count })}
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
          running={nav.running}
          earlier={nav.earlier}
          onRetryEarlier={actions.retryEarlierNav}
        />
      )}
    </InsightsSection>
  )
}

"use client"

/**
 * Small pieces the personal agent's page, its message list and its panel
 * share: reading a row's JSON, the dispatch states as chips, the unread
 * mark, an executor's avatar and the line that says who runs a piece of work
 * where, and opening the work a card points at — in the drawer on the
 * right, or out of the page (the board, a conversation tab).
 */

import { createContext, useContext } from "react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar as AvatarDisc } from "@/components/assistants/assistant-avatar"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import type {
  AgentType,
  DispatchInfo,
  DispatchMode,
  DispatchState,
  TimelineRow,
} from "@/lib/types"
import { defaultAvatarFor } from "@/lib/assistant-avatar"
import { cn } from "@/lib/utils"
import { requestTasksFocus } from "@/lib/workbench-focus"
import { useAssistant } from "@/stores/assistants-store"
import {
  usePersonalAgentUi,
  type WorkTarget,
} from "@/stores/personal-agent-ui-store"

export function str(
  data: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const v = data?.[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

export function num(
  data: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const v = data?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

const DISPATCH_STATES: readonly DispatchState[] = [
  "queued",
  "running",
  "waiting_input",
  "review",
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "handed_over",
]

export function asDispatchState(v: unknown): DispatchState | null {
  return typeof v === "string" && DISPATCH_STATES.includes(v as DispatchState)
    ? (v as DispatchState)
    : null
}

export function asMode(v: unknown): DispatchMode | null {
  return v === "task" || v === "chat" || v === "session" ? v : null
}

/** A dispatch state as a tone, shared by the cards and the panels. */
export function dispatchTone(state: DispatchState | null): string {
  switch (state) {
    case "running":
    case "queued":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    case "waiting_input":
    case "review":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "failed":
    case "interrupted":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

/** A dispatch state in a word, on its tone: one chip for the cards, the
 *  news and the panel. Work still moving pulses a dot before the word. */
export function StateChip({
  state,
  children,
  className,
}: {
  state: DispatchState
  /** The word, and anything after it (an elapsed time). */
  children: React.ReactNode
  className?: string
}) {
  const live = state === "running" || state === "queued"
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap",
        dispatchTone(state),
        className
      )}
    >
      {live ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {children}
    </span>
  )
}

export function DispatchStateChip({
  state,
  children,
}: {
  state: DispatchState | null
  /** Drawn after the state's name (an elapsed time). */
  children?: React.ReactNode
}) {
  const t = useTranslations("PersonalAgent.state")
  if (!state) return null
  return (
    <StateChip state={state}>
      {t(state)}
      {children}
    </StateChip>
  )
}

/** "Unread" with its dot: beside a message the assistant has not started
 *  on yet, toward the middle of the list, at the message's foot. */
export function UnreadMark() {
  const t = useTranslations("PersonalAgent.owner")
  return (
    <span className="inline-flex items-center gap-1 text-[0.6875rem] leading-4 text-muted-foreground">
      <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      {t("unread")}
    </span>
  )
}

/** What the agent is doing, in a word: the page's title, the panel's status
 *  tab. */
export function useStatusWord(): string | null {
  const t = useTranslations("PersonalAgent.statusWord")
  const { snapshot, needsOwner } = usePersonalAgent()
  if (!snapshot?.agent) return null
  const status = snapshot.status
  if (status.engine !== "here") return t("elsewhere")
  if (needsOwner) return t("waiting")
  if (status.turn?.kind === "compaction") return t("compacting")
  if (status.turn) return t("replying")
  return t("idle")
}

/** Who runs a piece of work and where, as one quiet line: "Builder · Kanban
 *  task · my-app". */
export function useWorkMeta(): (parts: {
  executor: string | null
  mode: DispatchMode | null
  folder: string | null
}) => string {
  const t = useTranslations("PersonalAgent.mode")
  return ({ executor, mode, folder }) =>
    [executor, mode ? t(mode) : null, folder].filter(Boolean).join(" · ")
}

/** The surface of the assistant's bubbles and of the news cards: a plain
 *  light grey with no border, whatever the theme's colour (the owner's
 *  bubbles carry that); what sits inside takes its `--pa-inset` wash
 *  (globals.css). */
export const AGENT_SURFACE = "pa-agent-bubble"

/** A surface inside a bubble — a work row, a work pill: the bubble's colour
 *  a step deeper; and, for one that can be clicked, a step deeper again
 *  under the pointer and when pressed. A control with no surface of its
 *  own (a text button) takes `INSET_HOVER` alone. */
export const INSET_SURFACE = "bg-(--pa-inset)"
export const INSET_HOVER =
  "hover:bg-(--pa-inset-hover) active:bg-(--pa-inset-active)"

/** Markdown lists inside a bubble or a box that clips: room for the
 *  bullets and numbers, which hang outside the text (the conversation's
 *  own 0.5rem would put them on the edge, or past it). */
export const MARKDOWN_LIST_ROOM = "[&_ol]:ps-5 [&_ul]:ps-4"

/** Markdown at a bubble's scale, on the Streamdown root (the classes reach
 *  its blocks as `&>*`). Streamdown spaces it for the full chat column — a
 *  1rem gap between blocks, 4px around each list item, an `h2` at
 *  `text-2xl` with 24px above it, inline code at the text's own size, so
 *  monospace looks a size up — all too loud among a bubble's short 14px
 *  lines. A descendant selector outranks the class Streamdown puts on the
 *  element, as the board's result panel does. */
export const BUBBLE_MARKDOWN =
  "[&>*:not(:last-child)]:mb-2.5 [&_li]:py-0.5 " +
  "[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:text-[0.9em] " +
  "[&_h1]:text-base [&_h2]:text-[0.9375rem] [&_h3]:text-sm [&_h4]:text-sm " +
  "[&_h1]:mt-3.5 [&_h2]:mt-3.5 [&_h3]:mt-3 [&_h4]:mt-3 " +
  "[&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1"

/** A length given in px at 100% zoom, as rem (app zoom scales the root font
 *  size). */
function rem(px: number): string {
  return `${px / 16}rem`
}

/** The agent's mark at the foot of an executor's avatar of `size` px (at
 *  100% zoom): a disc about seven sixteenths of it — 14px on a 32px avatar —
 *  standing out past the avatar's corner by a sixteenth, so its centre sits
 *  on the avatar's rim; and the hole cut around it in the avatar, 1.5px
 *  wider. `center` is the centre's distance from the avatar's bottom and
 *  end edges. */
function badgeOf(size: number) {
  const disc = Math.round((size * 7) / 16)
  const out = size / 16
  return { disc, out, center: disc / 2 - out, hole: disc / 2 + 1.5 }
}

/** The avatar of the assistant that ran a piece of work, as it is now (a
 *  deleted one is still known); one this window never saw draws the
 *  monogram of the name it was dispatched under. With the agent it runs on,
 *  that agent's mark sits at the avatar's bottom end corner, in a hole cut
 *  around it (globals.css), so the two read apart on any surface — a card's
 *  well, a translucent bubble over a workspace image. */
export function ExecutorAvatar({
  id,
  name,
  agentType,
  size,
  className,
}: {
  id: number | null
  name: string | null
  /** The agent it runs on: its mark at the avatar's foot. */
  agentType?: AgentType | null
  /** In px at 100% zoom. */
  size: number
  className?: string
}) {
  const known = useAssistant(id)
  const shown = known?.name ?? name ?? ""
  const disc = (
    <AvatarDisc
      avatar={known?.avatar ?? (shown ? defaultAvatarFor(shown) : null)}
      name={shown}
      size={size}
      className={agentType ? undefined : className}
    />
  )
  if (!agentType) return disc
  const badge = badgeOf(size)
  return (
    <span
      data-pa-badged
      className={cn("relative inline-flex shrink-0", className)}
      style={
        {
          "--pa-badge-center": rem(badge.center),
          "--pa-badge-hole": rem(badge.hole),
        } as React.CSSProperties
      }
    >
      {disc}
      {/* The agent's name is on the mark's own title (the icons carry one),
          for a pointer; the line beside the avatar names the assistant. */}
      {/* No disc of its own under the mark: the surface around the avatar
          shows through the hole (a card's white disc was a white spot on a
          bubble's grey). */}
      <span
        data-pa-agent-badge
        aria-hidden
        className="absolute inline-flex items-center justify-center rounded-full"
        style={{
          width: rem(badge.disc),
          height: rem(badge.disc),
          bottom: rem(-badge.out),
          insetInlineEnd: rem(-badge.out),
        }}
      >
        <AgentIcon agentType={agentType} className="size-[72%]" />
      </span>
    </span>
  )
}

/** The work a card points at, from the dispatch as it is now when the page
 *  has it, else from what the card's row recorded. */
export function workTargetOf(
  info: DispatchInfo | undefined,
  row?: TimelineRow | null
): WorkTarget {
  const data = row?.data
  return {
    dispatchId: info?.id ?? row?.dispatch_id ?? null,
    mode: info?.mode ?? asMode(data?.mode),
    workTaskId: info?.work_task_id ?? num(data, "work_task_id"),
    conversationId: info?.conversation_id ?? num(data, "conversation_id"),
    // A chat dispatch's conversation sits in its own hidden chat folder.
    folderId:
      info?.conversation_folder_id ??
      info?.folder_id ??
      num(data, "conversation_folder_id") ??
      num(data, "folder_id"),
    agentType:
      info?.executor.agent_type ??
      (str(data, "agent_type") as AgentType | null),
    title: info?.title ?? str(data, "title") ?? (row?.body || null),
    executorId: info?.executor.assistant_id ?? num(data, "executor_id"),
    executorName: info?.executor.name ?? str(data, "executor"),
    prompt: info?.prompt ?? null,
    connectionId: info?.connection_id ?? null,
    state: info?.state ?? asDispatchState(data?.state),
  }
}

/** Whether there is anything to open: a task, or a conversation and the
 *  agent that reads it. */
export function canOpenWork(target: WorkTarget): boolean {
  return target.mode === "task"
    ? target.workTaskId != null
    : target.conversationId != null && target.agentType != null
}

/** Open the work a card points at in the drawer on the right: a task's
 *  session, or the conversation a chat or session dispatch runs in. */
export function useOpenWork(): (target: WorkTarget) => void {
  return usePersonalAgentUi((s) => s.openWork)
}

/** Take the work out of the page: the board for a task, a conversation tab
 *  (where the owner can write in it) otherwise. */
export function useOpenInWorkbench() {
  const { setRoute, openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  return (target: WorkTarget) => {
    if (target.mode === "task") {
      requestTasksFocus({ folderId: target.folderId })
      setRoute("tasks")
      return
    }
    if (target.conversationId == null || target.agentType == null) return
    if (target.folderId == null) return
    openConversations()
    openTab(target.folderId, target.conversationId, target.agentType)
  }
}

/** What the message list's rows need from the page around them. */
export interface PageScope {
  readOnly: boolean
  /** The assistant's name, for its quotes. */
  agentName: string
  /** The reply row the turn in flight writes into. */
  liveRowId: number | null
  connectionId: string | null
  agentType: AgentType | null
  /** Start a message quoting this row. */
  onQuote: (rowId: number) => void
  /** Scroll to a row (loading it first when it is older than what is held). */
  jumpTo: (rowId: number) => void
  /** The rows the page holds, by id. */
  rowsById: ReadonlyMap<number, TimelineRow>
}

export const PageScopeContext = createContext<PageScope | null>(null)

export function usePageScope(): PageScope {
  const scope = useContext(PageScopeContext)
  if (!scope) throw new Error("usePageScope outside the personal agent page")
  return scope
}

/** One line of a row's text for a quote: markdown marks and newlines out. */
export function excerptOf(text: string, max = 120): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#~|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** An assistant's name as a line or a card shows it: the primary may have
 *  none, and is then called by its role, as the page's title does. */
export function useBotName(): (
  bot: { id?: number | null; name?: string | null; kind?: string | null } | null
) => string {
  const t = useTranslations("PersonalAgent")
  return (bot) => {
    const name = bot?.name?.trim()
    if (name) return name
    if (bot?.kind === "worker" && bot.id != null) return `#${bot.id}`
    return t("title")
  }
}

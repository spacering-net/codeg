"use client"

/**
 * A piece of work handed out, in the two places the list shows it:
 * - the news about it, from the assistant that ran it, leads with the full
 *   row (`WorkRow`): that assistant's avatar with its agent's mark at its
 *   foot, what the work is, who runs it as what and where ("Builder ·
 *   Kanban task · my-app"), where it stands, and a chevron when the row
 *   opens the work's session (in the drawer on the right) — in a well of
 *   its own (`WORK_WELL`);
 * - the reply that handed it out carries a pill (`WorkPill`): who runs it
 *   (their avatar and name) and what it is, then how it stands as an icon
 *   and how long it has been going while it runs, and the same chevron — no
 *   more, as the news below says the rest.
 *
 * Both are the bubble's colour a step deeper (`INSET_SURFACE`), and a step
 * deeper again under the pointer and when pressed (`INSET_HOVER`).
 */

import { useTranslations } from "next-intl"
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  Loader2,
  MessageCircleQuestionMark,
  TriangleAlert,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react"

import type { AgentType, DispatchState } from "@/lib/types"
import { cn } from "@/lib/utils"

import { ExecutorAvatar, INSET_HOVER, INSET_SURFACE } from "./shared"

/** The well the news's row sits in, inside its bubble: its rounded clip —
 *  the row, which fills it, carries the surface and its states. */
export const WORK_WELL = "overflow-hidden rounded-xl"

/** The executor's avatar, in px at 100% zoom: as tall as the row's two
 *  lines. */
const AVATAR_SIZE = 32

/** The executor's avatar in a pill, in px at 100% zoom: 4px inside the
 *  28px pill all round, so its circle sits concentric with the pill's end. */
const PILL_AVATAR_SIZE = 20

export function WorkRow({
  executorId,
  executor,
  agentType,
  title,
  meta,
  chip,
  onOpen,
}: {
  executorId: number | null
  executor: string | null
  agentType: AgentType | null
  title: string
  /** Who runs it as what and where. */
  meta: string
  /** Where it stands. */
  chip: React.ReactNode
  /** Opens the work's session; none when there is nothing to open. */
  onOpen: (() => void) | null
}) {
  const t = useTranslations("PersonalAgent")
  return (
    <button
      type="button"
      data-pa-work
      disabled={!onOpen}
      onClick={onOpen ?? undefined}
      className={cn(
        "group/work flex w-full min-w-0 items-center gap-2.5 py-2.5 ps-2.5 pe-2 text-start transition-colors focus-visible:bg-(--pa-inset-hover) focus-visible:outline-none disabled:cursor-default",
        INSET_SURFACE,
        onOpen && INSET_HOVER
      )}
      title={onOpen ? t("timeline.viewSession") : undefined}
    >
      <ExecutorAvatar
        id={executorId}
        name={executor ?? t("event.someone")}
        agentType={agentType}
        size={AVATAR_SIZE}
      />
      <span className="min-w-0 flex-1">
        {/* Up to two lines: a long title in a narrow column (a phone) still
            reads whole, where one line would leave a stub. */}
        <span className="line-clamp-2 text-sm leading-5 font-medium break-words text-foreground">
          {title}
        </span>
        <span className="block truncate text-xs leading-5 text-muted-foreground">
          {meta}
        </span>
      </span>
      {chip}
      {onOpen ? (
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/50 transition-colors rtl:-scale-x-100",
            "group-hover/work:text-muted-foreground group-focus-visible/work:text-muted-foreground"
          )}
          aria-hidden
        />
      ) : null}
    </button>
  )
}

/** How a piece of work stands, as the icon a pill leads with. */
const STATE_ICON: Record<DispatchState, LucideIcon> = {
  queued: Clock,
  running: Loader2,
  waiting_input: MessageCircleQuestionMark,
  review: Eye,
  completed: CircleCheck,
  failed: CircleX,
  canceled: CircleSlash,
  interrupted: CircleAlert,
  handed_over: UserRoundCheck,
}

/** The colour of a state's icon, on the pill's neutral wash: the tones of
 *  the state chips (`dispatchTone`), a step stronger for a small glyph. */
function iconTone(state: DispatchState | null): string {
  switch (state) {
    case "running":
    case "queued":
      return "text-sky-600 dark:text-sky-400"
    case "waiting_input":
    case "review":
      return "text-amber-600 dark:text-amber-400"
    case "completed":
      return "text-emerald-600 dark:text-emerald-400"
    case "failed":
    case "interrupted":
      return "text-red-600 dark:text-red-400"
    default:
      return "text-muted-foreground"
  }
}

export function WorkPill({
  rowId,
  state,
  notSent,
  executorId,
  executor,
  title,
  elapsed,
  onOpen,
}: {
  /** The dispatch row it stands for: jumps to it land on the pill. */
  rowId: number
  state: DispatchState | null
  /** A follow-up that never went out: that, rather than the work's state. */
  notSent?: boolean
  executorId: number | null
  executor: string | null
  title: string
  /** How long it has been going, while it runs. */
  elapsed?: string | null
  /** Opens the work's session; none when there is nothing to open. */
  onOpen: (() => void) | null
}) {
  const t = useTranslations("PersonalAgent")
  const Icon = notSent
    ? TriangleAlert
    : state
      ? STATE_ICON[state]
      : CircleDashed
  // The state in a word: the icon's own tooltip, and what a screen reader
  // reads after the work.
  const word = notSent
    ? t("dispatchCard.notSent")
    : state
      ? t(`state.${state}` as "state.completed")
      : null
  const name = executor ?? t("event.someone")
  return (
    <button
      type="button"
      data-row-id={rowId}
      data-pa-work-pill
      disabled={!onOpen}
      onClick={onOpen ?? undefined}
      className={cn(
        "group/work inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full ps-1 pe-2.5 text-[0.8125rem] leading-5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default",
        INSET_SURFACE,
        onOpen && INSET_HOVER
      )}
      title={onOpen ? t("timeline.viewSession") : undefined}
    >
      <ExecutorAvatar id={executorId} name={name} size={PILL_AVATAR_SIZE} />
      <span className="shrink-0 font-medium text-foreground">{name}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground">
        ·
      </span>
      <span className="min-w-0 truncate text-foreground/80">{title}</span>
      <span className="ms-0.5 inline-flex shrink-0 items-center gap-1">
        <span className="inline-flex" title={word ?? undefined}>
          <Icon
            aria-hidden
            className={cn(
              "size-3.5",
              notSent ? iconTone("failed") : iconTone(state),
              state === "running" && !notSent && "motion-safe:animate-spin"
            )}
          />
        </span>
        {word ? <span className="sr-only">{word}</span> : null}
        {elapsed ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {elapsed}
          </span>
        ) : null}
      </span>
      {onOpen ? (
        <ChevronRight
          className="-ms-0.5 -me-1 size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/work:text-muted-foreground group-focus-visible/work:text-muted-foreground rtl:-scale-x-100"
          aria-hidden
        />
      ) : null}
    </button>
  )
}

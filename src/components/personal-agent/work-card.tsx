"use client"

/**
 * A piece of work handed out, in the two places the list shows it — the
 * assistant's own news, so with no one else's face or name on it:
 * - the news about it leads with the full row (`WorkRow`): how it runs (its
 *   glyph), what the work is, how and where ("Kanban task · my-app" —
 *   after the assistant's name when it is another's, handed over), where
 *   it stands, and a chevron when the row opens the work's session (in the
 *   drawer on the right) — in a well of its own (`WORK_WELL`);
 * - the reply that handed it out carries a pill (`WorkPill`): its glyph and
 *   what it is, then how it stands as an icon and how long it has been
 *   going while it runs, and the same chevron — no more, as the news below
 *   says the rest.
 *
 * Both are a thing on the bubble (`INSET_SURFACE`: a white card on its
 * grey, a wash on a card), a step deeper under the pointer and when pressed
 * (`INSET_HOVER`); a row heading a card of its own (`flat`) is that card's
 * head, no surface of its own, its padding the card's parts', the faintest
 * step under the pointer (`SHEET_ROW_HOVER`).
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

import type { DispatchMode, DispatchState } from "@/lib/types"
import { useSyncedSpin } from "@/lib/motion/synced-spin"
import { cn } from "@/lib/utils"

import {
  INSET_HOVER,
  INSET_SURFACE,
  SHEET_ROW_HOVER,
  WorkGlyph,
} from "./shared"

/** The well the news's row sits in, inside its bubble: its rounded clip —
 *  the row, which fills it, carries the surface and its states. */
export const WORK_WELL = "overflow-hidden rounded-xl"

/** The work's glyph, in px at 100% zoom: as tall as the row's two lines. */
const AVATAR_SIZE = 32

/** The work's glyph in a pill, in px at 100% zoom: 4px inside the 28px
 *  pill all round, so its circle sits concentric with the pill's end. */
const PILL_AVATAR_SIZE = 20

export function WorkRow({
  mode,
  title,
  meta,
  chip,
  onOpen,
  flat = false,
  source,
  menu,
}: {
  /** How it runs: what its glyph is. */
  mode: DispatchMode | null
  title: string
  /** How and where it runs. */
  meta: string
  /** Where it stands. */
  chip: React.ReactNode
  /** Opens the work's session; none when there is nothing to open. */
  onOpen: (() => void) | null
  /** The head of a card of its own (`PaSheet`): no surface of its own. */
  flat?: boolean
  /** The way to the message it follows up on, at the end of the line under
   *  the title (A2): a button of its own, reachable by keyboard and touch. */
  source?: { label: string; onClick: () => void } | null
  /** A menu of what else can be done with the work (a ⋯ button), after its
   *  state. */
  menu?: React.ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  if (source || menu) {
    return (
      <WorkRowWithControls
        mode={mode}
        title={title}
        meta={meta}
        chip={chip}
        onOpen={onOpen}
        flat={flat}
        source={source ?? null}
        menu={menu ?? null}
      />
    )
  }
  return (
    <button
      type="button"
      data-pa-work={flat ? "head" : ""}
      disabled={!onOpen}
      onClick={onOpen ?? undefined}
      className={cn(
        "group/work flex w-full min-w-0 items-center gap-2.5 text-start transition-colors focus-visible:outline-none disabled:cursor-default",
        flat
          ? "px-3.5 py-3"
          : "py-2.5 ps-2.5 pe-2 focus-visible:bg-(--pa-object-hover)",
        !flat && INSET_SURFACE,
        onOpen && (flat ? SHEET_ROW_HOVER : INSET_HOVER)
      )}
      title={onOpen ? t("timeline.viewSession") : undefined}
    >
      <WorkGlyph mode={mode} size={AVATAR_SIZE} />
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

/** The row with more controls on it: a button holds no other, so the row's
 *  own (opening the session) lies under it all, the full size of the row,
 *  and what the row shows sits over it, letting the pointer through — but
 *  for the way to the source and the menu, controls of their own. */
function WorkRowWithControls({
  mode,
  title,
  meta,
  chip,
  onOpen,
  flat,
  source,
  menu,
}: {
  mode: DispatchMode | null
  title: string
  meta: string
  chip: React.ReactNode
  onOpen: (() => void) | null
  flat: boolean
  source: { label: string; onClick: () => void } | null
  menu: React.ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  return (
    <div
      data-pa-work={flat ? "head" : ""}
      className={cn(
        "group/work relative flex w-full min-w-0 items-center text-start",
        !flat && INSET_SURFACE
      )}
    >
      {onOpen ? (
        <button
          type="button"
          data-pa-work-open
          onClick={onOpen}
          aria-label={title}
          title={t("timeline.viewSession")}
          className={cn(
            "absolute inset-0 transition-colors focus-visible:outline-none",
            flat ? SHEET_ROW_HOVER : INSET_HOVER,
            !flat && "focus-visible:bg-(--pa-object-hover)"
          )}
        />
      ) : null}
      <span
        className={cn(
          "pointer-events-none relative flex w-full min-w-0 items-center gap-2.5",
          flat ? "px-3.5 py-3" : "py-2.5 ps-2.5 pe-2"
        )}
      >
        <WorkGlyph mode={mode} size={AVATAR_SIZE} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm leading-5 font-medium break-words text-foreground">
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
            <span className="truncate">{meta}</span>
            {source ? (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                <button
                  type="button"
                  data-pa-work-source
                  onClick={source.onClick}
                  className="pointer-events-auto shrink-0 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {source.label}
                </button>
              </>
            ) : null}
          </span>
        </span>
        {chip}
        {menu ? (
          <span className="pointer-events-auto flex shrink-0 items-center">
            {menu}
          </span>
        ) : null}
        {onOpen ? (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground/50 transition-colors rtl:-scale-x-100",
              "group-hover/work:text-muted-foreground"
            )}
            aria-hidden
          />
        ) : null}
      </span>
    </div>
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

/** How a piece of work stands, as its icon on its tone (a still one: a
 *  folded news line's, D8). */
export function StateIcon({
  state,
  className,
}: {
  state: DispatchState | null
  className?: string
}) {
  const Icon = state ? STATE_ICON[state] : CircleDashed
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", iconTone(state), className)}
    />
  )
}

export function WorkPill({
  rowId,
  state,
  notSent,
  mode,
  by,
  title,
  elapsed,
  onOpen,
}: {
  /** The dispatch row it stands for: jumps to it land on the pill. */
  rowId: number
  state: DispatchState | null
  /** A follow-up that never went out: that, rather than the work's state. */
  notSent?: boolean
  mode: DispatchMode | null
  /** The assistant whose work it is, when it is another's (handed over). */
  by?: string | null
  title: string
  /** How long it has been going, while it runs. */
  elapsed?: string | null
  /** Opens the work's session; none when there is nothing to open. */
  onOpen: (() => void) | null
}) {
  const t = useTranslations("PersonalAgent")
  // Tailwind's spin is a second a turn.
  const spin = useSyncedSpin(1000)
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
      <WorkGlyph mode={mode} size={PILL_AVATAR_SIZE} />
      {by ? (
        <>
          <span className="shrink-0 font-medium text-foreground">{by}</span>
          <span aria-hidden className="shrink-0 text-muted-foreground">
            ·
          </span>
        </>
      ) : null}
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
            // Every running one on the screen turns on one phase (10.8).
            style={spin}
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

"use client"

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"

import type { ToolApproval } from "@/lib/activity/approval"
import { rowIdentity } from "@/lib/activity/build-activity"
import type { StepStatus } from "@/lib/activity/types"
import { cn } from "@/lib/utils"
import { useActivityRender } from "./activity-context"
import { useActivityLive } from "./activity-live-context"
import { ApprovalChip, showsApproval } from "./approval-chip"
import { useFoldRow } from "./fold-back"
import { TimelineFoot } from "./timeline-foot"
import { useRailGrowth } from "./use-rail-growth"

const MARKER_POSITION = {
  main: {
    // Flush with the reply's left edge, like a group's members: the ring is
    // the widest mark, so it starts at 0 and the rail runs through its centre.
    ring: "start-0 top-1 size-5",
    dot: "start-[0.4375rem] top-[0.6875rem] size-1.5",
  },
  child: {
    ring: "start-0 top-1.5 size-4",
    dot: "start-[0.3125rem] top-[0.6875rem] size-1.5",
  },
} as const

/**
 * One row of the activity timeline: a marker on the rail, a one-line header
 * (label on the start side, a figure on the end side), and an optional detail
 * panel the header toggles.
 *
 * The header never moves when the row opens or closes — the panel only grows
 * below it — and the disclosure chevron always takes its space (it only
 * becomes visible on hover / focus), so nothing shifts when it appears.
 *
 * `variant="child"` is a row inside an expanded group: smaller marker and
 * type, its own dashed sub-rail (see `.activity-child` in globals.css), and
 * the same spacing as the rows around the group.
 */
export function ActivityRow({
  stepKey,
  status,
  marker,
  markerKind = "ring",
  variant = "main",
  children,
  trailing,
  approval,
  expandable = false,
  expanded = false,
  onExpandedChange,
  slideShut = false,
  detail,
  addon,
  title,
  className,
  headerClassName,
  motionKey,
  motionSelf = false,
}: {
  stepKey: string
  status?: StepStatus
  marker: ReactNode
  markerKind?: "ring" | "dot"
  variant?: "main" | "child"
  /** The header's label. Single line unless the row lets it wrap. */
  children: ReactNode
  /** The right-hand figure: `84 lines`, `+3 −1`, `exit 1`. */
  trailing?: ReactNode
  /** How the call's permission request was answered: a chip ahead of the
   *  figure. */
  approval?: ToolApproval | null
  expandable?: boolean
  expanded?: boolean
  onExpandedChange?: (open: boolean) => void
  /** Slide the panel shut as it closes rather than drop it — for a panel that
   *  closes by itself, under no hand of the reader's (a group folding once a
   *  reply moves past it). */
  slideShut?: boolean
  /** The panel under the header; only called (and mounted) while open, or
   *  sliding shut. */
  detail?: () => ReactNode
  /** Always shown under the header, open or not (a folded group's live
   *  member, a live output tail). */
  addon?: ReactNode
  /** Full text of anything the header truncates. */
  title?: string
  className?: string
  headerClassName?: string
  /** What the row stands for as the reply changes shape (`ReplyMotion`):
   *  its step, unless the row is something else that shares that step's key —
   *  a group, keyed by its first member. */
  motionKey?: string
  /** The row fades in by itself (late): the reply's motion leaves its
   *  arrival alone. */
  motionSelf?: boolean
}) {
  const detailId = useId()
  const open = expandable && expanded
  // Sliding shut, the panel stays mounted until its slide ends.
  const [shownOpen, setShownOpen] = useState(open)
  const [closing, setClosing] = useState(false)
  if (shownOpen !== open) {
    setShownOpen(open)
    setClosing(!open && slideShut)
  }
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!closing || !panel) return
    const styles = getComputedStyle(panel)
    if (!styles.animationName || styles.animationName === "none") {
      // No slide to wait for (reduced motion, chat animations off): the panel
      // goes in the same flush as the close, before it paints again.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClosing(false)
      return
    }
    const done = (event?: Event) => {
      // Its members' animations bubble up here; only its own slide counts.
      if (event && event.target !== panel) return
      setClosing(false)
    }
    panel.addEventListener("animationend", done)
    panel.addEventListener("animationcancel", done)
    // Should neither fire — the panel stops being drawn mid-slide.
    const timer = window.setTimeout(
      done,
      Number.parseFloat(styles.animationDuration) * 1000 + 100
    )
    return () => {
      panel.removeEventListener("animationend", done)
      panel.removeEventListener("animationcancel", done)
      window.clearTimeout(timer)
    }
  }, [closing])
  const panel = (open || closing) && detail
  const chip = showsApproval(approval, status) ? (
    <ApprovalChip approval={approval} />
  ) : null

  const header = (
    <>
      <span className="flex min-w-0 items-start gap-1">
        <span className="min-w-0">{children}</span>
        {expandable ? <RowChevron open={open} /> : null}
      </span>
      {trailing || chip ? (
        <RowFigure>
          {chip}
          {trailing}
        </RowFigure>
      ) : null}
    </>
  )

  // The line height goes after the font size: tailwind-merge drops a
  // `leading-*` that a later `text-*` follows, and the rail's markers and the
  // chevron are placed for a 1.5rem line.
  const headerClass = cn(
    "group/row flex w-full min-w-0 items-start py-0.5 text-start",
    variant === "main" ? "text-sm leading-6" : "text-[0.8125rem] leading-6",
    headerClassName
  )
  // The header on its own, for the reply's motion: a new group fades its
  // header in while the command it took in glides out from under it.
  const ownMotionKey = motionKey ?? rowIdentity(stepKey)
  const headerMotionKey = `${ownMotionKey}:head`

  return (
    <li
      className={cn(
        variant === "main" ? "activity-item" : "activity-child",
        className
      )}
      data-marker={markerKind}
      data-status={status}
      data-step-key={stepKey}
      data-motion-key={ownMotionKey}
      data-motion-self={motionSelf ? "" : undefined}
      // As the last row it runs the rail beside its open panel, down to the
      // end mark (globals.css).
      data-body={panel ? "" : undefined}
    >
      <span
        className={cn(
          "absolute flex items-center justify-center",
          MARKER_POSITION[variant][markerKind]
        )}
      >
        {marker}
      </span>
      {expandable ? (
        <button
          type="button"
          className={cn(
            headerClass,
            "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          title={title}
          onClick={() => onExpandedChange?.(!open)}
          data-motion-key={headerMotionKey}
        >
          {header}
        </button>
      ) : (
        <div
          className={headerClass}
          title={title}
          data-motion-key={headerMotionKey}
        >
          {header}
        </div>
      )}
      {addon}
      {panel ? (
        <div
          ref={panelRef}
          id={detailId}
          className={cn(
            "activity-detail mt-1 mb-1.5",
            closing && "activity-detail-shut"
          )}
        >
          {detail()}
        </div>
      ) : null}
    </li>
  )
}

/**
 * The disclosure chevron after a row's label. It always takes its space and
 * only shows on hover / focus — or while the row is open — so nothing shifts
 * when it appears. Focus is the row's own, or a control's inside it. `always`
 * keeps it in view folded too (the activity header's).
 */
export function RowChevron({
  open,
  always = false,
  className,
}: {
  open: boolean
  always?: boolean
  /** Placed by a line that is not a row's 1.5rem header (the turn's). */
  className?: string
}) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "mt-[0.3125rem] size-3.5 shrink-0 text-muted-foreground transition-[opacity,rotate] rtl:-scale-x-100",
        always
          ? "opacity-100"
          : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-has-[:focus-visible]/row:opacity-100",
        // Mirrored under RTL, so it turns the other way to point down.
        open && "rotate-90 opacity-100 rtl:-rotate-90",
        className
      )}
    />
  )
}

/**
 * Where a group stands in its reply. `current`: the reply is still being
 * written with the group its last row, where the next step may join it.
 * `going`: its foot turns — while it is current and the agent is not waiting
 * on the user — from the group's first command to its last rather than
 * flickering between commands. Folded while current, its running member shows
 * under its header, so the step under way is never hidden.
 *
 * Once the reply has moved past it — a row follows, or the answer does — or
 * is done, nothing joins it: a member still running there (a command moved to
 * the background, a call going on beside the steps after it) says so on its
 * own row, inside the group, and the foot is the row that folds the group.
 */
export function useGroupPlace(followed: boolean): {
  current: boolean
  going: boolean
} {
  const { isStreaming } = useActivityRender()
  const { awaitingUser } = useActivityLive()
  const current = isStreaming && !followed
  return { current, going: current && !awaitingUser }
}

/** The foot an open group's members end on (see `TimelineFoot`). */
export interface MembersFoot {
  /** The group is still going: a member runs, or more may join it. */
  working: boolean
  /** The members' own marker, which sets how far down the foot sits. */
  after: "ring" | "dot"
  /** What the group holds, said after "Collapse": `3 commands`. */
  what: string
  /** Folds the group. */
  onFold: () => void
  /** The group's key: its foot's, as the reply changes shape (`ReplyMotion`). */
  motionScope: string
}

/**
 * An open group's members, on their own dashed rail, ending on a foot
 * (`foot`): the turning ring while the group is still going, then a row that
 * folds it; a folded group's live member under its header has none. Folded
 * from its foot, the group's header comes back into view and takes the focus
 * the foot had. While the reply is written, the rail grows down to each
 * member that joins.
 */
export function ActivityMembers({
  foot,
  children,
}: {
  foot?: MembersFoot
  children: ReactNode
}) {
  const { isStreaming } = useActivityRender()
  const listRef = useRef<HTMLUListElement>(null)
  const foldRow = useFoldRow()
  useRailGrowth(listRef, foot !== undefined && isStreaming)
  return (
    <ul ref={listRef} role="list" className="activity-children">
      {children}
      {foot ? (
        <TimelineFoot
          variant="child"
          after={foot.after}
          working={foot.working}
          what={foot.what}
          onFold={(control) => foldRow(control, foot.onFold)}
          motionScope={foot.motionScope}
        />
      ) : null}
    </ul>
  )
}

/**
 * A row header's end column: its figure, status word, time. It takes the
 * line's room past the label, a faint dashed line running across it up to
 * the figure (`.activity-figure` in globals.css), so a figure at the far end
 * of a wide row still reads as the label's. The label beside it must not
 * grow.
 */
export function RowFigure({ children }: { children: ReactNode }) {
  return (
    <span className="activity-mono activity-figure flex shrink-0 grow items-center justify-end gap-3 ps-3 text-xs leading-6 text-activity-secondary">
      {children}
    </span>
  )
}

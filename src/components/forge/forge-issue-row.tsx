"use client"

import { useTranslations } from "next-intl"
import {
  CircleCheck,
  CircleDot,
  CirclePlay,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListTodo,
  MessageSquare,
  RotateCcw,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import { statusLabelKey } from "@/components/tasks/task-card"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import { labelSwatch } from "@/lib/forge-label-color"
import { chipStateForLink, isDeferredLink } from "@/lib/forge-task-chip"
import type { ForgeIssueRow, ForgeLabel, ForgeTaskLink } from "@/lib/types"

/** Render-time "now" is fine here: the list re-renders on every refresh. */
function relative(iso: string): string {
  return formatRelative(iso, Date.now())
}

/** The four words a row's state can be. `stateOpen` / `stateClosed` are the
 *  toolbar filter's own labels — one vocabulary for the whole page, and two
 *  fewer strings to keep in step across ten locales. Deliberately
 *  provider-neutral: the same glyph set serves GitLab's merge requests. */
type StateLabelKey = "stateOpen" | "stateClosed" | "stateMerged" | "stateDraft"

/**
 * The row's leading glyph. A pull request has four outcomes worth telling
 * apart at a glance and an issue has two, and colour alone cannot carry that —
 * hence a distinct SHAPE per state plus a translated label, so the state
 * survives both a colour-blind reader and a screen reader.
 *
 * Draft outranks the state on purpose: an open draft is not ready for review,
 * which is the thing a triage list is scanning for.
 *
 * Exported for the detail panel, which spells the same state out in words next
 * to the same glyph in the same colour — one vocabulary across both surfaces
 * (the same reason `task-card` hands `StatusChip` to the task detail sheet).
 */
export function stateGlyph(row: ForgeIssueRow): {
  Icon: LucideIcon
  className: string
  labelKey: StateLabelKey
} {
  if (!row.is_pr) {
    return row.state === "open"
      ? {
          Icon: CircleDot,
          className: "text-emerald-600",
          labelKey: "stateOpen",
        }
      : {
          Icon: CircleCheck,
          className: "text-violet-500",
          labelKey: "stateClosed",
        }
  }
  if (row.draft) {
    return {
      Icon: GitPullRequestDraft,
      className: "text-muted-foreground",
      labelKey: "stateDraft",
    }
  }
  switch (row.state) {
    case "merged":
      return {
        Icon: GitMerge,
        className: "text-violet-500",
        labelKey: "stateMerged",
      }
    case "open":
      return {
        Icon: GitPullRequestArrow,
        className: "text-emerald-600",
        labelKey: "stateOpen",
      }
    default:
      return {
        Icon: GitPullRequestClosed,
        className: "text-rose-600",
        labelKey: "stateClosed",
      }
  }
}

/** Labels drawn before the rest are dropped. A phone-width row has no space
 *  for four of them next to a title that also wants to be readable. */
const LABEL_CAP_COMPACT = 1
const LABEL_CAP = 4

/**
 * One label, in the project's own colour.
 *
 * Shared with the detail panel — which is where the labels the row had to drop
 * finally show — so that WHICH treatment a colour gets is decided once. The
 * project's colour arrives raw from the forge and only `labelSwatch` knows how
 * to make it survive both themes; a label the forge gave no usable colour keeps
 * the neutral chip rather than an invented one. Size is the caller's, because
 * the row and the panel are set at different scales.
 */
export function ForgeLabelChip({
  label,
  className,
}: {
  label: ForgeLabel
  className?: string
}) {
  const swatch = labelSwatch(label.color)
  return (
    <Badge
      variant="outline"
      style={swatch}
      title={label.name}
      className={cn(
        "shrink-0 rounded-full font-normal",
        swatch == null ? "text-muted-foreground" : "forge-label border",
        className
      )}
    >
      {label.name}
    </Badge>
  )
}

/**
 * ONE shape for the row's action, whichever of the two it is showing. "Start"
 * and the status chip occupy the same slot on successive rows, so a difference
 * in height or radius between them reads down the list as a ragged column;
 * BACKGROUND is what separates them — an offer to act, versus a task already
 * under way. Same reason the geometry is a constant and not two class strings
 * that happen to agree today.
 *
 * The detail panel's footer borrows it too: it offers the same two actions on
 * the same item, and a pill that changed shape on the way into the panel would
 * read as a different control.
 */
export const ROW_ACTION =
  "h-7 shrink-0 gap-1.5 rounded-full px-3 text-xs font-medium"

/** Both actions' glyph. Spelled out on the icon rather than folded into
 *  `ROW_ACTION`: `Button`'s own `[&_svg:not([class*='size-'])]:size-4` carries
 *  a `:not()` and so outranks a plain `[&_svg]:` rule — an explicit class on
 *  the icon is the escape hatch that variant is written around. */
export const ROW_ACTION_GLYPH = "size-3.5"

/** The live task chip's two fills, shared with the detail panel's footer: an
 *  accent for a task still under way, neutral once it has settled. */
export const CHIP_FILL = {
  active:
    "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:hover:bg-primary/15",
  settled:
    "bg-muted text-muted-foreground hover:bg-muted/80 dark:hover:bg-muted/80",
} as const

/**
 * One workbench row: `#number title labels · author · updated` plus the
 * three-state action — start (no task), a live status chip (active task,
 * click-through to the board), or done/canceled with a re-trigger.
 */
export function ForgeIssueRowItem({
  row,
  link,
  compact = false,
  onOpenDetail,
  onStart,
}: {
  row: ForgeIssueRow
  link: ForgeTaskLink | null
  /** Phone width: fewer labels, since the title has to stay readable. */
  compact?: boolean
  /** Opens the right-side detail panel on this item. */
  onOpenDetail: () => void
  onStart: () => void
}) {
  const t = useTranslations("Forge")
  const tTasks = useTranslations("Tasks")
  const { setRoute } = useWorkbenchRoute()

  const chip = chipStateForLink(link)
  const active = chip === "active"
  const terminal = chip === "terminal"
  const { Icon, className: glyphClass, labelKey } = stateGlyph(row)
  const stateLabel = t(labelKey)

  return (
    // `items-start`, not `items-center`: the row is two lines and the glyph
    // belongs to the TITLE, so centring it against the whole block floats it
    // between the two. The h-5 box is the title's own line height (text-sm),
    // which puts the glyph on that line's centre wherever the block grows.
    // The TRAILING cluster is the opposite case — it belongs to the row, not to
    // a line of it — so it centres against the whole block via `self-center`.
    <div className="group flex min-w-0 items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
      <span className="flex h-5 shrink-0 items-center">
        <Icon
          role="img"
          aria-label={stateLabel}
          className={cn("h-3.5 w-3.5", glyphClass)}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The title opens the panel on the right rather than the forge's
              own web page. Reading an issue used to mean leaving the app for a
              browser and coming back to find your place in the list again; the
              panel keeps the list, the filters and the scroll position exactly
              where they were, and the way out to the forge stays one click
              away on the number below and in the panel's footer.

              A `<button>`, not a clickable div: Enter and Space, the focus
              ring and the role all come with it. `text-start` because a button
              centres its text by default, which would break the column the
              titles line up in. */}
          <button
            type="button"
            onClick={onOpenDetail}
            title={row.title}
            className="truncate text-start text-sm font-medium hover:underline"
          >
            {row.title}
          </button>
          {row.labels
            .slice(0, compact ? LABEL_CAP_COMPACT : LABEL_CAP)
            .map((label) => (
              <ForgeLabelChip
                key={label.name}
                label={label}
                className="h-4 px-2 text-[0.625rem]"
              />
            ))}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          {/* Where the title's old link went. The number is the item's name on
              the forge — both forges render it as the link to the item — so it
              is the natural place for the trip out, and putting it here keeps
              the affordance on the row for anyone who wants the real page. */}
          <BrowserLink
            href={row.html_url}
            title={t("openItem")}
            className="font-mono transition-colors hover:text-foreground hover:underline"
          >
            #{row.number}
          </BrowserLink>
          {row.author ? <span>· {row.author}</span> : null}
          {row.updated_at ? <span>· {relative(row.updated_at)}</span> : null}
        </div>
      </div>

      {/* Comment count and action, centred on the row as one cluster. The wider
          gap once there is room to spare keeps a two-digit count from reading
          as part of the button next to it. */}
      <div className="flex shrink-0 items-center gap-2 self-center sm:gap-4">
        {row.comments > 0 ? (
          // Only when there IS a discussion: a column of zeroes is noise, and
          // both forges' own lists hide it the same way.
          <span
            className="flex items-center gap-1 text-[0.6875rem] tabular-nums text-muted-foreground"
            title={t("commentCount", { count: row.comments })}
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {row.comments}
          </span>
        ) : null}

        {link == null ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={ROW_ACTION}
            onClick={onStart}
          >
            {/* Outline, like every other glyph on the row — a solid triangle
                was the one filled shape in the list and pulled the eye off the
                titles it sits beside. */}
            <CirclePlay className={ROW_ACTION_GLYPH} aria-hidden />
            {t("start")}
          </Button>
        ) : (
          // Two sibling controls, never one nested in the other: an interactive
          // element inside a button folds its text into the outer button's
          // accessible name, and keyboard activation of the inner one is left
          // to whatever the browser decides. Siblings also drop the
          // stopPropagation / manual Enter-and-Space handling a real button
          // gives for free.
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRoute("tasks")}
              title={t("viewTask")}
              className={cn(
                ROW_ACTION,
                active ? CHIP_FILL.active : CHIP_FILL.settled
              )}
            >
              {/* The sidebar's own to-do glyph, so "Running" reads as the
                  status of a WORK TASK rather than of the issue itself — and so
                  the chip looks like the place it navigates to. Decoration:
                  the accessible name stays the status word. */}
              <ListTodo className={ROW_ACTION_GLYPH} aria-hidden />
              {isDeferredLink(link)
                ? tTasks("statusDeferred")
                : tTasks(statusLabelKey(link.status))}
            </Button>
            {terminal ? (
              <button
                type="button"
                onClick={onStart}
                className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <RotateCcw className="size-3" aria-hidden />
                {t("retrigger")}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

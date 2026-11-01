"use client"

import { ChevronUpIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { RailIcon, TurningRing } from "./rail-icon"

/** The foot a list of steps ends on, as the list's host hands it over: a
 *  reply for its steps, a group for its members, a sub-agent's row or a
 *  goal's card for theirs. */
export interface ActivityFoot {
  /** The steps are still going: the foot is the turning ring. */
  working: boolean
  /** What folding takes away, said after "Collapse": `14 steps · 3m 34s`,
   *  `3 commands`. */
  what: string
  /** Folds the list away; handed the control pressed, which goes with it. */
  onFold: (control: HTMLButtonElement) => void
}

/**
 * The foot of an open list of steps, the last thing on its rail. While the
 * steps are still going it is the turning ring of an agent at work, with no
 * words beside it. Once they are done it is a row like the steps above it: a
 * ring with the fold's chevron in it, where a step's icon would be, and
 * `Collapse 14 steps · 3m 34s` beside it — the row folds the list away. The
 * two take the same height, so nothing under the list moves as the steps
 * end. The ring sits where a ring of the list would (a reply's 1.25rem, a
 * group member's 1rem), so the rail stops as short of it as of a step's.
 */
export function TimelineFoot({
  variant = "main",
  after = "ring",
  working,
  what,
  onFold,
  motionScope,
}: {
  variant?: "main" | "child"
  /** The marker of the members above it: a dot's dashed segment reaches
   *  further into the next row than a ring's, so the foot starts that much
   *  lower (globals.css). */
  after?: "ring" | "dot"
  /** Whose foot this is, as the reply changes shape (`ReplyMotion`): `""`
   *  for the reply's own, a group's key for its members'. The turning ring
   *  and the fold row are told apart — the ring glides down as steps join,
   *  the row that replaces it fades in where it lands. None for a list
   *  nested in a step. */
  motionScope?: string
} & ActivityFoot) {
  const t = useTranslations("Folder.chat.activity")
  const main = variant === "main"
  const row = main ? "activity-item" : "activity-child"
  // Only a group's members set the foot lower; a reply's prose dots reach no
  // further into the next row than its rings.
  const afterDot = !main && after === "dot" ? "dot" : undefined
  const motionKey = (what: "working" | "foot") =>
    motionScope === undefined
      ? undefined
      : motionScope
        ? `${what}:${motionScope}`
        : what
  if (working) {
    return (
      <li
        aria-hidden="true"
        className={cn(row, "h-7")}
        data-marker="working"
        data-after={afterDot}
        data-motion-key={motionKey("working")}
      >
        <TurningRing
          className={cn(
            "absolute start-0.5",
            main ? "top-1 size-4" : "top-1.5 size-3"
          )}
        />
      </li>
    )
  }
  return (
    <li
      className={row}
      data-marker="foot"
      data-after={afterDot}
      data-motion-key={motionKey("foot")}
    >
      {/* The whole row is the control, the ring in it: the button reaches
          back over the marker column, and the ring sits in that column. */}
      <button
        type="button"
        className={cn(
          // Its words in one ink, as a step's label and what follows it
          // are; pointed at or focused, both darken with the ring.
          "group/foot flex w-fit min-w-0 cursor-pointer items-baseline gap-2 rounded-sm py-0.5 text-start text-activity-secondary hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          main
            ? "-ms-8 max-w-[calc(100%+2rem)] ps-8 text-sm leading-6"
            : "-ms-7 max-w-[calc(100%+1.75rem)] ps-7 text-[0.8125rem] leading-6"
        )}
        onClick={(event) => onFold(event.currentTarget)}
      >
        <span
          className={cn(
            "absolute flex items-center justify-center",
            main ? "start-0 top-1 size-5" : "start-0 top-1.5 size-4"
          )}
        >
          <RailIcon
            icon={ChevronUpIcon}
            status="succeeded"
            size={main ? "md" : "sm"}
            iconClassName="group-hover/foot:text-foreground group-focus-visible/foot:text-foreground"
          />
        </span>
        {/* The gap lays the words out; the space between them keeps them
            apart in the name a screen reader reads. */}
        <span className="shrink-0 font-medium">{t("foot.fold")}</span>{" "}
        <span className="min-w-0 truncate">{what}</span>
      </button>
    </li>
  )
}

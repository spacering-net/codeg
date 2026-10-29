"use client"

import { memo, type ReactNode } from "react"

import { rowIdentity } from "@/lib/activity/build-activity"
import type { StepStatus } from "@/lib/activity/types"
import { RailDot, RailIcon, type ActivityIcon } from "../rail-icon"
import { useStatusText } from "../step-visuals"

/**
 * A step whose body is a card of its own (a sub-agent, a delegation, a plan, a
 * question record…), hosted on the rail as it is: the ring marks the step,
 * the card is the content.
 */
export const HostedRow = memo(function HostedRow({
  stepKey,
  icon,
  status,
  kindLabel,
  inset = true,
  children,
}: {
  stepKey: string
  icon: ActivityIcon
  status: StepStatus
  kindLabel: string
  /** Nudge a framed card down to the ring's line; off for content that is
   *  already laid out as a timeline row. */
  inset?: boolean
  children: ReactNode
}) {
  const statusText = useStatusText()
  return (
    <li
      className="activity-item"
      data-marker="ring"
      data-status={status}
      data-step-key={stepKey}
      data-motion-key={rowIdentity(stepKey)}
      // The card is a body under its line: as the last row, the rail runs
      // beside it (globals.css).
      data-body=""
    >
      <span className="absolute start-0 top-1 flex size-5 items-center justify-center">
        <RailIcon
          icon={icon}
          status={status}
          label={`${kindLabel}, ${statusText(status)}`}
        />
      </span>
      <div className={inset ? "min-w-0 pt-0.5" : "min-w-0"}>{children}</div>
    </li>
  )
})

/** Prose the agent wrote between steps, on the rail as a dot. */
export const NoteRow = memo(function NoteRow({
  stepKey,
  motionKey,
  children,
}: {
  stepKey: string
  /** The prose's key as the reply changes shape (`ReplyMotion`), on the
   *  words and not on the row: off the rail, the same words are the answer,
   *  and they glide there; the dot stays with the rail. */
  motionKey?: string
  children: ReactNode
}) {
  return (
    <li
      className="activity-item"
      data-marker="dot"
      data-step-key={stepKey}
      // Prose is a body under its line too (globals.css draws no segment
      // beside a one-line note).
      data-body=""
    >
      <span className="absolute start-[0.4375rem] top-[0.6875rem] flex size-1.5 items-center justify-center">
        <RailDot />
      </span>
      <div className="min-w-0 py-0.5" dir="auto" data-motion-key={motionKey}>
        {children}
      </div>
    </li>
  )
})

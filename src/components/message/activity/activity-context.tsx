"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { ActivityModel } from "@/lib/activity/types"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { ActivityFoot } from "./timeline-foot"

/**
 * What the timeline's rows need from the surface that renders them.
 *
 * `renderPart` draws a part outside the rows' own drawing — prose, plans and
 * images in place, and the dedicated cards the timeline hosts inside a row. It
 * is injected rather than imported because that renderer is the one that
 * mounts the timeline; importing it here would close an import cycle.
 */
export interface ActivityRenderContextValue {
  /** `live`: the part is the prose the agent is writing right now — its
   *  words fade in as they arrive. */
  renderPart: (
    part: AdaptedContentPart,
    key: string,
    live?: boolean
  ) => ReactNode
  /** The reply is still being written. */
  isStreaming: boolean
  /** Failed steps a later step redid successfully (see `summarizeActivity`). */
  recoveredKeys: ReadonlySet<string>
  /** Draw a nested timeline (a sub-agent's own steps) with the same wiring,
   *  ending on the capsule that folds its host. */
  renderNested: (
    model: ActivityModel,
    isStreaming: boolean,
    foot?: ActivityFoot
  ) => ReactNode
  /** Only rows still running are drawn — the folded turn's long-lived rows
   *  (delegations, sub-agents, background tasks that outlive the turn). */
  pinnedOnly: boolean
  /** A list inside a step (a sub-agent's, a goal's): its prose and its foot
   *  are not the reply's own, so they carry no motion keys (`ReplyMotion`). */
  nested: boolean
}

const ActivityRenderContext = createContext<ActivityRenderContextValue | null>(
  null
)

export const ActivityRenderProvider = ActivityRenderContext.Provider

export function useActivityRender(): ActivityRenderContextValue {
  const value = useContext(ActivityRenderContext)
  if (!value) {
    throw new Error("Activity rows must be rendered inside ActivityTimeline")
  }
  return value
}

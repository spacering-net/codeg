"use client"

import { useMemo } from "react"

import { approvalFromInfo } from "@/lib/activity/approval"
import type { ActivityStep } from "@/lib/activity/types"
import { useActivityLive } from "./activity-live-context"

type ToolStep = Extract<ActivityStep, { type: "tool" }>

/** Whether `step` is the call a pending permission request is about. A call
 *  that has already settled is not waiting on anyone, whatever the card says. */
function isAwaited(step: ToolStep, awaitingToolCallId: string | null): boolean {
  return (
    awaitingToolCallId !== null &&
    awaitingToolCallId === step.part.toolCallId &&
    step.tool.status !== "succeeded" &&
    step.tool.status !== "failed"
  )
}

/**
 * A tool step with what the live connection knows and the transcript does not.
 *
 * - The call a pending permission request is about is waiting on the user,
 *   whatever its transcript state says.
 * - A call whose request was answered carries the answer: the connection's own
 *   record when it has one (the freshest), else the stamp a detail load put on
 *   the call. A call the user declined that the transcript only shows as a
 *   failure is drawn as declined.
 *
 * Returns `step` itself when nothing applies, so the memoized rows below keep
 * their props.
 */
export function useLiveToolStep(step: ToolStep): ToolStep {
  const { awaitingToolCallId, approvals } = useActivityLive()
  const awaiting = isAwaited(step, awaitingToolCallId)
  const record = approvals[step.part.toolCallId]
  return useMemo(() => {
    const { tool } = step
    const approval = (record ? approvalFromInfo(record) : null) ?? tool.approval
    const status = awaiting
      ? "awaiting"
      : approval?.decision === "rejected" && tool.status === "failed"
        ? "rejected"
        : tool.status
    if (status === tool.status && approval === tool.approval) return step
    return { ...step, tool: { ...tool, status, approval } }
  }, [step, awaiting, record])
}

/** The member of a group a pending permission request is about, if any. */
export function useAwaitedStep(
  steps: readonly ActivityStep[]
): ToolStep | null {
  const { awaitingToolCallId } = useActivityLive()
  if (awaitingToolCallId === null) return null
  for (const step of steps) {
    if (step.type === "tool" && isAwaited(step, awaitingToolCallId)) {
      return step
    }
  }
  return null
}

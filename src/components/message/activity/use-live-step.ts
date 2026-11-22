"use client"

import { useMemo } from "react"

import { approvalFromInfo } from "@/lib/activity/approval"
import type { ActivityStep, StepStatus } from "@/lib/activity/types"
import { toolCallMovedToBackground } from "@/lib/tool-call-normalization"
import type { AsyncTaskRecord } from "@/lib/types"
import { useActivityLive } from "./activity-live-context"

type ToolStep = Extract<ActivityStep, { type: "tool" }>

function backgroundTaskStatus(
  step: ToolStep,
  asyncTasks: readonly AsyncTaskRecord[] | undefined,
  connectionLive: boolean | undefined
): StepStatus | null {
  if (
    step.tool.status !== "running" ||
    step.part.state !== "output-available" ||
    !toolCallMovedToBackground(step.part.meta)
  ) {
    return null
  }
  const task = asyncTasks?.find((t) => t.tool_call_id === step.part.toolCallId)
  if (task) {
    if (task.state === "completed") return "succeeded"
    if (task.state === "failed") return "failed"
    if (task.state === "stopped") return "cancelled"
    return null
  }
  if (connectionLive === false) return "succeeded"
  return null
}

function resolveToolStep(
  step: ToolStep,
  awaitingToolCallId: string | null,
  approvals: ReturnType<typeof useActivityLive>["approvals"],
  asyncTasks: readonly AsyncTaskRecord[] | undefined,
  connectionLive: boolean | undefined
): ToolStep {
  const { tool } = step
  const record = approvals[step.part.toolCallId]
  const approval = (record ? approvalFromInfo(record) : null) ?? tool.approval
  const settledBg = backgroundTaskStatus(step, asyncTasks, connectionLive)
  const baseStatus = settledBg ?? tool.status
  const awaiting =
    awaitingToolCallId !== null &&
    awaitingToolCallId === step.part.toolCallId &&
    baseStatus !== "succeeded" &&
    baseStatus !== "failed" &&
    baseStatus !== "cancelled"
  const status = awaiting
    ? "awaiting"
    : approval?.decision === "rejected" && baseStatus === "failed"
      ? "rejected"
      : baseStatus
  if (status === tool.status && approval === tool.approval) return step
  return { ...step, tool: { ...tool, status, approval } }
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
  const { awaitingToolCallId, approvals, asyncTasks, connectionLive } =
    useActivityLive()
  return useMemo(
    () =>
      resolveToolStep(
        step,
        awaitingToolCallId,
        approvals,
        asyncTasks,
        connectionLive
      ),
    [step, awaitingToolCallId, approvals, asyncTasks, connectionLive]
  )
}

export function useLiveToolSteps(steps: readonly ToolStep[]): ToolStep[] {
  const { awaitingToolCallId, approvals, asyncTasks, connectionLive } =
    useActivityLive()
  return useMemo(() => {
    let changed = false
    const resolved = steps.map((step) => {
      const next = resolveToolStep(
        step,
        awaitingToolCallId,
        approvals,
        asyncTasks,
        connectionLive
      )
      if (next !== step) changed = true
      return next
    })
    return changed ? resolved : (steps as ToolStep[])
  }, [steps, awaitingToolCallId, approvals, asyncTasks, connectionLive])
}

/** The member of a group a pending permission request is about, if any. */
export function useAwaitedStep(
  steps: readonly ActivityStep[]
): ToolStep | null {
  const { awaitingToolCallId } = useActivityLive()
  if (awaitingToolCallId === null) return null
  for (const step of steps) {
    if (
      step.type === "tool" &&
      awaitingToolCallId === step.part.toolCallId &&
      step.tool.status !== "succeeded" &&
      step.tool.status !== "failed"
    ) {
      return step
    }
  }
  return null
}

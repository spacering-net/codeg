import { parseResumeTaskId } from "@/lib/codeg-mcp-tool"
import { delegateCallTaskId, isRefusedResume } from "@/lib/delegation-card"
import type { ActivityStep } from "./types"

/**
 * The broker task a delegation step is about: a `delegate_to_agent` call's
 * from its result, a `resume_delegation` call's from its `task_id` argument
 * (unless the resume was refused). Null for any other step.
 */
export function delegationStepTaskId(step: ActivityStep): string | null {
  if (step.type !== "tool") return null
  switch (step.tool.kind) {
    case "delegation":
      return delegateCallTaskId(step.part)
    case "delegation-resume":
      // A refused resume started no run: it is about no task's progress.
      return isRefusedResume(step.part.output, step.part.errorText)
        ? null
        : parseResumeTaskId(step.part.input)
    default:
      return null
  }
}

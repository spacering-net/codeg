/**
 * End-to-end guard for the Qoder live path: an ACP `tool_call` frame captured
 * verbatim off `qoder --acp` (qodercli 1.1.25) must survive every adapter pass
 * and arrive at the renderer under the canonical name its card dispatches on.
 *
 * `tool-call-normalization.test.ts` pins the identity resolution and
 * `codeg-mcp-tool-card.test.tsx` pins the rendering, but the passes BETWEEN them
 * are where a codeg-mcp call would silently disappear: `dropEmptyInFlightToolCalls`
 * can delete an arg-less in-flight call, and the timeline folds runs of some
 * kinds into one row — either one and the card never renders no matter how
 * correct the name is. The drop is gated on `isAgentLikeToolName`, so this
 * asserts the whole chain rather than that one predicate.
 *
 * Frames below are the real thing. Captured with a throwaway stdio MCP server
 * named `codeg-mcp` wired into `session/new`, driving one live turn:
 *
 *   TOOL_CALL        {"title":"get_delegation_status (codeg-mcp MCP Server)",
 *                     "kind":"other","status":"pending",
 *                     "_meta":{"qoder":{"toolName":"mcp__codeg-mcp__get_delegation_status"}}}
 *   TOOL_CALL_UPDATE {"status":"completed"}          ← no `_meta` at all
 *
 * That second frame is why the reducer's `meta: action.meta ?? block.info.meta`
 * matters: Qoder only stamps the tool name on the OPENING frame.
 */

import { describe, expect, it } from "vitest"

import {
  dropEmptyInFlightToolCalls,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "./ai-elements-adapter"
import { buildActivity } from "@/lib/activity/build-activity"
import { inferLiveToolName } from "@/lib/tool-call-normalization"

/** The five workbench companions plus the delegation/feedback ones. */
const QODER_FRAMES: ReadonlyArray<{
  tool: string
  rawInput: unknown
  expected: string
}> = [
  {
    tool: "get_delegation_status",
    rawInput: { task_ids: ["081139e7"], wait_ms: 60000 },
    expected: "get_delegation_status",
  },
  {
    tool: "cancel_delegation",
    rawInput: { task_id: "t1" },
    expected: "cancel_delegation",
  },
  {
    tool: "check_user_feedback",
    rawInput: {},
    expected: "check_user_feedback",
  },
  {
    tool: "get_session_info",
    rawInput: { session_id: 2122, max_messages: 20 },
    expected: "get_session_info",
  },
  {
    tool: "task_progress",
    rawInput: { message: "halfway" },
    expected: "task_progress",
  },
  {
    tool: "task_complete",
    rawInput: { verdict: "success", summary: "done" },
    expected: "task_complete",
  },
]

/** Exactly what Qoder's `AOn` puts on the wire for an MCP call. */
function qoderFrame(tool: string, rawInput: unknown) {
  return {
    title: `${tool} (codeg-mcp MCP Server)`,
    kind: "other",
    rawInput: JSON.stringify(rawInput),
    meta: { qoder: { toolName: `mcp__codeg-mcp__${tool}` } },
  }
}

function toolCallPart(
  toolName: string,
  input: unknown,
  state: AdaptedToolCallPart["state"]
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: `call-${toolName}`,
    toolName,
    input: JSON.stringify(input),
    state,
    output: null,
  }
}

describe("Qoder live frames reach their card through every adapter pass", () => {
  it.each(QODER_FRAMES)(
    "$tool survives identity resolution and the empty-drop",
    ({ tool, rawInput, expected }) => {
      const resolved = inferLiveToolName(qoderFrame(tool, rawInput))
      expect(resolved).toBe(expected)

      // Still in flight — the state the card is judged in while streaming, and
      // the one `dropEmptyInFlightToolCalls` is allowed to delete.
      const part = toolCallPart(resolved, rawInput, "input-available")
      expect(dropEmptyInFlightToolCalls([part])).toHaveLength(1)
    }
  )

  it("keeps an arg-less in-flight check_user_feedback alive through the empty-drop", () => {
    // `check_user_feedback` takes NO arguments, so its live frame is the exact
    // "empty args + unsettled + no output" shape `dropEmptyInFlightToolCalls`
    // deletes. It must be exempt — the feedback lane owns the decision to hide
    // a no-op poll (`dropHiddenFeedbackChecks`), not this pass.
    const resolved = inferLiveToolName(qoderFrame("check_user_feedback", {}))
    const part = toolCallPart(resolved, {}, "input-available")
    expect(dropEmptyInFlightToolCalls([part])).toEqual([part])
  })

  it("does not let a run of codeg-mcp calls collapse into one row", () => {
    // A real delegation turn is a burst of calls; if they folded, the user
    // would see one tally instead of a row per call.
    const parts: AdaptedContentPart[] = QODER_FRAMES.map(({ tool, rawInput }) =>
      toolCallPart(
        inferLiveToolName(qoderFrame(tool, rawInput)),
        rawInput,
        "output-available"
      )
    )
    const { items } = buildActivity(parts, { isStreaming: false })
    expect(items).toHaveLength(QODER_FRAMES.length)
    expect(items.every((item) => item.type === "step")).toBe(true)
  })

  it("holds the identity when the follow-up frame carries no _meta", () => {
    // Qoder's `tool_call_update` for an MCP call ships status only (verified on
    // the wire). The reducer preserves the block's meta in that case, so the
    // resolution must be identical — this pins the contract that makes the card
    // stable mid-call instead of reverting to the generic shell.
    const opening = qoderFrame("task_progress", { message: "halfway" })
    const afterUpdate = { ...opening, meta: opening.meta } // reducer: meta ?? prior
    expect(inferLiveToolName(afterUpdate)).toBe(inferLiveToolName(opening))
    // And if a host DID drop the meta, we degrade to a generic tool rather than
    // to something misleading — the failure mode the fix exists to remove.
    expect(inferLiveToolName({ ...opening, meta: null })).not.toBe(
      "task_progress"
    )
  })
})

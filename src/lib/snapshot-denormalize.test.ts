import { describe, expect, it } from "vitest"

import { parseStatusReports } from "@/lib/delegation-status"
import { denormalizeSnapshot } from "@/lib/snapshot-denormalize"
import type { LiveSessionSnapshot, ToolCallState } from "@/lib/types"

function baseSnapshot(
  overrides: Partial<LiveSessionSnapshot> = {}
): LiveSessionSnapshot {
  return {
    connection_id: "conn-1",
    conversation_id: null,
    folder_id: null,
    status: "connected",
    external_id: null,
    live_message: null,
    active_tool_calls: [],
    pending_permission: null,
    modes: null,
    current_mode: null,
    config_options: null,
    prompt_capabilities: null,
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: false,
    event_seq: 0,
    ...overrides,
  }
}

describe("denormalizeSnapshot — active_delegations", () => {
  it("carries active_delegations through to the patch", () => {
    const patch = denormalizeSnapshot(
      baseSnapshot({
        active_delegations: [
          {
            parent_tool_use_id: "pt-1",
            child_connection_id: "c1",
            child_conversation_id: 9,
            agent_type: "codex",
          },
        ],
      })
    )
    expect(patch.activeDelegations).toHaveLength(1)
    expect(patch.activeDelegations[0].parent_tool_use_id).toBe("pt-1")
    expect(patch.activeDelegations[0].child_conversation_id).toBe(9)
  })

  it("defaults activeDelegations to [] when the field is absent (older server payload)", () => {
    const snap = baseSnapshot()
    // Older server payloads omit the field entirely.
    delete (snap as { active_delegations?: unknown }).active_delegations
    const patch = denormalizeSnapshot(snap)
    expect(patch.activeDelegations).toEqual([])
  })
})

describe("denormalizeSnapshot — subagent attribution on live blocks", () => {
  it("forwards parent_tool_use_id onto text/thinking, absent field stays undefined", () => {
    const patch = denormalizeSnapshot(
      baseSnapshot({
        live_message: {
          id: "lm-1",
          role: "assistant",
          started_at: "2026-07-28T00:00:00Z",
          content: [
            { kind: "text", text: "main" },
            { kind: "text", text: "sub", parent_tool_use_id: "toolu_p" },
            {
              kind: "thinking",
              text: "sub think",
              parent_tool_use_id: "toolu_p",
            },
          ],
        },
      })
    )
    const content = patch.liveMessage?.content ?? []
    expect(content).toHaveLength(3)
    expect(content[0]).toMatchObject({ type: "text", text: "main" })
    expect(
      content[0]?.type === "text" ? content[0].parentToolUseId : "SET"
    ).toBeUndefined()
    expect(content[1]).toMatchObject({
      type: "text",
      text: "sub",
      parentToolUseId: "toolu_p",
    })
    expect(content[2]).toMatchObject({
      type: "thinking",
      text: "sub think",
      parentToolUseId: "toolu_p",
    })
  })
})

describe("denormalizeSnapshot — config staleness", () => {
  it("carries config_stale / config_stale_kind into the patch", () => {
    const patch = denormalizeSnapshot(
      baseSnapshot({ config_stale: true, config_stale_kind: "model_provider" })
    )
    expect(patch.configStale).toBe(true)
    expect(patch.configStaleKind).toBe("model_provider")
  })

  it("defaults to not-stale when the fields are absent (older server payload)", () => {
    const snap = baseSnapshot()
    delete (snap as { config_stale?: unknown }).config_stale
    delete (snap as { config_stale_kind?: unknown }).config_stale_kind
    const patch = denormalizeSnapshot(snap)
    expect(patch.configStale).toBe(false)
    expect(patch.configStaleKind).toBeNull()
  })
})

describe("denormalizeSnapshot — tool call raw output", () => {
  function snapshotWithOutput(
    output: ToolCallState["output"]
  ): LiveSessionSnapshot {
    return baseSnapshot({
      live_message: {
        id: "lm-1",
        role: "assistant",
        started_at: "2026-08-19T00:00:00Z",
        content: [{ kind: "tool_call_ref", tool_call_id: "tc-1" }],
      },
      active_tool_calls: [
        {
          id: "tc-1",
          kind: "other",
          label: "get_delegation_status",
          status: "completed",
          input: null,
          output,
          content: null,
          locations: null,
          meta: null,
        },
      ],
    })
  }

  function hydratedToolInfo(output: ToolCallState["output"]) {
    const block = denormalizeSnapshot(snapshotWithOutput(output)).liveMessage
      ?.content[0]
    if (block?.type !== "tool_call") throw new Error("expected a tool_call")
    return block.info
  }

  // The bug: `JSON.stringify(tc.output)` shipped the backend's tagged enum as
  // the "raw output", so a delegation poll hydrated from a snapshot painted
  // `{"kind":"json","value":{"tasks":[…]}}` into the card instead of its rows.
  it("hydrates a json output as the payload text, not the {kind,value} envelope", () => {
    const info = hydratedToolInfo({
      kind: "json",
      value: {
        tasks: [
          {
            task_id: "48464f33-2df2-4b9f-9eba-9134a9cafbd9",
            status: "running",
            agent_type: "codex",
            message: "Running.",
          },
        ],
      },
    })
    expect(info.raw_output_chunks).toEqual([
      '{"tasks":[{"task_id":"48464f33-2df2-4b9f-9eba-9134a9cafbd9","status":"running","agent_type":"codex","message":"Running."}]}',
    ])
    expect(info.raw_output_total_bytes).toBe(info.raw_output_chunks[0].length)

    // ...and the card's parser reads it, which is the user-visible symptom.
    const reports = parseStatusReports(info.raw_output_chunks.join(""), null)
    expect(reports).toHaveLength(1)
    expect(reports[0].taskId).toBe("48464f33-2df2-4b9f-9eba-9134a9cafbd9")
    expect(reports[0].status).toBe("running")
    expect(reports[0].text).toBe("Running.")
  })

  it("hydrates a text output verbatim", () => {
    const info = hydratedToolInfo({ kind: "text", content: "file contents" })
    expect(info.raw_output_chunks).toEqual(["file contents"])
    expect(info.raw_output_total_bytes).toBe("file contents".length)
  })

  // The backend promotes `{"error": "…"}` raw output to this variant, so the
  // inverse is that same object — readers find the error where they look.
  it("hydrates an error output as the {error} object it was promoted from", () => {
    const info = hydratedToolInfo({ kind: "error", message: "boom" })
    expect(info.raw_output_chunks).toEqual(['{"error":"boom"}'])
    expect(JSON.parse(info.raw_output_chunks[0])).toEqual({ error: "boom" })
  })

  it("leaves the chunks empty when the tool call has no output yet", () => {
    const info = hydratedToolInfo(null)
    expect(info.raw_output_chunks).toEqual([])
    expect(info.raw_output_total_bytes).toBe(0)
  })

  // An empty output is a real (empty) output, not an absent one — the live
  // reducer pushes `[""]` for `raw_output: ""` too, and the consumer's
  // `chunks.length > 0 ? joined : content` precedence must read the same on
  // both paths.
  it("keeps an empty text output as an empty chunk, not as no output", () => {
    const info = hydratedToolInfo({ kind: "text", content: "" })
    expect(info.raw_output_chunks).toEqual([""])
    expect(info.raw_output_total_bytes).toBe(0)
  })
})

describe("denormalizeSnapshot — last_error", () => {
  it("carries last_error.message into the patch", () => {
    const patch = denormalizeSnapshot(
      baseSnapshot({
        last_error: {
          message: " ACP protocol error: Forbidden ",
          code: "forbidden",
        },
      })
    )
    expect(patch.lastError).toBe("ACP protocol error: Forbidden")
    // The code rides along so the provider can localize the message the same
    // way it localizes the live `error` event.
    expect(patch.lastErrorCode).toBe("forbidden")
    expect(patch.lastErrorLevel).toBe("error")
    expect(patch.status).toBe("connected")
  })

  it("routes the level off the code", () => {
    const patch = denormalizeSnapshot(
      baseSnapshot({
        last_error: {
          message: "Failed to load session, starting new: gone",
          code: "session_load_fallback",
        },
      })
    )
    expect(patch.lastErrorLevel).toBe("warning")
  })

  it("defaults lastError to null when the field is absent", () => {
    const snap = baseSnapshot()
    delete (snap as { last_error?: unknown }).last_error
    const patch = denormalizeSnapshot(snap)
    expect(patch.lastError).toBeNull()
    expect(patch.lastErrorCode).toBeNull()
    expect(patch.status).toBe("connected")
  })
})

import { describe, expect, it } from "vitest"

import {
  buildDelegationTaskRows,
  deriveBadge,
  formatDuration,
  parseStatusReport,
  parseStatusReports,
  parseTaskId,
  parseTaskIds,
  taskEnding,
} from "./delegation-status"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

// Mirrors the MCP CallToolResult envelope the companion emits.
function envelope(report: Record<string, unknown>, isError = false): string {
  const text =
    report.status === "completed"
      ? ((report.text ?? report.message ?? "") as string)
      : ((report.message ?? report.text ?? "") as string)
  return JSON.stringify({
    content: [{ type: "text", text }],
    isError,
    structuredContent: report,
  })
}

/**
 * codex's LIVE wire shape. codex-acp forwards every MCP call's outcome as
 * `rawOutput = { result: <CallToolResult>, error: <string|null> }`
 * (`createMcpRawOutput`), so the card sees the CallToolResult one level down —
 * unlike codex's persisted rollout, which carries the bare
 * `Wall time:…\nOutput:\n<json>` text.
 */
function codexLiveEnvelope(callToolResult: string): string {
  return JSON.stringify({
    error: null,
    result: { meta: null, ...JSON.parse(callToolResult) },
  })
}

describe("parseTaskId", () => {
  it("reads a plain task_id", () => {
    expect(parseTaskId(JSON.stringify({ task_id: "abc12345" }))).toBe(
      "abc12345"
    )
  })

  it("peels a double-encoded input", () => {
    const input = JSON.stringify(JSON.stringify({ task_id: "abc12345" }))
    expect(parseTaskId(input)).toBe("abc12345")
  })

  it("peels a host wrapper key (arguments as JSON string)", () => {
    const input = JSON.stringify({
      arguments: JSON.stringify({ task_id: "abc12345" }),
    })
    expect(parseTaskId(input)).toBe("abc12345")
  })

  it("returns null for unparseable / missing input", () => {
    expect(parseTaskId("not json")).toBeNull()
    expect(parseTaskId(null)).toBeNull()
    expect(parseTaskId(undefined)).toBeNull()
  })
})

describe("parseTaskIds", () => {
  it("reads a task_ids array", () => {
    expect(parseTaskIds(JSON.stringify({ task_ids: ["a", "b"] }))).toEqual([
      "a",
      "b",
    ])
  })

  it("reads a legacy single task_id as a singleton", () => {
    expect(parseTaskIds(JSON.stringify({ task_id: "x" }))).toEqual(["x"])
  })

  it("merges task_ids and a lone task_id, de-duping in order", () => {
    expect(
      parseTaskIds(JSON.stringify({ task_ids: ["a", "b"], task_id: "a" }))
    ).toEqual(["a", "b"])
  })

  it("peels a host wrapper / double-encoded array", () => {
    const input = JSON.stringify({
      arguments: JSON.stringify({ task_ids: ["a", "b"] }),
    })
    expect(parseTaskIds(input)).toEqual(["a", "b"])
  })

  it("returns [] for unparseable / missing input", () => {
    expect(parseTaskIds("not json")).toEqual([])
    expect(parseTaskIds(null)).toEqual([])
    expect(parseTaskIds(undefined)).toEqual([])
  })
})

// A batch `{tasks:[...]}` MCP envelope: content text mirrors the structured
// payload so a content-only host (Claude Code) can still recover it.
function batchEnvelope(
  tasks: Record<string, unknown>[],
  isError = false
): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ tasks }) }],
    isError,
    structuredContent: { tasks },
  })
}

describe("parseStatusReports", () => {
  it("returns a single report for a non-batch envelope", () => {
    const reports = parseStatusReports(
      envelope({ task_id: "t1", status: "completed", text: "hi" }),
      null
    )
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ status: "completed", taskId: "t1" })
  })

  it("expands a structuredContent tasks array into one report per task", () => {
    const reports = parseStatusReports(
      batchEnvelope([
        { task_id: "t1", status: "completed", text: "r1", duration_ms: 5 },
        { task_id: "t2", status: "running", message: "Running." },
      ]),
      null
    )
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({
      status: "completed",
      taskId: "t1",
      text: "r1",
      durationMs: 5,
    })
    expect(reports[1]).toMatchObject({ status: "running", taskId: "t2" })
  })

  it("carries each task's progress, from either copy of the batch", () => {
    const progress = {
      steps: 3,
      marks: ["ok", "failed", "ok"],
      last_step: "pnpm test",
    }
    const expected = {
      steps: 3,
      marks: ["ok", "failed", "ok"],
      lastStep: "pnpm test",
    }
    const structured = parseStatusReports(
      batchEnvelope([{ task_id: "t1", status: "running", progress }]),
      null
    )
    expect(structured[0]!.progress).toEqual(expected)
    // Claude Code keeps only the content text: the same JSON.
    const contentOnly = parseStatusReports(
      JSON.stringify({
        tasks: [{ task_id: "t1", status: "completed", text: "ok", progress }],
      }),
      null
    )
    expect(contentOnly[0]!.progress).toEqual(expected)
    // A report from before the field has none.
    const old = parseStatusReports(
      batchEnvelope([{ task_id: "t1", status: "completed", text: "ok" }]),
      null
    )
    expect(old[0]!.progress).toBeNull()
  })

  it("recovers a tasks array from content-only JSON (no structuredContent)", () => {
    // Hosts that persist only CallToolResult.content text get the JSON itself.
    const text = JSON.stringify({
      tasks: [
        { task_id: "t1", status: "failed", error_code: "spawn_failed" },
        { task_id: "t2", status: "completed", text: "ok" },
      ],
    })
    const reports = parseStatusReports(text, null)
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({
      status: "failed",
      taskId: "t1",
      errorCode: "spawn_failed",
    })
    expect(reports[1]).toMatchObject({ status: "completed", taskId: "t2" })
  })

  it("recovers a tasks array embedded in surrounding text (Codex)", () => {
    const text = `Wall time: 1.2s\nOutput:\n${JSON.stringify({
      tasks: [{ task_id: "t1", status: "completed", text: "done" }],
    })}`
    const reports = parseStatusReports(text, null)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ status: "completed", taskId: "t1" })
  })

  it("peels a double-encoded batch envelope (JSON-of-JSON)", () => {
    // A host that re-stringifies the result text — the batch counterpart of the
    // double-encoded INPUT path (see parseTaskIds). One peel must still surface
    // every per-task report, not collapse to a single unstructured fallback.
    const output = JSON.stringify(
      batchEnvelope([
        { task_id: "t1", status: "completed", text: "A done" },
        { task_id: "t2", status: "failed", error_code: "timeout" },
      ])
    )
    const reports = parseStatusReports(output, null)
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ status: "completed", taskId: "t1" })
    expect(reports[1]).toMatchObject({
      status: "failed",
      taskId: "t2",
      errorCode: "timeout",
    })
  })

  it("peels codex's live {result, error} wrapper around a batch", () => {
    // Codex as the MAIN agent: the whole envelope used to fall through as
    // opaque text, so one anonymous row rendered the raw JSON instead of one
    // row per task.
    const reports = parseStatusReports(
      codexLiveEnvelope(
        batchEnvelope([
          {
            task_id: "8cb72a7c",
            status: "running",
            message: "Running.\nLatest sub-agent reply: thinking",
          },
          {
            task_id: "9c232105",
            status: "completed",
            text: "done",
            duration_ms: 42,
          },
        ])
      ),
      null
    )
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ status: "running", taskId: "8cb72a7c" })
    expect(reports[1]).toMatchObject({
      status: "completed",
      taskId: "9c232105",
      text: "done",
      durationMs: 42,
    })
  })

  it("peels codex's rollout {Ok} serde variant around a batch", () => {
    const output = JSON.stringify({
      Ok: JSON.parse(
        batchEnvelope([{ task_id: "t1", status: "completed", text: "ok" }])
      ),
    })
    const reports = parseStatusReports(output, null)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ status: "completed", taskId: "t1" })
  })

  it("does NOT treat a tasks array of non-reports as a batch", () => {
    // A child whose own output is {tasks:[...]} of non-report objects must not
    // be misread — it falls back to the single-report path.
    const text = JSON.stringify({ tasks: [{ foo: 1 }, { bar: 2 }] })
    const reports = parseStatusReports(text, null)
    expect(reports).toHaveLength(1)
  })
})

describe("parseStatusReport", () => {
  it("recovers a structuredContent report (status + duration)", () => {
    const report = parseStatusReport(
      envelope({
        task_id: "abc12345",
        status: "completed",
        text: "All done.",
        duration_ms: 1234,
      }),
      null
    )
    expect(report.status).toBe("completed")
    expect(report.durationMs).toBe(1234)
    expect(report.text).toBe("All done.")
  })

  it("recovers a Codex-wrapped report (Wall time prefix)", () => {
    const inner = JSON.stringify({ task_id: "abc12345", status: "unknown" })
    const report = parseStatusReport(
      `Wall time: 1 seconds\nOutput:\n${inner}_`,
      null
    )
    expect(report.status).toBe("unknown")
  })

  it("peels a double-encoded report envelope (JSON-of-JSON)", () => {
    // Symmetric with the batch path: a re-stringified single-task result must
    // still recover its structured status rather than degrade to plain text.
    const output = JSON.stringify(
      envelope({
        task_id: "abc12345",
        status: "completed",
        text: "All done.",
        duration_ms: 1234,
      })
    )
    const report = parseStatusReport(output, null)
    expect(report.status).toBe("completed")
    expect(report.taskId).toBe("abc12345")
    expect(report.durationMs).toBe(1234)
  })

  it("peels codex's live {result, error} wrapper around a single report", () => {
    const report = parseStatusReport(
      codexLiveEnvelope(
        envelope({
          task_id: "abc12345",
          status: "completed",
          text: "All done.",
          duration_ms: 1234,
        })
      ),
      null
    )
    expect(report.status).toBe("completed")
    expect(report.taskId).toBe("abc12345")
    expect(report.durationMs).toBe(1234)
    expect(report.text).toBe("All done.")
  })

  it("shows a failed host envelope's error string, not the envelope JSON", () => {
    // codex-acp sets `error` and leaves `result` null when the MCP call itself
    // failed — there is no result to peel to, so the error text is all there is.
    const report = parseStatusReport(
      JSON.stringify({ error: "mcp server disconnected", result: null }),
      null
    )
    expect(report.text).toBe("mcp server disconnected")
  })

  it("renders a child's own `result`-shaped payload verbatim", () => {
    // The peel finds no CallToolResult under `result`, so nothing is recovered
    // and the child's output still displays as-is.
    const childOutput = JSON.stringify({ result: { rows: 3 }, error: null })
    const report = parseStatusReport(childOutput, null)
    expect(report.status).toBeNull()
    expect(report.taskId).toBeNull()
    expect(report.text).toBe(childOutput)
  })

  it("does NOT read a child's nested {status, task_id} as a report", () => {
    // The nastiest shape: peeling on the `result` KEY alone would surface a
    // report-looking object and repaint opaque child output as a failed task.
    // Only a real CallToolResult (content / structuredContent) may be peeled to.
    const childOutput = JSON.stringify({
      result: { status: "failed", task_id: "child-job", message: "domain" },
    })
    const report = parseStatusReport(childOutput, null)
    expect(report.status).toBeNull()
    expect(report.taskId).toBeNull()
    expect(report.text).toBe(childOutput)
  })

  it("does NOT treat a child's own `error` field as a host failure", () => {
    // No `result` key ⇒ not codex-acp's failure envelope, so the payload stays
    // whole instead of collapsing to the error string.
    const childOutput = JSON.stringify({ error: "domain validation", rows: [] })
    const report = parseStatusReport(childOutput, null)
    expect(report.status).toBeNull()
    expect(report.text).toBe(childOutput)
  })

  it("does NOT treat a child's own JSON-with-status as a report (no task_id)", () => {
    const childOutput = JSON.stringify({ status: "failed", message: "child" })
    const report = parseStatusReport(childOutput, null)
    expect(report.status).toBeNull()
    expect(report.text).toBe(childOutput)
  })

  it("keeps plain text as the displayable result", () => {
    const report = parseStatusReport("Sub-agent finished.", null)
    expect(report.status).toBeNull()
    expect(report.text).toBe("Sub-agent finished.")
  })

  it("reads the running sentinel from content-only text (no structuredContent)", () => {
    // Historical Claude reload drops structuredContent; only the backend's
    // running message survives. It must still resolve to a running status so the
    // badge becomes the neutral 'checked', not a false 'ok' ("done").
    const report = parseStatusReport(
      "Sub-agent is still running in the background.",
      null
    )
    expect(report.status).toBe("running")
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "checked",
    })
  })

  it("reads the bare 'Running.' running message from content-only text", () => {
    // Current backend baseline: running_report emits the bare "Running." On a
    // content-only host (structuredContent dropped) this is the only signal,
    // so it must resolve to running, not a false 'ok'.
    const report = parseStatusReport("Running.", null)
    expect(report.status).toBe("running")
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "checked",
    })
  })

  it("reads the two-line 'Running.\\nLatest sub-agent reply: …' upgraded message", () => {
    // The live hint lands on its own line; the standalone first-line marker
    // identifies "still running" and the child's reply text is preserved.
    const report = parseStatusReport(
      "Running.\nLatest sub-agent reply: Reading config.rs",
      null
    )
    expect(report.status).toBe("running")
    expect(report.text).toBe(
      "Running.\nLatest sub-agent reply: Reading config.rs"
    )
  })

  it("reads the two-line 'Running.\\nAwaiting your decision: …' blocked message", () => {
    // #447: a sub-agent parked on a permission still reports status `running`,
    // so a content-only host must recognize the blocked second line the same
    // way it recognizes the live-reply one — otherwise the poll degrades to a
    // false 'ok' ("done") for a sub-agent that has not moved at all.
    const report = parseStatusReport(
      "Running.\nAwaiting your decision: rm -rf /tmp/x",
      null
    )
    expect(report.status).toBe("running")
    expect(report.blockedOn).toBe("permission")
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "waiting",
    })
  })

  it("reads structured blocked_on from the report envelope", () => {
    const report = parseStatusReport(
      envelope({
        task_id: "abc12345",
        status: "running",
        message: "Running.\nAwaiting your decision: a question",
        blocked_on: { kind: "question", request_id: "q-1", title: "which?" },
      }),
      null
    )
    expect(report.status).toBe("running")
    expect(report.blockedOn).toBe("question")
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "waiting",
    })
  })

  it("treats an unrecognized blocked_on kind as still blocked", () => {
    // A newer backend adding a fourth kind must not silently degrade to
    // "working" — the presence of the field is the load-bearing signal.
    const report = parseStatusReport(
      envelope({
        task_id: "abc12345",
        status: "running",
        message: "Running.",
        blocked_on: { kind: "some_future_kind", request_id: "x-1" },
      }),
      null
    )
    expect(report.blockedOn).toBe("permission")
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "waiting",
    })
  })

  it("leaves an ordinary running poll unblocked", () => {
    const report = parseStatusReport(
      "Running.\nLatest sub-agent reply: Reading config.rs",
      null
    )
    expect(report.blockedOn).toBeNull()
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "checked",
    })
  })

  it("does NOT misread a completed single-line 'Running. Awaiting your decision: …' result as running", () => {
    // Same anchoring rule as the live-reply variant: the marker must be a
    // standalone first line, so child-controlled text that merely starts with
    // the phrase can't fake a block.
    const report = parseStatusReport(
      "Running. Awaiting your decision: nothing, I already finished.",
      null
    )
    expect(report.status).toBeNull()
    expect(report.blockedOn).toBeNull()
  })

  it("does NOT misread a completed single-line 'Running. Latest sub-agent reply: …' result as running", () => {
    // A completed child answer whose text merely STARTS WITH the running phrase
    // on one line (no standalone marker line) must resolve to a terminal status,
    // not running — the reply text is child-controlled and never anchored on.
    const report = parseStatusReport(
      "Running. Latest sub-agent reply: I finished, nothing else is running.",
      null
    )
    expect(report.status).toBeNull()
  })

  it("does NOT treat a completed result whose first line only starts with 'Running' as running", () => {
    // Anchored on the WHOLE first line being exactly "Running.", so "Running…"
    // variants or "Running. <more on the same line>" do not match.
    expect(
      parseStatusReport("Running the migration now.", null).status
    ).toBeNull()
    expect(
      parseStatusReport(
        "Running.\nAll tests pass and nothing is pending.",
        null
      ).status
    ).toBeNull()
  })

  it("does NOT treat an ordinary completion result as still-running", () => {
    const report = parseStatusReport("The migration finished cleanly.", null)
    expect(report.status).toBeNull()
  })

  it("does NOT classify a result that merely mentions 'Running.' mid-text as running", () => {
    // Anchored match, not a loose substring: a completed child can incidentally
    // write the word.
    const report = parseStatusReport(
      "All checks passed. Running. tests are green now.",
      null
    )
    expect(report.status).toBeNull()
  })

  it("does NOT classify a longer result that merely quotes the sentinel as running", () => {
    // A completed child result could embed the phrase; only an exact-match
    // sentinel is the backend's running signal.
    const report = parseStatusReport(
      "I saw: Sub-agent is still running in the background. So I waited and it finished.",
      null
    )
    expect(report.status).toBeNull()
  })

  it("surfaces the report's task_id, and null when absent", () => {
    expect(
      parseStatusReport(
        envelope({ task_id: "abc12345", status: "completed", text: "ok" }),
        null
      ).taskId
    ).toBe("abc12345")
    expect(parseStatusReport("plain output", null).taskId).toBeNull()
  })
})

describe("deriveBadge", () => {
  const empty = parseStatusReport(null, null)

  it("maps a RETURNED running poll to the neutral checked state (not a spinner)", () => {
    const report = parseStatusReport(
      envelope({ task_id: "abc12345", status: "running", message: "working" }),
      null
    )
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "checked",
    })
  })

  it("keeps a spinner for an in-flight poll (no result yet)", () => {
    expect(deriveBadge("status", empty, "input-available", false)).toEqual({
      status: "running",
    })
    expect(deriveBadge("status", empty, "input-streaming", false)).toEqual({
      status: "running",
    })
  })

  it("maps completed → ok", () => {
    const report = parseStatusReport(
      envelope({ task_id: "abc12345", status: "completed", text: "ok" }),
      null
    )
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "ok",
    })
  })

  it("maps failed/unknown to errors", () => {
    const failed = parseStatusReport(
      envelope({ task_id: "x", status: "failed", error_code: "timeout" }, true),
      null
    )
    expect(deriveBadge("status", failed, "output-error", true)).toEqual({
      status: "err",
      errorCode: "timeout",
    })
    const unknown = parseStatusReport(
      envelope({ task_id: "x", status: "unknown" }),
      null
    )
    expect(deriveBadge("status", unknown, "output-available", false)).toEqual({
      status: "err",
      errorCode: "unknown",
    })
  })

  it("treats canceled as success for cancel, terminal error for a status query", () => {
    const report = parseStatusReport(
      envelope({ task_id: "x", status: "canceled", error_code: "canceled" }),
      null
    )
    expect(deriveBadge("cancel", report, "output-available", false)).toEqual({
      status: "ok",
    })
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "err",
      errorCode: "canceled",
    })
  })

  it("falls back to ok for a returned poll with no parseable status", () => {
    const report = parseStatusReport("done", null)
    expect(deriveBadge("status", report, "output-available", false)).toEqual({
      status: "ok",
    })
  })
})

describe("taskEnding", () => {
  const report = (body: Record<string, unknown>) =>
    parseStatusReport(envelope({ task_id: "x", ...body }), null)

  it("reads a finished task's outcome off the check", () => {
    expect(taskEnding(report({ status: "completed", text: "ok" }))).toEqual({
      status: "ok",
      errorCode: undefined,
    })
    expect(
      taskEnding(report({ status: "failed", error_code: "timeout" }))
    ).toEqual({ status: "err", errorCode: "timeout" })
    expect(taskEnding(report({ status: "canceled" }))).toEqual({
      status: "err",
      errorCode: "canceled",
    })
    // The broker no longer knows the task: it is not running anywhere.
    expect(taskEnding(report({ status: "unknown" }))).toEqual({
      status: "err",
      errorCode: "unknown",
    })
  })

  it("says nothing while the task runs, or when the check named no outcome", () => {
    expect(taskEnding(report({ status: "running" }))).toBeNull()
    expect(taskEnding(parseStatusReport("done", null))).toBeNull()
    expect(taskEnding(null)).toBeNull()
  })
})

describe("formatDuration", () => {
  it("formats sub-second, second and minute spans", () => {
    expect(formatDuration(350)).toBe("350ms")
    expect(formatDuration(1234)).toBe("1.2s")
    expect(formatDuration(12_000)).toBe("12s")
    expect(formatDuration(119_999)).toBe("2m 0s")
  })
})

describe("buildDelegationTaskRows", () => {
  function statusPoll(
    over: Partial<AdaptedToolCallPart> = {}
  ): AdaptedToolCallPart {
    return {
      type: "tool-call",
      toolCallId: "sp",
      toolName: "get_delegation_status",
      input: null,
      state: "output-available",
      ...over,
    }
  }

  const doneReport = envelope({
    status: "completed",
    task_id: "t1",
    text: "ok",
    duration_ms: 1000,
  })

  it("collapses repeated polls of one task into a single row", () => {
    const rows = buildDelegationTaskRows([
      statusPoll({
        toolCallId: "p1",
        input: JSON.stringify({ task_ids: ["t1"] }),
        output: doneReport,
      }),
      statusPoll({
        toolCallId: "p2",
        input: JSON.stringify({ task_ids: ["t1"] }),
        output: doneReport,
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].taskId).toBe("t1")
  })

  it("builds one row per task from a codex live-wire batch poll", () => {
    // End-to-end shape of the reported bug: with codex as the main agent the
    // `{result, error}` wrapper hid the batch, collapsing both tasks into one
    // anonymous row whose body was the raw envelope JSON and whose badge fell
    // back to "ok" (output-available) even for the still-running task.
    const rows = buildDelegationTaskRows([
      statusPoll({
        toolCallId: "p1",
        input: JSON.stringify({ task_ids: ["t1", "t2"], wait_ms: 60000 }),
        output: codexLiveEnvelope(
          batchEnvelope([
            { task_id: "t1", status: "running", message: "Running." },
            {
              task_id: "t2",
              status: "completed",
              text: "review done",
              duration_ms: 3000,
            },
          ])
        ),
      }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].taskId).toBe("t1")
    // A poll that RETURNED while the task ran is a settled snapshot, not a
    // spinner — and definitely not "ok".
    expect(rows[0].badge.status).toBe("checked")
    expect(rows[1].taskId).toBe("t2")
    expect(rows[1].badge.status).toBe("ok")
    expect(rows[1].results).toEqual(["review done"])
    expect(rows[1].report.durationMs).toBe(3000)
  })

  it("drops a live arg-less in-flight orphan poll (no id, nothing to show)", () => {
    const rows = buildDelegationTaskRows([
      statusPoll({ input: "{}", output: null, state: "input-available" }),
    ])
    expect(rows).toHaveLength(0)
  })

  it("drops a promoted orphan (output-available but status still unsettled)", () => {
    // COMPLETE_TURN promotes the unpruned orphan: its state flips to
    // output-available, but its forwarded ACP status stays pending. It must not
    // re-stack as an anonymous row after the turn completes.
    const rows = buildDelegationTaskRows([
      statusPoll({
        input: "{}",
        output: null,
        state: "output-available",
        toolStatus: "pending",
      }),
    ])
    expect(rows).toHaveLength(0)
  })

  it("keeps a settled id-less interim note (a real message, not an orphan)", () => {
    // Has real text → not "nothing to show", so the drop never fires. Guards
    // against over-dropping genuine notes that happen to lack an id.
    const rows = buildDelegationTaskRows([
      statusPoll({
        input: "{}",
        output: "still working on it",
        state: "output-available",
        toolStatus: "completed",
      }),
    ])
    expect(rows).toHaveLength(1)
  })

  it("does not stack promoted orphans next to the real task row", () => {
    // The reported bug: after the turn completed, orphan polls re-appeared as
    // anonymous "等待任务执行结果" rows beside the real #t1 row.
    const rows = buildDelegationTaskRows([
      statusPoll({
        toolCallId: "real",
        input: JSON.stringify({ task_ids: ["t1"] }),
        output: doneReport,
      }),
      statusPoll({
        toolCallId: "orphan1",
        input: "{}",
        output: null,
        state: "output-available",
        toolStatus: "pending",
      }),
      statusPoll({
        toolCallId: "orphan2",
        input: "{}",
        output: null,
        state: "output-available",
        toolStatus: "in_progress",
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].taskId).toBe("t1")
  })
})

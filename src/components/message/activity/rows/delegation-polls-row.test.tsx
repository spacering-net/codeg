import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import type {
  AdaptedToolCallPart,
  ToolCallState,
} from "@/lib/adapters/ai-elements-adapter"
import enMessages from "@/i18n/messages/en.json"
import { ContentPartsRenderer } from "../../content-parts-renderer"

/**
 * An agent's `get_delegation_status` checks, as the timeline draws them when
 * they stand apart from the delegation they check on: one row per task, its
 * latest result and how many times it was checked.
 */

// Stub the heavy Markdown renderer to a sentinel that echoes its source.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown-response">{children}</div>
  ),
}))

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** A run of checks, as the adapter groups them, drawn by the reply renderer. */
function PollRows({ polls }: { polls: AdaptedToolCallPart[] }) {
  return (
    <ContentPartsRenderer
      parts={[{ type: "delegation-status-group", polls }]}
      role="assistant"
    />
  )
}

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

let seq = 0
function poll(
  taskId: string,
  opts: {
    output?: string
    state?: ToolCallState
    /** Override the call arguments (pass `null` to simulate a lost input). */
    input?: string | null
  } = {}
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: `poll-${taskId}-${seq++}`,
    toolName: "get_delegation_status",
    input:
      opts.input !== undefined
        ? opts.input
        : JSON.stringify({ task_id: taskId }),
    state: opts.state ?? "output-available",
    output: opts.output ?? null,
  }
}

// A batch `{tasks:[...]}` MCP envelope, mirroring the content text into
// structuredContent so the content-only host path is also exercised.
function batchEnvelope(tasks: Record<string, unknown>[]): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ tasks }) }],
    isError: false,
    structuredContent: { tasks },
  })
}

// A single `get_delegation_status` poll that fanned out over many task_ids.
function batchPoll(
  taskIds: string[],
  tasks: Record<string, unknown>[],
  opts: { state?: ToolCallState } = {}
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: `batch-${seq++}`,
    toolName: "get_delegation_status",
    input: JSON.stringify({ task_ids: taskIds }),
    state: opts.state ?? "output-available",
    output: batchEnvelope(tasks),
  }
}

describe("delegation status checks", () => {
  it("collapses N polls of one task into a single row with its final outcome", () => {
    renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({ task_id: "abc12345", status: "running" }),
          }),
          poll("abc12345", {
            output: envelope({ task_id: "abc12345", status: "running" }),
          }),
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "completed",
              text: "All tests pass.",
            }),
          }),
        ]}
      />
    )
    // All polls collapse into a single row per task.
    expect(
      screen.getAllByText("Waiting for task #abc12345 result")
    ).toHaveLength(1)
    expect(screen.getByText("done")).toBeInTheDocument()
    // ×N reflects the actual number of polls (3) and matches the pager total.
    expect(screen.getByText("×3")).toBeInTheDocument()
    // Its header inks in on hover, as the timeline's other rows do
    // (`.activity-row-toggle` in globals.css).
    expect(screen.getByRole("button")).toHaveClass("activity-row-toggle")
    expect(screen.getByText("×3")).toHaveClass("text-activity-secondary")
    fireEvent.click(screen.getByRole("button"))
    // Default page is the latest poll's result.
    expect(screen.getByText("All tests pass.")).toBeInTheDocument()
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
    expect(screen.getByLabelText("Next result")).toBeDisabled()
    // The interim polls returned no result text — they page to a placeholder.
    fireEvent.click(screen.getByLabelText("Previous result"))
    expect(
      screen.getByText("No result captured for this check.")
    ).toBeInTheDocument()
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
  })

  it("shows the neutral 'checked' badge (no spinner) when the latest poll returned still-running", () => {
    const { container } = renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "still working",
            }),
          }),
        ]}
      />
    )
    expect(screen.getByText("checked")).toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
  })

  it("keeps the live spinner for a poll still in flight", () => {
    const { container } = renderWithIntl(
      <PollRows polls={[poll("abc12345", { state: "input-available" })]} />
    )
    expect(container.querySelector(".animate-spin")).toBeInTheDocument()
  })

  it("suppresses an in-flight poll whose task_ids have not streamed in yet", () => {
    // claude-agent-acp ships an arg-less initial tool_call (rawInput `{}`) and
    // fills the real `task_ids` only on a later update, so a still-blocking live
    // poll has neither an input id nor an output report. It must NOT render as an
    // anonymous "waiting for a task's result" row.
    const { container } = renderWithIntl(
      <PollRows polls={[poll("", { input: "{}", state: "input-available" })]} />
    )
    expect(container.querySelector("li")).toBeNull()
    expect(
      screen.queryByText("Waiting for task result")
    ).not.toBeInTheDocument()
  })

  it("does not stack repeated id-less in-flight re-polls into duplicate rows", () => {
    // The reported bug: N concurrent/re-issued anonymous polls each became a
    // separate "waiting for a task's result" row. With one task attributed via
    // its returned report and three id-less in-flight checks, only the attributed
    // row survives.
    renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({ task_id: "abc12345", status: "running" }),
          }),
          poll("", { input: "{}", state: "input-available" }),
          poll("", { input: null, state: "input-available" }),
          poll("", { input: "{}", state: "input-streaming" }),
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #abc12345 result")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Waiting for task result")
    ).not.toBeInTheDocument()
  })

  it("renders one row per task for parallel waits", () => {
    renderWithIntl(
      <PollRows
        polls={[
          poll("aaaa1111", {
            output: envelope({ task_id: "aaaa1111", status: "running" }),
          }),
          poll("bbbb2222", {
            output: envelope({ task_id: "bbbb2222", status: "running" }),
          }),
          poll("aaaa1111", {
            output: envelope({
              task_id: "aaaa1111",
              status: "completed",
              text: "A done",
            }),
          }),
          poll("bbbb2222", {
            output: envelope({
              task_id: "bbbb2222",
              status: "completed",
              text: "B done",
            }),
          }),
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #aaaa1111 result")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Waiting for task #bbbb2222 result")
    ).toBeInTheDocument()
    expect(screen.getAllByText("done")).toHaveLength(2)
  })

  it("expands a single batch poll into one row per task", () => {
    renderWithIntl(
      <PollRows
        polls={[
          batchPoll(
            ["aaaa1111", "bbbb2222"],
            [
              { task_id: "aaaa1111", status: "completed", text: "A done" },
              { task_id: "bbbb2222", status: "running", message: "Running." },
            ]
          ),
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #aaaa1111 result")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Waiting for task #bbbb2222 result")
    ).toBeInTheDocument()
    // A completed → done; B returned-running → neutral checked.
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
  })

  it("renders a single-id poll's one-element {tasks:[..]} envelope as one clean row", () => {
    // The unified companion output: even a single-id poll
    // (`{ task_ids: ["x"] }`) now returns a one-element `{tasks:[..]}` envelope
    // rather than a bare single report. It must still resolve to ONE row, with
    // the task's badge + result, and no ×N (polled once).
    renderWithIntl(
      <PollRows
        polls={[
          batchPoll(
            ["abc12345"],
            [{ task_id: "abc12345", status: "completed", text: "All done." }]
          ),
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #abc12345 result")
    ).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("All done.")).toBeInTheDocument()
  })

  it("groups a task across mixed batch + single polls and counts ×N", () => {
    renderWithIntl(
      <PollRows
        polls={[
          batchPoll(
            ["aaaa1111", "bbbb2222"],
            [
              { task_id: "aaaa1111", status: "running", message: "Running." },
              { task_id: "bbbb2222", status: "running", message: "Running." },
            ]
          ),
          // A later single poll re-checks just task A, now completed.
          poll("aaaa1111", {
            output: envelope({
              task_id: "aaaa1111",
              status: "completed",
              text: "A finished",
            }),
          }),
        ]}
      />
    )
    // Two rows; task A was checked twice (batch + single) → ×2 and completed.
    expect(
      screen.getByText("Waiting for task #aaaa1111 result")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Waiting for task #bbbb2222 result")
    ).toBeInTheDocument()
    expect(screen.getByText("×2")).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
  })

  it("keeps two un-attributable reports in one batch poll as separate rows", () => {
    // Neither the input nor the per-task reports carry a task_id — keyed by
    // toolCallId:index, they must not collapse into one row.
    renderWithIntl(
      <PollRows
        polls={[
          {
            type: "tool-call",
            toolCallId: "batch-x",
            toolName: "get_delegation_status",
            input: null,
            state: "output-available",
            output: JSON.stringify({
              content: [{ type: "text", text: "" }],
              isError: false,
              structuredContent: {
                tasks: [
                  { status: "completed", text: "first" },
                  { status: "failed", error_code: "timeout" },
                ],
              },
            }),
          },
        ]}
      />
    )
    expect(screen.getAllByText("Waiting for task result")).toHaveLength(2)
  })

  it("renders a row per requested task while a batch poll is still in flight", () => {
    // No output yet: the poll references two task_ids but parses to a single
    // empty report. Both tasks must still appear (as spinners) — not just the
    // first — so a pending fan-out doesn't hide siblings until it resolves.
    renderWithIntl(
      <PollRows
        polls={[
          {
            type: "tool-call",
            toolCallId: "inflight-batch",
            toolName: "get_delegation_status",
            input: JSON.stringify({ task_ids: ["aaaa1111", "bbbb2222"] }),
            state: "input-available",
            output: null,
          },
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #aaaa1111 result")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Waiting for task #bbbb2222 result")
    ).toBeInTheDocument()
  })

  it("shows the neutral 'checked' badge for a content-only returned-running poll", () => {
    // Historical reload: only the backend running sentinel survives (no
    // structuredContent). It must not read as a false 'done'.
    const { container } = renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: "Sub-agent is still running in the background.",
          }),
        ]}
      />
    )
    expect(screen.getByText("checked")).toBeInTheDocument()
    expect(screen.queryByText("done")).not.toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
  })

  it("keeps polls separate by their output task_id when the input lost the id", () => {
    // The call arguments carry no task_id, but each output's structured report
    // does — distinct tasks must NOT collapse into one row where the latest
    // hides the others.
    renderWithIntl(
      <PollRows
        polls={[
          poll("", {
            input: null,
            output: envelope({
              task_id: "aaaa1111",
              status: "completed",
              text: "A done",
            }),
          }),
          poll("", {
            input: null,
            output: envelope(
              { task_id: "bbbb2222", status: "failed", error_code: "timeout" },
              true
            ),
          }),
        ]}
      />
    )
    expect(
      screen.getByText("Waiting for task #aaaa1111 result")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Waiting for task #bbbb2222 result")
    ).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
  })

  it("does not collapse unattributable polls (no task_id anywhere) into one row", () => {
    // Neither input nor output yields a task_id — keep each poll as its own row
    // rather than letting the latest hide the earlier interim notes.
    renderWithIntl(
      <PollRows
        polls={[
          poll("", { input: null, output: "first interim note" }),
          poll("", { input: null, output: "second interim note" }),
        ]}
      />
    )
    expect(screen.getAllByText("Waiting for task result")).toHaveLength(2)
  })

  it("draws the row as failed when the only task failed", () => {
    const { container } = renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            state: "output-error",
            output: envelope(
              { task_id: "abc12345", status: "failed", error_code: "timeout" },
              true
            ),
          }),
        ]}
      />
    )
    expect(container.querySelector("li")).toHaveAttribute(
      "data-status",
      "failed"
    )
  })

  it("paginates through distinct poll results, latest shown first", () => {
    renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "Working on step 1",
            }),
          }),
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "Working on step 2",
            }),
          }),
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "completed",
              text: "All done",
            }),
          }),
        ]}
      />
    )
    // Expand the single row (only one button before expansion).
    fireEvent.click(screen.getByRole("button"))
    // ×N header hint matches the pager total — both count the polls.
    expect(screen.getByText("×3")).toBeInTheDocument()
    // Latest result is shown first, behind a 3-of-3 pager; "next" is disabled
    // at the last page.
    expect(screen.getByText("All done")).toBeInTheDocument()
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
    expect(screen.getByLabelText("Next result")).toBeDisabled()
    // Step back through the earlier polls' results.
    fireEvent.click(screen.getByLabelText("Previous result"))
    expect(screen.getByText("Working on step 2")).toBeInTheDocument()
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Previous result"))
    expect(screen.getByText("Working on step 1")).toBeInTheDocument()
    expect(screen.getByText("1 / 3")).toBeInTheDocument()
    // "previous" is disabled at the first page (no wrap-around).
    expect(screen.getByLabelText("Previous result")).toBeDisabled()
    // Forward again.
    fireEvent.click(screen.getByLabelText("Next result"))
    expect(screen.getByText("Working on step 2")).toBeInTheDocument()
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
  })

  it("shows one page per poll — ×N is the check count, repeats included", () => {
    renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "Still running",
            }),
          }),
          // Same text as the previous poll — kept as its own page (a real,
          // separate wait), NOT de-duplicated.
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "Still running",
            }),
          }),
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "completed",
              text: "Finished",
            }),
          }),
        ]}
      />
    )
    // 3 polls → ×3 → 3 pages, even though two polls share the same text.
    expect(screen.getByText("×3")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Finished")).toBeInTheDocument()
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Previous result"))
    expect(screen.getByText("Still running")).toBeInTheDocument()
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Previous result"))
    expect(screen.getByText("Still running")).toBeInTheDocument()
    expect(screen.getByText("1 / 3")).toBeInTheDocument()
    expect(screen.getByLabelText("Previous result")).toBeDisabled()
  })

  it("shows no pager and no ×N when the task was polled only once", () => {
    renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "completed",
              text: "Only result",
            }),
          }),
        ]}
      />
    )
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Only result")).toBeInTheDocument()
    expect(screen.queryByLabelText("Previous result")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Next result")).not.toBeInTheDocument()
  })

  it("keeps the latest result as the default page when more polls stream in", () => {
    // The row is keyed by task id and survives rerenders, so a default page
    // pinned at mount would strand a row first seen with one result on 1/M.
    const { rerender } = renderWithIntl(
      <PollRows
        polls={[
          poll("abc12345", {
            output: envelope({
              task_id: "abc12345",
              status: "running",
              message: "Interim 1",
            }),
          }),
        ]}
      />
    )
    // More polls arrive for the SAME task before the user expands anything.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PollRows
          polls={[
            poll("abc12345", {
              output: envelope({
                task_id: "abc12345",
                status: "running",
                message: "Interim 1",
              }),
            }),
            poll("abc12345", {
              output: envelope({
                task_id: "abc12345",
                status: "running",
                message: "Interim 2",
              }),
            }),
            poll("abc12345", {
              output: envelope({
                task_id: "abc12345",
                status: "completed",
                text: "Final result",
              }),
            }),
          ]}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button"))
    // Default page follows the latest result, not the stale initial index.
    expect(screen.getByText("Final result")).toBeInTheDocument()
    expect(screen.getByText("3 / 3")).toBeInTheDocument()
  })
})

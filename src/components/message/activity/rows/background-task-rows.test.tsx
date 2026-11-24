import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { ContentPartsRenderer } from "../../content-parts-renderer"

/**
 * A background task's polls (Claude Code's `TaskOutput`, Grok's
 * `get_command_or_subagent_output`), folded into one row per task: the latest
 * poll speaks for it.
 */

function renderPolls(polls: AdaptedToolCallPart[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer
        parts={[{ type: "background-task-group", polls }]}
        role="assistant"
      />
    </NextIntlClientProvider>
  )
}

function poll(over: Partial<AdaptedToolCallPart> = {}): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "TaskOutput",
    input: JSON.stringify({ task_id: "bfb5xnq1t", block: true, timeout: 1000 }),
    output: null,
    state: "output-available",
    ...over,
  }
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll("li"))
}

const RUNNING = `<retrieval_status>timeout</retrieval_status>\n<task_id>bfb5xnq1t</task_id>\n<task_type>local_bash</task_type>\n<status>running</status>`
const COMPLETED = `<retrieval_status>success</retrieval_status>\n<task_id>bfb5xnq1t</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>0</exit_code>\n<output>BUILD OK MARKER</output>`
const FAILED = `<retrieval_status>success</retrieval_status>\n<task_id>bfb5xnq1t</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>1</exit_code>\n<output>boom</output>`

describe("background task row", () => {
  it("folds repeated polls into one row with the final status", () => {
    renderPolls([
      poll({ toolCallId: "p1", output: RUNNING }),
      poll({ toolCallId: "p2", output: COMPLETED }),
    ])
    expect(rows()).toHaveLength(1)
    const row = within(rows()[0]!)
    expect(row.getByText("Task finished")).toBeInTheDocument()
    expect(row.getByText("#bfb5xnq1t")).toBeInTheDocument()
    expect(row.getByText("done")).toBeInTheDocument()
    // How many times it was polled, on hover.
    expect(rows()[0]!.querySelector('[title="Polled 2 times"]')).not.toBeNull()
  })

  it("sets its label, id and output line in one ink", () => {
    renderPolls([poll({ output: COMPLETED })])
    const row = within(rows()[0]!)
    for (const text of ["Task finished", "#bfb5xnq1t", "BUILD OK MARKER"]) {
      expect(row.getByText(text)).toHaveClass("text-activity-secondary")
    }
  })

  it("shows the output's first line, and the whole output when opened", () => {
    renderPolls([poll({ output: COMPLETED })])
    expect(screen.getByText("BUILD OK MARKER")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getAllByText(/BUILD OK MARKER/)).toHaveLength(2)
  })

  it("names a non-zero exit as the failure it is", () => {
    renderPolls([poll({ output: FAILED })])
    expect(rows()[0]).toHaveAttribute("data-status", "failed")
    expect(screen.getByText("Task failed")).toBeInTheDocument()
    expect(screen.getByText("exit 1")).toBeInTheDocument()
  })

  it("says it is running while a poll is in flight", () => {
    renderPolls([poll({ output: null, state: "input-available" })])
    expect(screen.getByText("Task running")).toBeInTheDocument()
    expect(rows()[0]).toHaveAttribute("data-status", "running")
  })

  it("names a Grok poll after the command it polled", () => {
    // Grok reports the same lifecycle as a JSON envelope.
    renderPolls([
      poll({
        toolName: "get_command_or_subagent_output",
        input: JSON.stringify({ task_ids: ["term_b0d"], timeout_ms: 15000 }),
        output: JSON.stringify({
          type: "TaskOutput",
          Result: {
            task_id: "term_b0d",
            command: "/bin/bash -lc 'pnpm dev -- --port 3001'",
            status: "failed",
            exit_code: 1,
            output: "INVALID DIRECTORY MARKER",
          },
        }),
      }),
    ])
    const row = rows()[0]!
    expect(row.textContent).toContain("/bin/bash -lc 'pnpm dev -- --port 3001'")
    expect(row).toHaveAttribute("data-status", "failed")
    expect(screen.getByText("exit 1")).toBeInTheDocument()
    // A failure opens itself, its output anchored at the end.
    expect(
      screen.getAllByText(/INVALID DIRECTORY MARKER/).length
    ).toBeGreaterThan(0)
  })

  it("draws a Grok sub-agent's report as prose, without the wire scaffolding", () => {
    // A polled sub-agent returns a written report, not a shell stream, and the
    // parent-model scaffolding at its end must not reach the user.
    renderPolls([
      poll({
        toolName: "get_command_or_subagent_output",
        input: JSON.stringify({ task_ids: ["019fe6bf"], timeout_ms: 300000 }),
        output: JSON.stringify({
          type: "TaskOutput",
          Result: {
            task_id: "019fe6bf",
            command: "[subagent:general-purpose] Run pnpm build",
            status: "completed",
            exit_code: 0,
            output:
              '## Build Result\n\nBUILD REPORT MARKER\n\n<subagent_meta>id=019fe6bf, tool_calls=1</subagent_meta>\n\n<subagent_result>\nresume_from="019fe6bf"\n</subagent_result>',
          },
        }),
      }),
    ])
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("BUILD REPORT MARKER")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Build Result" })
    ).toBeInTheDocument()
    expect(screen.queryByText(/subagent_meta/)).not.toBeInTheDocument()
    expect(screen.queryByText(/resume_from/)).not.toBeInTheDocument()
  })
})

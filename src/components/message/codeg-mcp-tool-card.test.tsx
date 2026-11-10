import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { CodegMcpToolCard } from "./codeg-mcp-tool-card"
import enMessages from "@/i18n/messages/en.json"

// MessageResponse (Streamdown) drags in the link-safety hook and async Shiki
// highlighting — too heavy for a unit test. Stub it so we can still assert the
// result goes THROUGH the Markdown renderer and arrives intact.
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

/** The MCP CallToolResult envelope the companion's `render_*` helpers emit. */
function envelope(text: string, structured: Record<string, unknown>): string {
  return JSON.stringify({
    content: [{ type: "text", text }],
    isError: false,
    structuredContent: structured,
  })
}

describe("CodegMcpToolCard", () => {
  it("states which session a get_session_info call is reading", () => {
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="get_session_info"
        input={JSON.stringify({ session_id: 2122, max_messages: 20 })}
        state="input-available"
      />
    )
    expect(screen.getByText("Reading session #2122")).toBeInTheDocument()
    // In flight with no result → spinner, and nothing to expand.
    expect(container.querySelector(".animate-spin")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("accepts the stringified session id some hosts send", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="get_session_info"
        input={JSON.stringify({ session_id: "2122" })}
        state="output-available"
      />
    )
    expect(screen.getByText("Reading session #2122")).toBeInTheDocument()
  })

  it("puts the progress message itself in the row", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "tests passing, starting cleanup" })}
        output={envelope("Recorded.", { recorded: true })}
        state="output-available"
      />
    )
    expect(
      screen.getByText("Progress: tests passing, starting cleanup")
    ).toBeInTheDocument()
  })

  it("leads a task_complete row with the verdict, then the summary", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_complete"
        input={JSON.stringify({
          verdict: "needs_review",
          summary: "works, but check the migration",
        })}
        output={envelope("Recorded.", { recorded: true })}
        state="output-available"
      />
    )
    expect(
      screen.getByText(
        "Task finished · needs review: works, but check the migration"
      )
    ).toBeInTheDocument()
  })

  it("falls back to an unknown verdict rather than dropping the row", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_complete"
        input={JSON.stringify({ verdict: "sorta-done" })}
        state="output-available"
      />
    )
    expect(screen.getByText("Task finished · unknown")).toBeInTheDocument()
  })

  it("names the automation and the work task being created", () => {
    const { unmount } = renderWithIntl(
      <CodegMcpToolCard
        tool="create_automation"
        input={JSON.stringify({ name: "nightly sweep", cron: "7 3 * * *" })}
        state="output-available"
      />
    )
    expect(
      screen.getByText("Creating automation nightly sweep")
    ).toBeInTheDocument()
    unmount()

    renderWithIntl(
      <CodegMcpToolCard
        tool="create_work_task"
        input={JSON.stringify({ title: "fix the flaky test", prompt: "…" })}
        state="output-available"
      />
    )
    expect(
      screen.getByText("Creating work task fix the flaky test")
    ).toBeInTheDocument()
  })

  it("looks past a JSON-RPC {name, arguments} relay envelope", () => {
    // `create_automation`'s own `name` argument collides with the `name` of the
    // `{name, arguments}` envelope some MCP relays wrap a call in, so accepting
    // the outer object would label the card with the TOOL's name. The walker
    // takes the deepest match for exactly this reason.
    renderWithIntl(
      <CodegMcpToolCard
        tool="create_automation"
        input={JSON.stringify({
          name: "mcp__codeg-mcp__create_automation",
          arguments: { name: "nightly sweep", prompt: "sweep the logs" },
        })}
        state="output-available"
      />
    )
    expect(
      screen.getByText("Creating automation nightly sweep")
    ).toBeInTheDocument()
  })

  it("still reads flat arguments, which is what every known host sends", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_complete"
        input={JSON.stringify({ verdict: "success", summary: "shipped" })}
        state="output-available"
      />
    )
    expect(
      screen.getByText("Task finished \u00b7 success: shipped")
    ).toBeInTheDocument()
  })

  it("exposes the untruncated label on hover", () => {
    // The row is CSS-truncated; `title` gives a long message back without
    // opening the panel.
    const message = "a".repeat(200)
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message })}
        state="output-available"
      />
    )
    expect(screen.getByText(`Progress: ${message}`)).toHaveAttribute(
      "title",
      `Progress: ${message}`
    )
  })

  it("surfaces the prompt an authoring call will actually run", () => {
    // `create_automation` / `create_work_task` create something persistent, and
    // the companion's result echoes id/title/folder/schedule but never the
    // prompt — so the panel is the only place it can be audited. The generic
    // shell this card replaced dumped every argument; this keeps parity.
    renderWithIntl(
      <CodegMcpToolCard
        tool="create_work_task"
        input={JSON.stringify({
          title: "fix the flaky test",
          prompt: "Investigate why auth.spec.ts retries, then fix it.",
        })}
        state="input-available"
      />
    )
    // Expandable from frame 1 — the prompt arrives with the arguments, long
    // before any result.
    fireEvent.click(screen.getByRole("button"))
    expect(
      screen.getByText("Investigate why auth.spec.ts retries, then fix it.")
    ).toBeInTheDocument()
  })

  it("shows the prompt above the result once both exist", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="create_automation"
        input={JSON.stringify({ name: "nightly sweep", prompt: "sweep logs" })}
        output={envelope("Created automation #12.", {
          created: true,
          kind: "automation",
          id: 12,
        })}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("sweep logs")).toBeInTheDocument()
    expect(screen.getByTestId("markdown-response")).toHaveTextContent(
      "Created automation #12."
    )
  })

  it("does not show a prompt block for the non-authoring tools", () => {
    // `task_progress` has no `prompt` argument; a stray one must not leak into
    // the panel, which carries the report instead.
    const { container, unmount } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway", prompt: "not mine" })}
        state="input-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent("halfway")
    expect(screen.queryByText("Prompt")).not.toBeInTheDocument()
    expect(container.textContent).not.toContain("not mine")
    unmount()

    // Nor may it make an in-flight call with nothing to read expandable.
    renderWithIntl(
      <CodegMcpToolCard
        tool="get_session_info"
        input={JSON.stringify({ session_id: 7, prompt: "not mine" })}
        state="input-available"
      />
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("expands a progress report to the whole message and what became of it", () => {
    // Claude Code and Codex persist only the structured half of the result, so
    // `{"recorded":true}` is all the transcript holds — it must not be the
    // panel's text.
    const message =
      "Located it: the card showed the ack as its result. " + "x".repeat(200)
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message })}
        output='{"recorded":true}'
        state="output-available"
      />
    )
    // The report is readable in full from the arguments alone; the panel stays
    // out of the tree until it is opened.
    expect(screen.queryByTestId("markdown-response")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent(message)
    expect(screen.getByText("Recorded on the work task")).toBeInTheDocument()
    expect(container.textContent).not.toContain('{"recorded"')
  })

  it("reads a progress report in full while the call is still in flight", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "tests passing" })}
        state="input-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent(
      "tests passing"
    )
    expect(
      screen.queryByText("Recorded on the work task")
    ).not.toBeInTheDocument()
  })

  it("says when a report was not recorded, and why", () => {
    const { container, unmount } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        output={JSON.stringify({
          recorded: false,
          note: "this session is not executing a work task",
        })}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(
      screen.getByText(
        "Not recorded on the work task: this session is not executing a work task"
      )
    ).toBeInTheDocument()
    // A refusal is not a failed call: it keeps the ordinary frame.
    expect(container.querySelector(".border-destructive\\/30")).toBeNull()
    unmount()

    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        output="Not recorded."
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(
      screen.getByText("Not recorded on the work task")
    ).toBeInTheDocument()
  })

  it("expands a completion to the whole summary", () => {
    const summary =
      "Bumped both pins.\n\n- Cursor `e3cb207`\n- Antigravity 1.4.1"
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_complete"
        input={JSON.stringify({ verdict: "success", summary })}
        output='{"recorded":true}'
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    // Through the Markdown renderer, like the drawer's result summary.
    expect(screen.getByTestId("markdown-response").textContent).toBe(summary)
    expect(screen.getByText("Recorded on the work task")).toBeInTheDocument()
  })

  it("keeps the report above a failed call's error", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        errorText="socket closed"
        state="output-error"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    const blocks = screen.getAllByTestId("markdown-response")
    expect(blocks.map((block) => block.textContent)).toEqual([
      "halfway",
      "socket closed",
    ])
    expect(
      screen.queryByText("Recorded on the work task")
    ).not.toBeInTheDocument()
  })

  it("expands to the result text, rendered as Markdown", () => {
    renderWithIntl(
      <CodegMcpToolCard
        tool="get_session_info"
        input={JSON.stringify({ session_id: 7 })}
        output={envelope("Session #7 (codex)\nTitle: probe", {
          found: true,
          session_id: 7,
        })}
        state="output-available"
      />
    )
    expect(screen.queryByTestId("markdown-response")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent(
      "Session #7 (codex) Title: probe"
    )
  })

  it("peels codex-acp's live {result, error} envelope", () => {
    // codex-acp forwards every MCP outcome as `{result: <CallToolResult>,
    // error: null}`; without the peel the whole envelope lands in the card.
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        output={JSON.stringify({
          result: {
            content: [{ type: "text", text: "Recorded." }],
            isError: false,
            structuredContent: { recorded: true },
          },
          error: null,
        })}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent("halfway")
    expect(screen.getByText("Recorded on the work task")).toBeInTheDocument()
    expect(container.textContent).not.toContain("Recorded.")
  })

  it("reads Codex's Wall time / Output wrap", () => {
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_complete"
        input={JSON.stringify({ verdict: "success", summary: "shipped" })}
        output={
          "Wall time: 0.0031 seconds\nOutput:\n" +
          envelope("Recorded.", { recorded: true })
        }
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent("shipped")
    expect(screen.getByText("Recorded on the work task")).toBeInTheDocument()
    expect(container.textContent).not.toContain("Wall time")
  })

  it("reads the companion's ack text from hosts that keep only content", () => {
    // OpenCode drops `structuredContent` and keeps the companion's text.
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        output="Recorded."
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Recorded on the work task")).toBeInTheDocument()
    expect(container.textContent).not.toContain("Recorded.")
  })

  it("shows a result it cannot identify as an ack verbatim", () => {
    // OpenCode's half of a refusal is the bare reason, which no reader can tell
    // from any other text — so it is shown as-is, not relabelled.
    renderWithIntl(
      <CodegMcpToolCard
        tool="task_progress"
        input={JSON.stringify({ message: "halfway" })}
        output="the task moved on to a new run"
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    const blocks = screen.getAllByTestId("markdown-response")
    expect(blocks.map((block) => block.textContent)).toEqual([
      "halfway",
      "the task moved on to a new run",
    ])
    expect(screen.queryByText(/work task/)).not.toBeInTheDocument()
  })

  it("surfaces a real tool error and tints the card", () => {
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="get_session_info"
        input={JSON.stringify({ session_id: 7 })}
        errorText="socket closed"
        state="output-error"
      />
    )
    expect(container.querySelector(".border-destructive\\/30")).not.toBeNull()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByTestId("markdown-response")).toHaveTextContent(
      "socket closed"
    )
  })

  it("keeps a soft refusal out of the error state", () => {
    // These tools report "couldn't do it, here's why" as ordinary isError:false
    // text — an err badge must mean the CALL failed, not that it was refused.
    const { container } = renderWithIntl(
      <CodegMcpToolCard
        tool="create_automation"
        input={JSON.stringify({ name: "nightly sweep" })}
        output={envelope("Automation creation from chat is turned off.", {
          created: false,
          kind: "automation",
        })}
        state="output-available"
      />
    )
    expect(container.querySelector(".border-destructive\\/30")).toBeNull()
  })

  it("still renders a row when the arguments never arrived", () => {
    renderWithIntl(
      <CodegMcpToolCard tool="task_progress" state="input-streaming" />
    )
    expect(screen.getByText("Reporting task progress")).toBeInTheDocument()
  })
})

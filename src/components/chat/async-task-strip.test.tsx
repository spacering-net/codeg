import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import { AsyncTaskStrip } from "./async-task-strip"
import enMessages from "@/i18n/messages/en.json"
import type { AsyncTaskRecord } from "@/lib/types"

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    task_id: "t1",
    name: "pnpm test",
    task_type: "shell",
    description: "pnpm test --watch",
    show_in_transcript: true,
    can_stop: true,
    state: "running",
    ...overrides,
  }
}

function renderStrip(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const t = enMessages.Folder.chat.asyncTasks

beforeEach(() => {
  mocks.openFilePreview.mockReset()
})

describe("AsyncTaskStrip", () => {
  it("renders nothing once every task has settled", () => {
    // A settled task's outcome belongs to the transcript; a permanent list of
    // finished jobs docked under the composer would grow all session.
    const { container } = renderStrip(
      <AsyncTaskStrip
        tasks={[
          task({ task_id: "a", state: "completed" }),
          task({ task_id: "b", state: "failed" }),
        ]}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("stops a task and reports a declined stop through the caller", async () => {
    const onStop = vi.fn().mockResolvedValue(true)
    renderStrip(<AsyncTaskStrip tasks={[task()]} onStop={onStop} />)
    await userEvent.click(screen.getByRole("button", { name: t.stop }))
    expect(onStop).toHaveBeenCalledWith("t1")
  })

  it("hides the stop button when the adapter withheld the affordance", () => {
    renderStrip(
      <AsyncTaskStrip tasks={[task({ can_stop: false })]} onStop={vi.fn()} />
    )
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("hides the stop button for a surface with no live connection", () => {
    // A viewer passes no handler — the button would be a dead control.
    renderStrip(<AsyncTaskStrip tasks={[task()]} />)
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("reads the output in a file tab, not through the OS opener", async () => {
    // Claude writes task logs under the OS temp root. The opener plugin
    // validates against `opener:allow-open-path`, which grants `$HOME`, so
    // every one of those was refused at the door — and widening that scope to
    // a temp tree the adapter picked is the wrong trade for reading a log.
    // `openFilePreview` takes an absolute path anywhere and reads through
    // codeg's own backend, so it needs no scope and works in web as well.
    renderStrip(
      <AsyncTaskStrip
        tasks={[task({ output_file_path: "/private/tmp/claude-501/x.output" })]}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: t.openOutput }))
    expect(mocks.openFilePreview).toHaveBeenCalledWith(
      "/private/tmp/claude-501/x.output"
    )
  })

  it("offers no output button for a task that reported no path", () => {
    renderStrip(<AsyncTaskStrip tasks={[task()]} />)
    expect(
      screen.queryByRole("button", { name: t.openOutput })
    ).not.toBeInTheDocument()
  })

  it("puts a workflow's phase and running agent on the meta line", () => {
    renderStrip(
      <AsyncTaskStrip
        tasks={[
          task({
            name: "deep-research",
            task_type: "workflow",
            can_stop: false,
            phase: "Research",
            current_agent: "researcher-2",
          }),
        ]}
        onStop={vi.fn()}
      />
    )
    expect(screen.getByText("Research · researcher-2")).toBeInTheDocument()
    // Grok has no stop request: the row must not offer a dead control.
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("drops a cleared agent from the meta line", () => {
    // Between agents a Grok workflow reports its agent as "" — the line then
    // reads as the phase alone, not "Verify · ".
    renderStrip(
      <AsyncTaskStrip
        tasks={[
          task({ task_type: "workflow", phase: "Verify", current_agent: "" }),
        ]}
      />
    )
    expect(screen.getByText("Verify")).toBeInTheDocument()
  })
})

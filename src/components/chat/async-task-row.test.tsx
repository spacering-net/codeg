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

import { AsyncTaskRow } from "./async-task-row"
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

function renderRows(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const t = enMessages.Folder.chat.asyncTasks

/** The rows as the running list lays them out, one per task. Which tasks get
 *  one (only the live ones) is `collectLiveRuns`' call — see
 *  `lib/live-runs.test.ts`. */
function Rows({
  tasks,
  onStop,
  agentName,
}: {
  tasks: AsyncTaskRecord[]
  onStop?: (taskId: string) => void
  agentName?: string
}) {
  return (
    <>
      {tasks.map((item) => (
        <AsyncTaskRow
          key={item.task_id}
          task={item}
          onStop={onStop}
          stopping={false}
          agentName={agentName}
        />
      ))}
    </>
  )
}

beforeEach(() => {
  mocks.openFilePreview.mockReset()
})

describe("AsyncTaskRow", () => {
  it("stops a task through the caller", async () => {
    const onStop = vi.fn().mockResolvedValue(true)
    renderRows(<Rows tasks={[task()]} onStop={onStop} />)
    await userEvent.click(screen.getByRole("button", { name: t.stop }))
    expect(onStop).toHaveBeenCalledWith("t1")
  })

  it("hides the stop button when the adapter withheld the affordance", () => {
    renderRows(<Rows tasks={[task({ can_stop: false })]} onStop={vi.fn()} />)
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("hides the stop button for a surface with no live connection", () => {
    // A viewer passes no handler — the button would be a dead control.
    renderRows(<Rows tasks={[task()]} />)
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
    renderRows(
      <Rows
        tasks={[task({ output_file_path: "/private/tmp/claude-501/x.output" })]}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: t.openOutput }))
    expect(mocks.openFilePreview).toHaveBeenCalledWith(
      "/private/tmp/claude-501/x.output"
    )
  })

  it("offers no output button for a task that reported no path", () => {
    renderRows(<Rows tasks={[task()]} />)
    expect(
      screen.queryByRole("button", { name: t.openOutput })
    ).not.toBeInTheDocument()
  })

  it("puts a workflow's phase and running agent on the meta line", () => {
    renderRows(
      <Rows
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
    renderRows(
      <Rows
        tasks={[
          task({ task_type: "workflow", phase: "Verify", current_agent: "" }),
        ]}
      />
    )
    expect(screen.getByText("Verify")).toBeInTheDocument()
  })

  describe("a turn the agent started on its own", () => {
    // claude-agent-acp 0.97.0's announcement, as recorded: no tool call, the
    // summary of the task notification that woke Claude Code as description.
    const turn = (overrides: Partial<AsyncTaskRecord> = {}) =>
      task({
        task_id: "autonomous-turn-1",
        name: "Claude is working",
        task_type: "turn",
        description: 'Background command "pnpm build" completed (exit code 0)',
        show_in_transcript: false,
        ...overrides,
      })

    it("names the agent in the user's language and says what woke it", () => {
      renderRows(
        <Rows tasks={[turn()]} onStop={vi.fn()} agentName="Claude Code" />
      )
      expect(screen.getByText("Claude Code is working")).toBeInTheDocument()
      expect(screen.queryByText("Claude is working")).not.toBeInTheDocument()
      expect(
        screen.getByText(
          'Background command "pnpm build" completed (exit code 0)'
        )
      ).toBeInTheDocument()
    })

    it("stops the turn through the same request", async () => {
      const onStop = vi.fn().mockResolvedValue(true)
      renderRows(
        <Rows tasks={[turn()]} onStop={onStop} agentName="Claude Code" />
      )
      await userEvent.click(screen.getByRole("button", { name: t.stop }))
      expect(onStop).toHaveBeenCalledWith("autonomous-turn-1")
    })

    it("keeps the adapter's name without an agent name", () => {
      renderRows(<Rows tasks={[turn()]} />)
      expect(screen.getByText("Claude is working")).toBeInTheDocument()
    })

    it("says nothing for a turn the adapter could not explain", () => {
      const { container } = renderRows(
        <Rows
          tasks={[
            turn({
              description: "Claude Code started a turn without a prompt.",
            }),
          ]}
          agentName="Claude Code"
        />
      )
      expect(container).not.toHaveTextContent("without a prompt")
      expect(screen.getByText("Claude Code is working")).toBeInTheDocument()
    })

    it("words a scheduled wakeup itself", () => {
      renderRows(
        <Rows
          tasks={[turn({ description: "A scheduled task fired." })]}
          agentName="Claude Code"
        />
      )
      expect(screen.getByText(t.scheduledTask)).toBeInTheDocument()
    })
  })
})

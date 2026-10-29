import { act, render, screen } from "@testing-library/react"
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
      renderStrip(
        <AsyncTaskStrip
          tasks={[turn()]}
          onStop={vi.fn()}
          agentName="Claude Code"
        />
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
      renderStrip(
        <AsyncTaskStrip
          tasks={[turn()]}
          onStop={onStop}
          agentName="Claude Code"
        />
      )
      await userEvent.click(screen.getByRole("button", { name: t.stop }))
      expect(onStop).toHaveBeenCalledWith("autonomous-turn-1")
    })

    it("keeps the adapter's name without an agent name", () => {
      renderStrip(<AsyncTaskStrip tasks={[turn()]} />)
      expect(screen.getByText("Claude is working")).toBeInTheDocument()
    })

    it("says nothing for a turn the adapter could not explain", () => {
      const { container } = renderStrip(
        <AsyncTaskStrip
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
      renderStrip(
        <AsyncTaskStrip
          tasks={[turn({ description: "A scheduled task fired." })]}
          agentName="Claude Code"
        />
      )
      expect(screen.getByText(t.scheduledTask)).toBeInTheDocument()
    })
  })

  describe("more than one task", () => {
    // Every row the strip holds is room the transcript under it loses.
    const several = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        task({ task_id: `t${i}`, name: `job ${i}` })
      )
    const header = () =>
      screen.getByRole("button", { name: `${t.title} 4` }) as HTMLElement
    const rerenderStrip = (
      view: ReturnType<typeof renderStrip>,
      tasks: AsyncTaskRecord[]
    ) =>
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <AsyncTaskStrip tasks={tasks} onStop={vi.fn()} />
        </NextIntlClientProvider>
      )

    it("gives a single task a row of its own, with nothing to fold", () => {
      renderStrip(<AsyncTaskStrip tasks={several(1)} onStop={vi.fn()} />)
      expect(screen.getByText("job 0")).toBeInTheDocument()
      expect(screen.queryByRole("button", { expanded: true })).toBeNull()
      expect(screen.queryByText(t.title)).toBeNull()
    })

    it("heads them with what they are and how many, the list open", () => {
      renderStrip(<AsyncTaskStrip tasks={several(4)} onStop={vi.fn()} />)
      expect(header()).toHaveAttribute("aria-expanded", "true")
      expect(screen.getAllByRole("button", { name: t.stop })).toHaveLength(4)
      // The list the header opens, the rows in it.
      const list = document.getElementById(
        header().getAttribute("aria-controls")!
      )!
      expect(list).toContainElement(screen.getByText("job 3"))
    })

    it("stops the list a little past three rows, scrolling the rest", () => {
      // Rows with buttons and rows without are both 2rem, the header too:
      // the 7rem cap cuts through the fourth row whatever the rows hold.
      const tasks = several(6).map((job, i) =>
        i % 2 === 0 ? job : { ...job, can_stop: false }
      )
      renderStrip(<AsyncTaskStrip tasks={tasks} onStop={vi.fn()} />)
      const header = screen.getByRole("button", { name: `${t.title} 6` })
      const list = document.getElementById(
        header.getAttribute("aria-controls")!
      )!
      // The scrollport is the list's host; the header stays out of it.
      const scroller = list.closest("[data-overlayscrollbars-initialize]")
      expect(scroller).not.toBeNull()
      expect(scroller).toHaveClass("max-h-28")
      expect(scroller).not.toContainElement(header)
      const lines = [header, ...Array.from(list.children)]
      expect(lines).toHaveLength(7)
      for (const line of lines) {
        expect(line).toHaveClass("min-h-8", "py-1")
      }
    })

    it("folds the list away to its header, and back", async () => {
      renderStrip(<AsyncTaskStrip tasks={several(4)} onStop={vi.fn()} />)
      await userEvent.click(header())
      expect(header()).toHaveAttribute("aria-expanded", "false")
      expect(header()).not.toHaveAttribute("aria-controls")
      expect(screen.queryByText("job 0")).toBeNull()
      expect(screen.queryByRole("button", { name: t.stop })).toBeNull()

      await userEvent.click(header())
      expect(header()).toHaveAttribute("aria-expanded", "true")
      expect(screen.getAllByRole("button", { name: t.stop })).toHaveLength(4)
    })

    it("keeps a folded list folded as tasks come and go", async () => {
      const view = renderStrip(
        <AsyncTaskStrip tasks={several(2)} onStop={vi.fn()} />
      )
      await userEvent.click(
        screen.getByRole("button", { name: `${t.title} 2` })
      )

      rerenderStrip(view, several(4))
      expect(header()).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText("job 3")).toBeNull()

      // Every task settled, then more started: still the reader's fold.
      rerenderStrip(
        view,
        several(4).map((done) => ({ ...done, state: "completed" as const }))
      )
      expect(view.container).toBeEmptyDOMElement()
      rerenderStrip(view, several(4))
      expect(header()).toHaveAttribute("aria-expanded", "false")

      // Down to one task: its row, with nothing to fold. More again: the
      // reader's fold.
      rerenderStrip(view, several(1))
      expect(screen.getByText("job 0")).toBeInTheDocument()
      expect(screen.queryByText(t.title)).toBeNull()
      rerenderStrip(view, several(4))
      expect(header()).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText("job 0")).toBeNull()
    })

    it("keeps a row the same row as a second task starts", () => {
      // Its state (a stop on its way, where its shimmer is) stays with it.
      const view = renderStrip(
        <AsyncTaskStrip tasks={several(1)} onStop={vi.fn()} />
      )
      const row = screen.getByText("job 0").closest("div")
      rerenderStrip(view, several(2))
      expect(screen.getByText("job 0").closest("div")).toBe(row)
    })

    it("keeps a stop on its way through a fold", async () => {
      // Folded away and back before the adapter answers, the row must not
      // offer the stop again.
      let settle!: (stopped: boolean) => void
      const onStop = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settle = resolve
          })
      )
      renderStrip(<AsyncTaskStrip tasks={several(2)} onStop={onStop} />)
      await userEvent.click(screen.getAllByRole("button", { name: t.stop })[0]!)
      expect(onStop).toHaveBeenCalledWith("t0")

      const fold = screen.getByRole("button", { name: `${t.title} 2` })
      await userEvent.click(fold)
      await userEvent.click(fold)
      const [first, second] = screen.getAllByRole("button", { name: t.stop })
      expect(first).toBeDisabled()
      expect(second).toBeEnabled()

      // Answered: offered again (a declined stop can be retried).
      await act(async () => settle(false))
      expect(screen.getAllByRole("button", { name: t.stop })[0]).toBeEnabled()
      expect(onStop).toHaveBeenCalledTimes(1)
    })
  })
})

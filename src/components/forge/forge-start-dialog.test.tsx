/**
 * The trigger dialog. Its three outcomes are ANSWERS, not errors — `created`
 * hands the task back, `duplicate` offers a choice, `folder_mismatch` names
 * the remote the folder actually points at — and the coordinates it sends are
 * the backend's own (`remote.provider`, never a guess from the hostname).
 *
 * The snapshot preview is read-only by design: the prompt and its
 * untrusted-data envelope are composed server-side, so an editable box here
 * would only promise an influence it does not have.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ForgeCreateResult,
  ForgeIssueRow,
  ForgeRemote,
  ForgePanelSettings,
  WorkTask,
} from "@/lib/types"

import { ForgeStartDialog } from "./forge-start-dialog"

const workTaskCreateFromForge = vi.fn()
vi.mock("@/lib/api", () => ({
  workTaskCreateFromForge: (...args: unknown[]) =>
    workTaskCreateFromForge(...args),
}))

const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute,
    openConversations: vi.fn(),
  }),
}))

const GITHUB: ForgeRemote = {
  remote_name: "origin",
  server_host: "github.com",
  owner_repo: "o/r",
  remote_url: "https://github.com/o/r.git",
  provider: "github",
  supported: true,
}
const GITLAB: ForgeRemote = {
  remote_name: "origin",
  server_host: "gitlab.com",
  owner_repo: "group/sub/app",
  remote_url: "https://gitlab.com/group/sub/app.git",
  provider: "gitlab",
  supported: true,
}

function row(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 42,
    title: "Login times out",
    body: "steps to reproduce…",
    state: "open",
    draft: false,
    labels: [{ name: "bug", color: "#d73a4a" }],
    author: "octocat",
    author_avatar: "https://avatars.githubusercontent.com/u/583231",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42",
    is_pr: false,
    comments: 0,
    ...overrides,
  }
}

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 5,
    folder_id: 1,
    title: "Login times out",
    ...overrides,
  } as WorkTask
}

function mount(
  item: ForgeIssueRow,
  remote: ForgeRemote = GITHUB,
  handlers: {
    onClose?: () => void
    onCreated?: (t: WorkTask) => void
    settings?: ForgePanelSettings
  } = {}
) {
  const onClose = handlers.onClose ?? vi.fn()
  const onCreated = handlers.onCreated ?? vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeStartDialog
        row={item}
        remote={remote}
        folderId={7}
        settings={handlers.settings ?? null}
        onClose={onClose}
        onCreated={onCreated}
      />
    </NextIntlClientProvider>
  )
  return { onClose, onCreated }
}

/** The write-back control is a switch in a settings row, not a tick box — the
 *  same shape the task settings use, because it is the same kind of decision. */
function writebackSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: /Comment the outcome back/ })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ForgeStartDialog", () => {
  it("sends the backend's own coordinates plus the typed instruction", async () => {
    const user = userEvent.setup()
    const created: ForgeCreateResult = { outcome: "created", task: task() }
    workTaskCreateFromForge.mockResolvedValueOnce(created)
    const { onCreated } = mount(row())

    await user.type(screen.getByRole("textbox"), "  start with the tests  ")
    await user.click(screen.getByRole("button", { name: "Create task" }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created.task))
    expect(workTaskCreateFromForge).toHaveBeenCalledWith({
      folder_id: 7,
      source: {
        kind: "issue",
        // Whatever this host is was decided server-side; a guess here would
        // build a source key that matches no task's provenance.
        provider: "github",
        server_host: "github.com",
        owner_repo: "o/r",
        number: 42,
      },
      snapshot: {
        title: "Login times out",
        body: "steps to reproduce…",
        // NAMES: the snapshot is text handed to an agent, so the label's
        // colour is dropped on the way in rather than travelling as an object
        // the envelope would have to stringify.
        labels: ["bug"],
        author: "octocat",
      },
      // A scenario NAME — the template text it selects never leaves the
      // server. "fix" is the issue default.
      scenario: "fix",
      instruction: "start with the tests",
      // The one thing the task will do in a thread other people read, asked
      // here per work item. On unless the user says otherwise.
      writeback: true,
      force: false,
    })
  })

  it("carries the write-back choice, off when the switch is cleared", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "created",
      task: task(),
    })
    mount(row())

    const box = writebackSwitch()
    expect(box).toBeChecked()
    await user.click(box)
    await user.click(screen.getByRole("button", { name: "Create task" }))

    await waitFor(() => expect(workTaskCreateFromForge).toHaveBeenCalled())
    expect(workTaskCreateFromForge.mock.calls[0][0].writeback).toBe(false)
  })

  /**
   * The panel's preferences decide what this dialog OPENS with — nothing more.
   * They are read by the page and handed down, so a trigger never waits on a
   * round trip; with none loaded the dialog falls back to the built-ins.
   */
  it("opens on the folder's configured scenario and write-back state", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "created",
      task: task(),
    })
    mount(row(), GITHUB, {
      settings: {
        default_issue_scenario: "plan_first",
        writeback_default: false,
        scenario_prompts: {},
      },
    })

    expect(screen.getByRole("radio", { name: /Plan first/ })).toBeChecked()
    expect(writebackSwitch()).not.toBeChecked()

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(workTaskCreateFromForge).toHaveBeenCalled())
    const payload = workTaskCreateFromForge.mock.calls[0][0]
    expect(payload.scenario).toBe("plan_first")
    expect(payload.writeback).toBe(false)
  })

  /**
   * A stored default belonging to the OTHER kind — settings written for issues,
   * a row that is a PR — must not preselect a radio that is not on screen,
   * which would leave the group showing nothing and send the server a scenario
   * it refuses.
   */
  it("ignores a configured default the item's kind does not offer", () => {
    mount(row({ is_pr: true }), GITHUB, {
      settings: {
        default_issue_scenario: "plan_first",
        default_pr_scenario: "plan_first" as never,
        writeback_default: true,
        scenario_prompts: {},
      },
    })
    expect(screen.getByRole("radio", { name: /Review & fix/ })).toBeChecked()
  })

  it("falls back to the built-in defaults when no settings loaded", () => {
    mount(row())
    expect(
      screen.getByRole("radio", { name: /Fix \/ implement/ })
    ).toBeChecked()
    expect(writebackSwitch()).toBeChecked()
  })

  it("carries a blank instruction as null and marks a PR row as a pr", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "created",
      task: task(),
    })
    mount(row({ is_pr: true }))

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(workTaskCreateFromForge).toHaveBeenCalled())
    const payload = workTaskCreateFromForge.mock.calls[0][0]
    expect(payload.instruction).toBeNull()
    expect(payload.source.kind).toBe("pr")
    expect(payload.scenario).toBe("review_fix")
  })

  it("offers the kind's own scenarios with the default preselected", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ForgeStartDialog
          row={row()}
          remote={GITHUB}
          folderId={7}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    // Issues: fix (default) / plan first — and no PR entries, whose templates
    // talk about pushing back to a branch this task lacks. "Investigate only"
    // is not among them: both remaining templates verify the report first, so
    // a third entry would advertise that step as skippable.
    expect(screen.getAllByRole("radio")).toHaveLength(2)
    expect(
      screen.getByRole("radio", { name: /Fix \/ implement/ })
    ).toBeChecked()
    expect(screen.getByRole("radio", { name: /Plan first/ })).not.toBeChecked()
    expect(
      screen.queryByRole("radio", { name: /Investigate/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("radio", { name: /Review/ })
    ).not.toBeInTheDocument()
    unmount()

    mount(row({ is_pr: true }))
    expect(screen.getAllByRole("radio")).toHaveLength(2)
    expect(screen.getByRole("radio", { name: /Review & fix/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: /Review only/ })).not.toBeChecked()
  })

  it("sends the picked scenario, not the default", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "created",
      task: task(),
    })
    mount(row())

    await user.click(screen.getByRole("radio", { name: /Plan first/ }))
    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(workTaskCreateFromForge).toHaveBeenCalled())
    expect(workTaskCreateFromForge.mock.calls[0][0].scenario).toBe("plan_first")
  })

  it("turns a duplicate into a choice, and 'create anyway' forces", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge
      .mockResolvedValueOnce({
        outcome: "duplicate",
        existing: task({ id: 9, title: "Login times out", status: "running" }),
      })
      .mockResolvedValueOnce({ outcome: "created", task: task() })
    const { onCreated } = mount(row())

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await screen.findByText(/An active task already handles this item/)
    // The instruction box and scenario picker are gone — the decision on
    // screen is now which task to keep, not what to tell the agent.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Create anyway" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(workTaskCreateFromForge.mock.calls[1][0].force).toBe(true)
  })

  it("sends a duplicate's 'view existing' to the board", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "duplicate",
      existing: task({ id: 9 }),
    })
    const { onClose } = mount(row())

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await user.click(
      await screen.findByRole("button", { name: "View the existing task" })
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(setRoute).toHaveBeenCalledWith("tasks")
  })

  it("names the remote the folder actually points at on a mismatch", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "folder_mismatch",
      folder_remote: {
        ...GITHUB,
        owner_repo: "other/repo",
      },
    })
    const { onCreated } = mount(row())

    await user.click(screen.getByRole("button", { name: "Create task" }))
    // Naming it is the whole answer: the picker in the toolbar is where the
    // user switches folders, and a mismatch with no name is unactionable.
    await screen.findByText(/github\.com\/other\/repo/)
    expect(onCreated).not.toHaveBeenCalled()
  })

  it("survives a mismatch that could not name a remote at all", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockResolvedValueOnce({
      outcome: "folder_mismatch",
      folder_remote: null,
    })
    mount(row())
    await user.click(screen.getByRole("button", { name: "Create task" }))
    await screen.findByText(/not this issue's repository/)
  })

  it("reports a transport failure in place rather than closing", async () => {
    const user = userEvent.setup()
    workTaskCreateFromForge.mockRejectedValueOnce(new Error("network down"))
    const { onClose, onCreated } = mount(row())

    await user.click(screen.getByRole("button", { name: "Create task" }))
    await screen.findByText("network down")
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    // Still submittable — the failure was the network, not the request.
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled()
  })

  it("promises a merge request on GitLab and a pull request on GitHub", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ForgeStartDialog
          row={row({ is_pr: true })}
          remote={GITLAB}
          folderId={7}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText(/merge request's head/)).toBeInTheDocument()
    expect(screen.getByText(/gitlab\.com\/group\/sub\/app/)).toBeInTheDocument()
    unmount()

    mount(row({ is_pr: true }), GITHUB)
    expect(screen.getByText(/pull request's head/)).toBeInTheDocument()
  })

  it("previews the item body read-only, and says so when there is none", async () => {
    const user = userEvent.setup()
    mount(row({ body: null }))
    await user.click(
      screen.getByRole("button", {
        name: "Preview the issue content the task will carry",
      })
    )
    const preview = await screen.findByText("(no description)")
    // Read-only: this is the DATA the server-side envelope wraps, not a
    // second composer.
    expect(preview.tagName).not.toBe("TEXTAREA")
    expect(preview).not.toHaveAttribute("contenteditable", "true")
  })
})

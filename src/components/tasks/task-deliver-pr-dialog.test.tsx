import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type {
  ForgeRemote,
  ForgeSourceMeta,
  WorkTask,
  WorkTaskFolderSettings,
} from "@/lib/types"

const deliverMock = vi.fn().mockResolvedValue("https://example.test/pull/4")
const settingsMock = vi.fn()
const remoteMock = vi.fn()

const setWritebackMock = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskDeliverPr: (...args: unknown[]) => deliverMock(...args),
  workTaskSettingsEffective: (...args: unknown[]) => settingsMock(...args),
  folderForgeRemote: (...args: unknown[]) => remoteMock(...args),
  workTaskSetWriteback: (...args: unknown[]) => setWritebackMock(...args),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import {
  rememberForgeRemote,
  resetForgeProviderCacheForTests,
} from "@/lib/forge-provider-cache"
import { TaskDeliverPrDialog } from "./task-deliver-pr-dialog"

function meta(overrides?: Partial<ForgeSourceMeta>): ForgeSourceMeta {
  return {
    provider: "github",
    server_host: "github.com",
    api_base: "https://api.github.com",
    account_id: "acct",
    owner_repo: "acme/widget",
    number: 4,
    url: "https://github.com/acme/widget/pull/4",
    title: "Fix login",
    head_ref: "feature/login",
    ...overrides,
  }
}

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: 3,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 3,
    additions: 10,
    deletions: 2,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    source_kind: "forge_pr",
    source_meta: meta(),
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

function settings(
  overrides?: Partial<WorkTaskFolderSettings>
): WorkTaskFolderSettings {
  return {
    default_agent_type: null,
    mode_id: null,
    config_values: {},
    auto_process: false,
    max_concurrent: 2,
    merge_strategy: "squash",
    auto_merge: false,
    auto_compact_percent: 0,
    delete_worktree_default: true,
    ...overrides,
  }
}

function renderDialog(t: WorkTask = task()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDeliverPrDialog open onOpenChange={() => {}} task={t} />
    </NextIntlClientProvider>
  )
}

/** An ordinary task — no forge provenance — in a project on `remote`. */
function localTask(overrides?: Partial<WorkTask>): WorkTask {
  return task({ source_kind: null, source_meta: null, ...overrides })
}

function remote(overrides?: Partial<ForgeRemote>): ForgeRemote {
  return {
    server_host: "github.com",
    owner_repo: "acme/site",
    remote_url: "https://github.com/acme/site.git",
    provider: "github",
    supported: true,
    ...overrides,
  }
}

beforeEach(() => {
  deliverMock.mockClear()
  settingsMock.mockReset()
  remoteMock.mockReset()
  resetForgeProviderCacheForTests()
})

describe("TaskDeliverPrDialog", () => {
  it("takes the worktree with the push-back when the folder default says so", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    const box = await screen.findByRole("checkbox", {
      name: /Delete the worktree after pushing/,
    })
    await waitFor(() => expect(box).toBeChecked())
    // A push-back names nothing: whether it finishes the task, the cleanup
    // box and whether the thread hears about it are its only controls.
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)
    expect(
      screen.getByRole("checkbox", { name: /Comment in the item's thread/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", {
        name: "Mark the task as done after pushing",
      })
    ).toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, true, true)
    )
    // The thread's answer goes first, bound to the run on screen.
    expect(setWritebackMock).toHaveBeenCalledWith(7, 1, false, {})
  })

  it("keeps the worktree when the box is unchecked", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    const box = await screen.findByRole("checkbox", {
      name: /Delete the worktree after pushing/,
    })
    await waitFor(() => expect(box).toBeChecked())
    await userEvent.click(box)

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, true)
    )
  })

  it("starts unchecked when the folder default says keep", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: false }))
    renderDialog()

    await waitFor(() => expect(settingsMock).toHaveBeenCalledWith(1))
    expect(
      screen.getByRole("checkbox", {
        name: /Delete the worktree after pushing/,
      })
    ).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, true)
    )
  })

  it("offers the same choice on the issue shape, alongside title and draft", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog(
      task({
        source_kind: "forge_issue",
        source_meta: meta({ head_ref: null }),
      })
    )

    const box = await screen.findByRole("checkbox", {
      name: /Delete the worktree after delivering/,
    })
    await waitFor(() => expect(box).toBeChecked())
    expect(
      screen.getByRole("checkbox", { name: /Open as a draft/ })
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Push and open" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(
        7,
        "Fix login",
        false,
        true,
        true
      )
    )
  })

  /** A task made from several issues picks, at its first delivery, which of
   *  them the pull request closes — every one ticked to begin with — and the
   *  pick travels with the request. */
  it("asks a task of several issues which of them the pull request closes", async () => {
    settingsMock.mockResolvedValue(settings())
    const items = [3, 5, 9].map((number) => ({
      number,
      url: `https://github.com/acme/widget/issues/${number}`,
      title: `issue ${number}`,
    }))
    renderDialog(
      task({
        source_kind: "forge_issue",
        source_meta: meta({ head_ref: null, number: 3, items }),
      })
    )
    expect(
      await screen.findByText(/Merging it closes the issues ticked below/)
    ).toBeInTheDocument()
    const five = screen.getByRole("checkbox", { name: /#5/ })
    expect(five).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /#3/ })).toBeChecked()
    await userEvent.click(five)
    expect(five).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "Push and open" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(
        7,
        "Fix login",
        false,
        true,
        true,
        [3, 9]
      )
    )
  })

  /** Once fixed, the list only shows: the backend holds every later pull
   *  request of the task to it, so the dialog sends none. */
  it("shows a fixed closing list without letting it change", async () => {
    settingsMock.mockResolvedValue(settings())
    const items = [3, 5].map((number) => ({
      number,
      url: `https://github.com/acme/widget/issues/${number}`,
      title: `issue ${number}`,
    }))
    renderDialog(
      task({
        source_kind: "forge_issue",
        source_meta: meta({ head_ref: null, number: 3, items, pr_closes: [5] }),
      })
    )
    const three = await screen.findByRole("checkbox", { name: /#3/ })
    expect(three).not.toBeChecked()
    expect(three).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: /#5/ })).toBeChecked()
    expect(
      screen.getByText(/edit the pull request's description on the forge/)
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Push and open" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(
        7,
        "Fix login",
        false,
        true,
        true
      )
    )
  })

  it("offers no worktree choice when there is no worktree left", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog(task({ worktree_missing: true }))

    await waitFor(() => expect(settingsMock).toHaveBeenCalled())
    expect(
      screen.queryByRole("checkbox", { name: /Delete the worktree/ })
    ).toBeNull()
    // Whether the push finishes the task (and whether its thread hears about
    // it) is still the user's to say.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2)

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, true)
    )
  })

  // The seed is one await away, and the box is the only control here that
  // destroys something — so a default arriving inside that window must not
  // land on top of an answer the user already gave.
  it("does not let the folder default overwrite a choice made while it loads", async () => {
    let resolveSettings: (s: WorkTaskFolderSettings) => void = () => {}
    settingsMock.mockReturnValue(
      new Promise<WorkTaskFolderSettings>((r) => {
        resolveSettings = r
      })
    )
    renderDialog()

    // Answered before the folder's "delete" default arrives.
    const box = screen.getByRole("checkbox", {
      name: /Delete the worktree after pushing/,
    })
    expect(box).not.toBeChecked()
    await userEvent.click(box)
    expect(box).toBeChecked()
    await userEvent.click(box)

    resolveSettings(settings({ delete_worktree_default: true }))
    await waitFor(() => expect(settingsMock).toHaveBeenCalled())
    expect(box).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, true)
    )
  })

  it("does not carry the previous task's resolved value into the next open", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: true }))
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskDeliverPrDialog open onOpenChange={() => {}} task={task()} />
      </NextIntlClientProvider>
    )
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", {
          name: /Delete the worktree after pushing/,
        })
      ).toBeChecked()
    )

    // A second task, in a folder whose default never resolves. The box must
    // read "keep" rather than inheriting the first task's answer.
    settingsMock.mockReturnValue(new Promise<WorkTaskFolderSettings>(() => {}))
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskDeliverPrDialog
          open
          onOpenChange={() => {}}
          task={task({ id: 8, folder_id: 2 })}
        />
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(settingsMock).toHaveBeenCalledWith(2))
    expect(
      screen.getByRole("checkbox", {
        name: /Delete the worktree after pushing/,
      })
    ).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(8, null, false, false, true)
    )
  })

  // The worktree goes only with a delivery that finishes the task: one kept
  // in review runs its next round in it. The box says so by following the
  // one above it, and remembers its answer for when that is ticked again.
  it("takes the worktree only with a delivery that finishes the task", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog(
      task({
        source_kind: "forge_issue",
        source_meta: meta({ head_ref: null }),
      })
    )
    const cleanup = await screen.findByRole("checkbox", {
      name: /Delete the worktree after delivering/,
    })
    await waitFor(() => expect(cleanup).toBeChecked())
    const done = screen.getByRole("checkbox", {
      name: "Mark the task as done after delivering",
    })
    expect(done).toBeChecked()
    expect(screen.queryByText(/The task stays in review/)).toBeNull()

    await userEvent.click(done)
    expect(done).not.toBeChecked()
    expect(cleanup).toBeDisabled()
    expect(cleanup).not.toBeChecked()
    expect(screen.getByText(/The task stays in review/)).toBeInTheDocument()

    // Ticked again: the worktree answer given before comes back.
    await userEvent.click(done)
    expect(cleanup).toBeEnabled()
    expect(cleanup).toBeChecked()

    await userEvent.click(done)
    await userEvent.click(screen.getByRole("button", { name: "Push and open" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(
        7,
        "Fix login",
        false,
        false,
        false
      )
    )
  })

  it("keeps a pushed-back task in review on request", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: false }))
    renderDialog()
    await waitFor(() => expect(settingsMock).toHaveBeenCalled())

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Mark the task as done after pushing",
      })
    )
    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, false)
    )
  })

  // An ordinary task goes to its project's `origin`: no issue to link or
  // close, so the description says only where the branch goes.
  it("opens a pull request for an ordinary task on its project's origin", async () => {
    settingsMock.mockResolvedValue(settings())
    remoteMock.mockResolvedValue(remote())
    renderDialog(localTask())

    expect(
      await screen.findByText(
        "Pushes this task's branch to acme/site and opens a pull request against main."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/issue/i)).toBeNull()
    expect(
      screen.getByRole("heading", { name: "Deliver as a pull request" })
    ).toBeInTheDocument()
    const cleanup = await screen.findByRole("checkbox", {
      name: /Delete the worktree after delivering/,
    })
    await waitFor(() => expect(cleanup).toBeChecked())

    await userEvent.click(screen.getByRole("checkbox", { name: /draft/ }))
    await userEvent.click(screen.getByRole("button", { name: "Push and open" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, "Fix login", true, true, true)
    )
  })

  // The backend resolves a first local delivery's target from the project's
  // `origin` when it runs, so the dialog reads that remote fresh — never from
  // the board's memory — names what it read, and sends nothing before.
  it("reads the project's remote fresh and sends nothing until it has", async () => {
    settingsMock.mockResolvedValue(settings())
    // What the board remembered: a repository the origin no longer names.
    rememberForgeRemote(1, remote({ owner_repo: "old/place" }))
    let resolve: (r: ForgeRemote) => void = () => {}
    remoteMock.mockReturnValue(
      new Promise<ForgeRemote>((r) => {
        resolve = r
      })
    )
    renderDialog(localTask())

    expect(
      screen.getByText("Reading the project's remote…")
    ).toBeInTheDocument()
    expect(screen.queryByText(/old\/place/)).toBeNull()
    const send = screen.getByRole("button", { name: "Push and open" })
    expect(send).toBeDisabled()

    resolve(remote())
    expect(
      await screen.findByText(
        "Pushes this task's branch to acme/site and opens a pull request against main."
      )
    ).toBeInTheDocument()
    expect(send).toBeEnabled()
    expect(remoteMock).toHaveBeenCalledWith(1)
  })

  it("refuses to send where the fresh read finds no forge to deliver to", async () => {
    settingsMock.mockResolvedValue(settings())
    remoteMock.mockResolvedValue(remote({ supported: false }))
    const first = renderDialog(localTask())
    expect(
      await screen.findByText(/is not on GitHub, GitLab or Gitea/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Push and open" })).toBeDisabled()
    first.unmount()

    remoteMock.mockRejectedValue(new Error("offline"))
    renderDialog(localTask())
    expect(
      await screen.findByText(/Could not read the project's remote/)
    ).toBeInTheDocument()
    const send = screen.getByRole("button", { name: "Push and open" })
    expect(send).toBeDisabled()
    await userEvent.click(send)
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it("speaks GitLab's language for a project on GitLab", async () => {
    settingsMock.mockResolvedValue(settings())
    remoteMock.mockResolvedValue(remote({ provider: "gitlab" }))
    renderDialog(localTask())

    expect(
      await screen.findByRole("heading", { name: "Deliver as a merge request" })
    ).toBeInTheDocument()
    expect(screen.getByText("Merge request title")).toBeInTheDocument()
  })

  // Delivered once and kept in review: the next delivery pushes into the
  // pull request it opened — nothing to name, and its record (not the
  // folder's remote) says where.
  it("pushes into the pull request an earlier delivery opened", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog(
      localTask({
        delivery: {
          provider: "github",
          server_host: "github.com",
          account_id: "acct",
          owner_repo: "acme/site",
          pr_url: "https://github.com/acme/site/pull/9",
          pr_number: 9,
        },
      })
    )

    expect(
      screen.getByRole("heading", { name: "Update the pull request" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Pushes the latest commits on task/7 to acme/site, updating the pull request this task opened."
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("checkbox", { name: /draft/ })).toBeNull()
    expect(remoteMock).not.toHaveBeenCalled()
    const cleanup = await screen.findByRole("checkbox", {
      name: /Delete the worktree after delivering/,
    })
    await waitFor(() => expect(cleanup).toBeChecked())

    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, true, true)
    )
  })

  it("does the same for an issue's task kept in review", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: false }))
    renderDialog(
      task({
        source_kind: "forge_issue",
        source_meta: meta({
          provider: "gitlab",
          head_ref: null,
          result_pr: "https://gitlab.com/acme/widget/-/merge_requests/3",
          result_pr_number: 3,
        }),
      })
    )
    expect(
      screen.getByRole("heading", { name: "Update the merge request" })
    ).toBeInTheDocument()
    await waitFor(() => expect(settingsMock).toHaveBeenCalled())
    await userEvent.click(screen.getByRole("button", { name: "Push" }))
    await waitFor(() =>
      expect(deliverMock).toHaveBeenCalledWith(7, null, false, false, true)
    )
  })
})

/**
 * Delivering to a pull request from the drawer — where a reviewed task's
 * acceptances live.
 *
 * An issue's task always offered it. An ordinary task offers it exactly where
 * its project's `origin` lives on a forge codeg can deliver to (GitHub, GitLab,
 * Gitea / Forgejo): the drawer reads that remote, fresh, when it opens. A task
 * that delivered once and stayed in review pushes into the pull request it
 * opened, and says so — and links it while it waits.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { resetForgeProviderCacheForTests } from "@/lib/forge-provider-cache"
import type { ForgeRemote, WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

const folderForgeRemote = vi.fn()

vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDefer: vi.fn().mockResolvedValue(undefined),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskMergeUnqueue: vi.fn().mockResolvedValue(undefined),
  workTaskRequeue: vi.fn().mockResolvedValue(undefined),
  workTaskRetry: vi.fn().mockResolvedValue(undefined),
  workTaskReturn: vi.fn().mockResolvedValue(undefined),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
  folderForgeRemote: (...args: unknown[]) => folderForgeRemote(...args),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
// Heavy leaves with nothing to say about the action panel.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div />,
}))
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: () => <div data-testid="follow-up-composer" />,
}))
// See task-detail-sheet.worktree.test.tsx: its module graph reaches a store
// that is stubbed above down to a bare hook.
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Tidy the login form",
    config: null,
    status: "review",
    base_branch: "main",
    work_branch: "task/7",
    worktree_folder_id: 9,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 3,
    ...overrides,
  } as WorkTask
}

function remote(overrides?: Partial<ForgeRemote>): ForgeRemote {
  return {
    server_host: "github.com",
    owner_repo: "acme/app",
    remote_url: "https://github.com/acme/app.git",
    provider: "github",
    supported: true,
    ...overrides,
  }
}

const delivered = {
  provider: "github",
  server_host: "github.com",
  account_id: "acct",
  owner_repo: "acme/app",
  pr_url: "https://github.com/acme/app/pull/12",
  pr_number: 12,
} as const

function mount(row: WorkTask, onDeliverPr = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDetailSheet
        open
        onOpenChange={() => {}}
        task={row}
        folderName="repo"
        onMerge={() => {}}
        onComplete={() => {}}
        onDeliverPr={onDeliverPr}
        onCancel={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
  return { onDeliverPr, view }
}

const button = (name: string) => screen.queryByRole("button", { name })

beforeEach(() => {
  vi.clearAllMocks()
  folderForgeRemote.mockReset()
  resetForgeProviderCacheForTests()
})

describe("task drawer pull-request delivery", () => {
  it("offers an ordinary task a pull request on a forge its project lives on", async () => {
    const user = userEvent.setup()
    folderForgeRemote.mockResolvedValue(remote())
    const { onDeliverPr } = mount(task())

    const open = await screen.findByRole("button", {
      name: "Open pull request",
    })
    expect(folderForgeRemote).toHaveBeenCalledWith(1)
    // A second way to accept: the merge keeps the lead.
    expect(button("Merge")).toHaveAttribute("data-variant", "default")
    expect(open).toHaveAttribute("data-variant", "outline")
    await user.click(open)
    expect(onDeliverPr).toHaveBeenCalledTimes(1)
  })

  it("names it a merge request on GitLab, and offers it on Gitea too", async () => {
    folderForgeRemote.mockResolvedValue(remote({ provider: "gitlab" }))
    const first = mount(task())
    expect(
      await screen.findByRole("button", { name: "Open merge request" })
    ).toBeInTheDocument()
    first.view.unmount()

    resetForgeProviderCacheForTests()
    folderForgeRemote.mockResolvedValue(remote({ provider: "gitea" }))
    mount(task())
    expect(
      await screen.findByRole("button", { name: "Open pull request" })
    ).toBeInTheDocument()
  })

  it("offers nothing where codeg cannot deliver", async () => {
    // A remote it cannot read (Bitbucket, Gitee …), and no remote at all.
    folderForgeRemote.mockResolvedValue(remote({ supported: false }))
    const first = mount(task())
    await waitFor(() => expect(folderForgeRemote).toHaveBeenCalled())
    expect(button("Open pull request")).toBeNull()
    expect(button("Merge")).not.toBeNull()
    first.view.unmount()

    resetForgeProviderCacheForTests()
    folderForgeRemote.mockResolvedValue(null)
    mount(task())
    await waitFor(() => expect(folderForgeRemote).toHaveBeenCalledTimes(2))
    expect(button("Open pull request")).toBeNull()
  })

  it("does not ask about a task with nothing to deliver", async () => {
    mount(task({ files_changed: 0 }))
    expect(button("Complete")).not.toBeNull()
    expect(folderForgeRemote).not.toHaveBeenCalled()
  })

  // Delivered once and kept in review: the record says where it goes, so the
  // remote is not asked, the action names the update, and the pull request it
  // waits on is linked.
  it("updates the pull request a kept task opened, and links it", async () => {
    mount(task({ delivery: delivered }))
    expect(button("Update pull request")).not.toBeNull()
    expect(button("Open pull request")).toBeNull()
    expect(folderForgeRemote).not.toHaveBeenCalled()
    const link = screen.getByTitle(delivered.pr_url)
    expect(link).toHaveTextContent(delivered.pr_url)
  })

  it("offers the update beside complete when the round left nothing new", () => {
    mount(task({ delivery: delivered, files_changed: 0 }))
    expect(button("Complete")).toHaveAttribute("data-variant", "default")
    expect(button("Update pull request")).toHaveAttribute(
      "data-variant",
      "outline"
    )
    expect(button("Merge")).toBeNull()
  })

  it("does the same for an issue's task kept in review", () => {
    mount(
      task({
        source_kind: "forge_issue",
        source_meta: {
          provider: "gitlab",
          server_host: "gitlab.com",
          api_base: "https://gitlab.com/api/v4",
          account_id: "acct",
          owner_repo: "acme/app",
          number: 3,
          url: "https://gitlab.com/acme/app/-/issues/3",
          title: "Login fails",
          result_pr: "https://gitlab.com/acme/app/-/merge_requests/5",
          result_pr_number: 5,
        },
      })
    )
    expect(button("Update merge request")).not.toBeNull()
    expect(
      screen.getByTitle("https://gitlab.com/acme/app/-/merge_requests/5")
    ).toBeInTheDocument()
  })
})

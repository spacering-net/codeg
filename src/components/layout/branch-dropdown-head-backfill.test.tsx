import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BranchDropdown } from "./branch-dropdown"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

/**
 * The branch chip has to be able to answer for a folder the workspace is NOT
 * polling.
 *
 * `app-workspace-context` polls `git rev-parse` for exactly one folder — the
 * active tab's — and the folder row's `git_branch` column is never written by
 * anything. So a chip mounted for any other folder saw `branch === null` and no
 * `gitHeads` entry, computed `isRepo === false`, and rendered the non-git
 * "no branch / initialise a repo" chip forever. A canvas board is the case that
 * makes this constant: many folders on screen, none of them the active tab.
 */

const getGitHead = vi.fn()

vi.mock("@/lib/api", () => ({
  // Consumed by the dropdown itself.
  gitInit: vi.fn(),
  gitNewBranch: vi.fn(),
  gitWorktreeAdd: vi.fn(),
  gitListAllBranches: vi.fn(async () => ({
    local: [],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })),
  gitMerge: vi.fn(),
  gitRebase: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitDeleteRemoteBranch: vi.fn(),
  gitRemoveWorktree: vi.fn(),
  // Consumed by the workspace store this test drives for real.
  getFolder: vi.fn(),
  getGitHead: (path: string) => getGitHead(path),
  listAllConversations: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
  listFolderGroups: vi.fn(async () => []),
  listOpenFolderDetails: vi.fn(async () => []),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  openWorktreeFolder: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  emitEvent: vi.fn(),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openNewConversationTab: vi.fn() }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))

vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({ withCredentialRetry: vi.fn() }),
}))

vi.mock("@/hooks/use-switch-to-branch", () => ({
  useSwitchToBranch: () => vi.fn(),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    runGitTask: vi.fn(),
    pull: vi.fn(),
    fetchAll: vi.fn(),
    updateBranch: vi.fn(),
    reportConflict: vi.fn(),
    openCommitWindow: vi.fn(),
    openPushWindow: vi.fn(),
    openStashDialog: vi.fn(),
    openUnstashWindow: vi.fn(),
    dialogs: null,
  }),
}))

function folder(over: Partial<FolderDetail> & { id: number }): FolderDetail {
  return {
    name: `folder-${over.id}`,
    path: `/repo/folder-${over.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: over.id,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...over,
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
  getGitHead.mockReset()
})

afterEach(() => cleanup())

describe("BranchDropdown — HEAD backfill for an unpolled folder", () => {
  it("resolves its own HEAD and shows the real branch", async () => {
    getGitHead.mockResolvedValue({
      is_repo: true,
      branch: "feature/canvas",
      detached: false,
      short_sha: "abc1234",
    })
    const repo = folder({ id: 7, path: "/repo/seven" })

    render(<BranchDropdown folder={repo} isChatMode={false} />)

    // Before the read lands there is nothing to show but the honest fallback.
    expect(screen.getByText("noBranch")).toBeInTheDocument()
    expect(await screen.findByText("feature/canvas")).toBeInTheDocument()
    expect(getGitHead).toHaveBeenCalledWith("/repo/seven")
  })

  it("stays quiet when the HEAD is already known", () => {
    useAppWorkspaceStore.getState().applyGitHead(7, {
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })

    render(<BranchDropdown folder={folder({ id: 7 })} isChatMode={false} />)

    expect(screen.getByText("main")).toBeInTheDocument()
    // The active folder's poll owns freshness; a chip that already has an answer
    // must not add a second reader per mounted card.
    expect(getGitHead).not.toHaveBeenCalled()
  })

  it("asks nothing for a folderless chat conversation", () => {
    // Chat mode renders no chip at all — asking git about a folder the
    // conversation does not have would be a request with no consumer.
    const { container } = render(
      <BranchDropdown folder={folder({ id: 7 })} isChatMode />
    )

    expect(container).toBeEmptyDOMElement()
    expect(getGitHead).not.toHaveBeenCalled()
  })
})

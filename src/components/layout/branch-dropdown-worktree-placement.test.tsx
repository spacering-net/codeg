import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FolderDetail } from "@/lib/types"

const h = vi.hoisted(() => ({
  transportCall: vi.fn(),
  tauriInvoke: vi.fn(),
  openWorktreeFolder: vi.fn(),
  openNewConversationTab: vi.fn(),
  openConversations: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: h.transportCall,
  }),
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.tauriInvoke,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  emitEvent: vi.fn(),
  isDesktop: () => false,
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openNewConversationTab: h.openNewConversationTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: h.openConversations }),
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
    runGitTask: async (_label: string, task: () => Promise<unknown>) => {
      await task()
      return true
    },
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

vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react")
  return {
    Virtualizer: forwardRef(function VirtualizerMock(
      props: { children?: React.ReactNode },
      ref: React.Ref<{ scrollToIndex: () => void }>
    ) {
      useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }))
      return <>{props.children}</>
    }),
  }
})

vi.mock("@/components/ui/scroll-area", async () => {
  const { useEffect } = await import("react")
  return {
    ScrollArea: ({
      children,
      onViewportRef,
    }: {
      children?: React.ReactNode
      onViewportRef?: (el: HTMLElement | null) => void
    }) => {
      useEffect(() => {
        onViewportRef?.(document.createElement("div"))
      }, [onViewportRef])
      return <>{children}</>
    },
  }
})

import { gitWorktreeAdd as apiGitWorktreeAdd } from "@/lib/api"
import { gitWorktreeAdd as tauriGitWorktreeAdd } from "@/lib/tauri"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { BranchDropdown } from "./branch-dropdown"

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number }
): FolderDetail {
  return {
    name: "repo",
    path: "/workspace/repo",
    git_branch: "main",
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: 1,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

describe("gitWorktreeAdd API and Tauri wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sends allowPluginDestination: true and returns redirected paths or null on legacy hosts", async () => {
    h.transportCall.mockResolvedValueOnce("/plugins/worktrees/feat-1")
    await expect(
      apiGitWorktreeAdd("/workspace/repo", "feat-1", "/workspace/repo-feat-1")
    ).resolves.toBe("/plugins/worktrees/feat-1")
    expect(h.transportCall).toHaveBeenCalledWith("git_worktree_add", {
      path: "/workspace/repo",
      branchName: "feat-1",
      worktreePath: "/workspace/repo-feat-1",
      allowPluginDestination: true,
    })

    h.transportCall.mockResolvedValueOnce(null)
    await expect(
      apiGitWorktreeAdd("/workspace/repo", "feat-2", "/workspace/repo-feat-2")
    ).resolves.toBeNull()

    h.tauriInvoke.mockResolvedValueOnce("/plugins/worktrees/tauri-feat")
    await expect(
      tauriGitWorktreeAdd(
        "/workspace/repo",
        "tauri-feat",
        "/workspace/repo-tauri-feat"
      )
    ).resolves.toBe("/plugins/worktrees/tauri-feat")
    expect(h.tauriInvoke).toHaveBeenCalledWith("git_worktree_add", {
      path: "/workspace/repo",
      branchName: "tauri-feat",
      worktreePath: "/workspace/repo-tauri-feat",
      allowPluginDestination: true,
    })

    h.tauriInvoke.mockResolvedValueOnce(undefined)
    await expect(
      tauriGitWorktreeAdd("/workspace/repo", "legacy", "/workspace/repo-legacy")
    ).resolves.toBeNull()

    // Preserves trailing spaces in valid Unix paths verbatim
    h.transportCall.mockResolvedValueOnce("/plugins/worktrees/trailing ")
    await expect(
      apiGitWorktreeAdd(
        "/workspace/repo",
        "feat-space",
        "/workspace/repo-space"
      )
    ).resolves.toBe("/plugins/worktrees/trailing ")
  })
})

describe("BranchDropdown worktree creation with worktree.create.before placement", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAppWorkspaceStore()
    const repo = makeFolder({ id: 7, path: "/workspace/repo" })
    useAppWorkspaceStore.setState({
      folders: [repo],
      allFolders: [repo],
      openWorktreeFolder: h.openWorktreeFolder,
    })
    useAppWorkspaceStore.getState().applyGitHead(7, {
      is_repo: true,
      branch: "main",
      detached: false,
      short_sha: "abc1234",
    })
  })

  afterEach(() => {
    cleanup()
  })

  async function openNewWorktreeDialog(
    user: ReturnType<typeof userEvent.setup>
  ) {
    h.transportCall.mockImplementation(async (cmd: string) => {
      if (cmd === "git_list_all_branches") {
        return {
          local: ["main"],
          remote: [],
          worktree_branches: [],
          main_worktree_branch: "main",
        }
      }
      return null
    })

    render(
      <BranchDropdown
        folder={makeFolder({ id: 7, path: "/workspace/repo" })}
        isChatMode={false}
      />
    )

    await user.click(screen.getByRole("button", { name: /main/ }))
    await user.click(await screen.findByText("newWorktree"))
    const branchInput = await screen.findByLabelText("dialogs.branchNameLabel")
    const pathInput = screen.getByLabelText("dialogs.worktreePathLabel")
    return { branchInput, pathInput }
  }

  it("opens the plugin-redirected worktree destination and starts the draft tab there", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { branchInput, pathInput } = await openNewWorktreeDialog(user)

    await user.clear(branchInput)
    await user.type(branchInput, "feat/plugin-placed")
    await user.clear(pathInput)
    await user.type(pathInput, "/workspace/requested-wt")

    const redirectedPath = "/custom/plugin-worktrees/repo-feat-placed"
    h.transportCall.mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_add") return redirectedPath
      return null
    })
    h.openWorktreeFolder.mockResolvedValueOnce(
      makeFolder({
        id: 88,
        parent_id: 7,
        name: "repo-feat-placed",
        path: redirectedPath,
        git_branch: "feat/plugin-placed",
      })
    )

    await user.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() => {
      expect(h.transportCall).toHaveBeenCalledWith("git_worktree_add", {
        path: "/workspace/repo",
        branchName: "feat/plugin-placed",
        worktreePath: "/workspace/requested-wt",
        allowPluginDestination: true,
      })
      expect(h.openWorktreeFolder).toHaveBeenCalledWith(redirectedPath, 7)
      expect(h.openConversations).toHaveBeenCalled()
      expect(h.openNewConversationTab).toHaveBeenCalledWith(88, redirectedPath)
    })
  })

  it("falls back to the requested worktree path when a legacy host returns null or undefined", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { branchInput, pathInput } = await openNewWorktreeDialog(user)

    await user.clear(branchInput)
    await user.type(branchInput, "feat/legacy-host")
    await user.clear(pathInput)
    await user.type(pathInput, "/workspace/requested-legacy-wt")

    h.transportCall.mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_add") return null
      return null
    })
    h.openWorktreeFolder.mockResolvedValueOnce(
      makeFolder({
        id: 89,
        parent_id: 7,
        name: "requested-legacy-wt",
        path: "/workspace/requested-legacy-wt",
        git_branch: "feat/legacy-host",
      })
    )

    await user.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() => {
      expect(h.openWorktreeFolder).toHaveBeenCalledWith(
        "/workspace/requested-legacy-wt",
        7
      )
      expect(h.openNewConversationTab).toHaveBeenCalledWith(
        89,
        "/workspace/requested-legacy-wt"
      )
    })
  })

  it("preserves trailing spaces in plugin-returned worktree destinations byte-for-byte", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { branchInput, pathInput } = await openNewWorktreeDialog(user)

    await user.clear(branchInput)
    await user.type(branchInput, "feat/trailing-space")
    await user.clear(pathInput)
    await user.type(pathInput, "/workspace/requested-wt")

    const trailingSpaceDestination = "/custom/plugin-worktrees/trailing-space "
    const authoritativeDetailPath =
      "/canonical/plugin-worktrees/trailing-space "
    h.transportCall.mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_add") return trailingSpaceDestination
      return null
    })
    h.openWorktreeFolder.mockResolvedValueOnce(
      makeFolder({
        id: 90,
        parent_id: 7,
        name: "trailing-space ",
        path: authoritativeDetailPath,
        git_branch: "feat/trailing-space",
      })
    )

    await user.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() => {
      expect(h.openWorktreeFolder).toHaveBeenCalledWith(
        trailingSpaceDestination,
        7
      )
      expect(h.openNewConversationTab).toHaveBeenCalledWith(
        90,
        authoritativeDetailPath
      )
    })
  })
})

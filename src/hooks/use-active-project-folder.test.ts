import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  projectFolderIdOf,
  useActiveProjectFolderId,
} from "./use-active-project-folder"

function folder(overrides: Partial<FolderDetail>): FolderDetail {
  return {
    id: 1,
    name: "codeg",
    path: "/work/codeg",
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-10-01T00:00:00Z",
    sort_order: 0,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

const ROOT = folder({ id: 1 })
const WORKTREE = folder({ id: 11, parent_id: 1, path: "/work/codeg-wt" })
const CHAT = folder({ id: 20, kind: "chat", path: "/chats/20" })

beforeEach(() => {
  resetAppWorkspaceStore()
})

describe("projectFolderIdOf", () => {
  it("is the folder itself, a worktree's root, and nothing for a chat", () => {
    expect(projectFolderIdOf(ROOT)).toBe(1)
    expect(projectFolderIdOf(WORKTREE)).toBe(1)
    expect(projectFolderIdOf(CHAT)).toBeNull()
    expect(projectFolderIdOf(null)).toBeNull()
  })
})

describe("useActiveProjectFolderId", () => {
  it("follows the active folder to its project", () => {
    // The root is closed (not in `folders`), yet still the worktree's project.
    useAppWorkspaceStore.setState({
      allFolders: [ROOT, WORKTREE, CHAT],
      folders: [WORKTREE],
      activeFolderId: 11,
    })
    const { result } = renderHook(() => useActiveProjectFolderId())
    expect(result.current).toBe(1)

    act(() => useAppWorkspaceStore.setState({ activeFolderId: 20 }))
    expect(result.current).toBeNull()

    act(() => useAppWorkspaceStore.setState({ activeFolderId: null }))
    expect(result.current).toBeNull()
  })
})

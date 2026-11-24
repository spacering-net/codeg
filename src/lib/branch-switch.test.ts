import { describe, expect, it } from "vitest"
import {
  planBranchSwitch,
  resolveRootFolder,
  type BranchSwitchPlan,
} from "@/lib/branch-switch"
import type { FolderDetail, WorktreeResolution } from "@/lib/types"

function mkFolder(p: Partial<FolderDetail> & { id: number }): FolderDetail {
  return {
    name: `folder-${p.id}`,
    path: `/repo/folder-${p.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: p.id,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...p,
  }
}

const root = mkFolder({ id: 1, name: "myproject", path: "/repo/main" })
const wtA = mkFolder({
  id: 2,
  name: "myproject-a",
  path: "/repo/wt-a",
  parent_id: 1,
})
const wtB = mkFolder({
  id: 3,
  name: "myproject-b",
  path: "/repo/wt-b",
  parent_id: 1,
})
const allFolders = [root, wtA, wtB]

const res = (
  path: string | null,
  folder_id: number | null
): WorktreeResolution => ({ path, folder_id })

describe("resolveRootFolder", () => {
  it("returns itself for a top-level folder", () => {
    expect(resolveRootFolder(root, allFolders)).toBe(root)
  })
  it("returns the parent for a worktree folder", () => {
    expect(resolveRootFolder(wtA, allFolders)).toBe(root)
  })
  it("falls back to itself when the parent is absent", () => {
    const orphan = mkFolder({ id: 9, parent_id: 404 })
    expect(resolveRootFolder(orphan, allFolders)).toBe(orphan)
  })
})

describe("planBranchSwitch", () => {
  const plan = (
    activeFolder: FolderDetail,
    resolution: WorktreeResolution | null,
    isRemote = false
  ): BranchSwitchPlan =>
    planBranchSwitch({ activeFolder, resolution, allFolders, isRemote })

  it("checks out in root when the branch is not checked out anywhere (active=root)", () => {
    expect(plan(root, res(null, null))).toEqual({
      kind: "checkoutInRoot",
      rootFolder: root,
    })
  })

  it("checks out in the parent root when active is a worktree and branch is free", () => {
    expect(plan(wtA, res(null, null))).toEqual({
      kind: "checkoutInRoot",
      rootFolder: root,
    })
  })

  it("is a noop when the branch is already checked out in the active folder", () => {
    expect(plan(wtA, res("/repo/wt-a", 2))).toEqual({ kind: "noop" })
  })

  it("navigates to a registered sibling worktree (active=root → child)", () => {
    expect(plan(root, res("/repo/wt-a", 2))).toEqual({
      kind: "navigateRegistered",
      folderId: 2,
    })
  })

  it("navigates to the root/main tree (active=worktree → root branch)", () => {
    expect(plan(wtA, res("/repo/main", 1))).toEqual({
      kind: "navigateRegistered",
      folderId: 1,
    })
  })

  it("navigates to another worktree (active=worktree → sibling)", () => {
    expect(plan(wtA, res("/repo/wt-b", 3))).toEqual({
      kind: "navigateRegistered",
      folderId: 3,
    })
  })

  it("registers + navigates an external worktree, parented to root", () => {
    expect(plan(wtA, res("/repo/external", null))).toEqual({
      kind: "navigateExternal",
      path: "/repo/external",
      rootId: 1,
    })
  })

  // Remote selections must never navigate to a same-short-name local worktree:
  // a remote ref like `upstream/feature` is checked out (tracked) in root, even
  // when a local `feature` is checked out in a worktree.
  it("checks out in root for a remote selection (resolution null)", () => {
    expect(plan(wtA, null, true)).toEqual({
      kind: "checkoutInRoot",
      rootFolder: root,
    })
  })

  it("ignores a worktree match for a remote selection (no navigate)", () => {
    // Even if a local branch of the same short name lives in a worktree, a
    // remote selection still checks out in root rather than navigating.
    expect(plan(root, res("/repo/wt-a", 2), true)).toEqual({
      kind: "checkoutInRoot",
      rootFolder: root,
    })
  })
})

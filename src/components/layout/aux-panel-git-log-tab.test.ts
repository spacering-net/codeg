import { beforeEach, describe, expect, it } from "vitest"

import {
  canResetFromSelection,
  coerceLiveBranchSelection,
  HEAD_BRANCH_FILTER,
  isHeadFilter,
  isLiveBranchSelection,
  loadSelection,
  saveSelection,
} from "./aux-panel-git-log-tab"
import type { GitBranchList } from "@/lib/types"

const branchList: GitBranchList = {
  local: ["main", "feature/x"],
  remote: ["origin/main"],
  worktree_branches: [],
  main_worktree_branch: null,
}

describe("isHeadFilter", () => {
  it("only recognizes the literal HEAD sentinel", () => {
    expect(isHeadFilter(HEAD_BRANCH_FILTER)).toBe(true)
    expect(isHeadFilter("HEAD")).toBe(true)
  })

  it("does not mistake a ref that merely mentions HEAD", () => {
    // git rejects `HEAD` as a local branch name and git_list_all_branches drops
    // remote refs containing HEAD, so nothing in the list can collide — but a
    // near-miss must never be treated as the dynamic view.
    expect(isHeadFilter("origin/HEAD")).toBe(false)
    expect(isHeadFilter("head")).toBe(false)
    expect(isHeadFilter("HEADs")).toBe(false)
    expect(isHeadFilter(null)).toBe(false)
  })
})

describe("isLiveBranchSelection", () => {
  it("keeps the HEAD sentinel even though it is not in the branch list", () => {
    // The dead-branch cleanup in refreshBranches would otherwise clear the
    // dynamic filter on the very first branch refresh.
    expect(isLiveBranchSelection(HEAD_BRANCH_FILTER, branchList)).toBe(true)
  })

  it("keeps the all-branches view", () => {
    expect(isLiveBranchSelection(null, branchList)).toBe(true)
  })

  it("keeps a branch that still exists locally or on a remote", () => {
    expect(isLiveBranchSelection("main", branchList)).toBe(true)
    expect(isLiveBranchSelection("feature/x", branchList)).toBe(true)
    expect(isLiveBranchSelection("origin/main", branchList)).toBe(true)
  })

  it("drops a branch that no longer exists", () => {
    expect(isLiveBranchSelection("feature/deleted", branchList)).toBe(false)
    // Bare name of a remote-only ref is not itself a branch here.
    expect(isLiveBranchSelection("origin/gone", branchList)).toBe(false)
  })
})

describe("canResetFromSelection", () => {
  it("allows reset from the all-branches view", () => {
    expect(canResetFromSelection("main", null)).toBe(true)
  })

  it("allows reset from the HEAD view", () => {
    // The HEAD view IS the current branch, so resetting it is consistent.
    expect(canResetFromSelection("main", HEAD_BRANCH_FILTER)).toBe(true)
  })

  it("allows reset while viewing the current branch by name", () => {
    expect(canResetFromSelection("main", "main")).toBe(true)
  })

  it("blocks reset while viewing a different branch", () => {
    expect(canResetFromSelection("main", "feature/x")).toBe(false)
    expect(canResetFromSelection("main", "origin/main")).toBe(false)
  })

  it("blocks reset with no current branch (detached HEAD)", () => {
    expect(canResetFromSelection(null, null)).toBe(false)
    expect(canResetFromSelection(null, HEAD_BRANCH_FILTER)).toBe(false)
  })
})

describe("commits branch selection per worktree", () => {
  beforeEach(() => window.localStorage.clear())

  it("opens a worktree on its live HEAD when no filter was saved", () => {
    expect(loadSelection("/worktrees/a")).toEqual({
      branch: "HEAD",
      author: null,
    })
  })

  it("keeps an explicit All branches choice after reopening", () => {
    saveSelection("/worktrees/a", { branch: null, author: null })
    expect(loadSelection("/worktrees/a")).toEqual({
      branch: null,
      author: null,
    })
    expect(
      window.localStorage.getItem("codeg:gitlog:selection:/worktrees/a")
    ).not.toBeNull()
  })

  it("keeps selections separate when switching worktrees", () => {
    saveSelection("/worktrees/a", { branch: "feature/x", author: null })
    saveSelection("/worktrees/b", { branch: null, author: "Alice" })

    expect(loadSelection("/worktrees/a").branch).toBe("feature/x")
    expect(loadSelection("/worktrees/b")).toEqual({
      branch: null,
      author: "Alice",
    })
    expect(loadSelection("/worktrees/c").branch).toBe("HEAD")
  })

  it("uses the live HEAD even when the checkout is detached", () => {
    const selection = loadSelection("/worktrees/detached")
    expect(selection.branch).toBe("HEAD")
    expect(
      isLiveBranchSelection(selection.branch, {
        local: [],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    ).toBe(true)
  })

  it("falls back to HEAD when a saved named branch disappears", () => {
    expect(coerceLiveBranchSelection("feature/deleted", branchList)).toBe(
      "HEAD"
    )
    expect(coerceLiveBranchSelection(null, branchList)).toBeNull()
    expect(coerceLiveBranchSelection("feature/x", branchList)).toBe("feature/x")
  })

  it("opens an author filter saved before the HEAD default on HEAD", () => {
    // Exactly what the old writer stored for an author picked on the then
    // default all-branches view: an unversioned null that was never a choice.
    window.localStorage.setItem(
      "codeg:gitlog:selection:/worktrees/a",
      JSON.stringify({ branch: null, author: "Alice" })
    )
    expect(loadSelection("/worktrees/a")).toEqual({
      branch: "HEAD",
      author: "Alice",
    })
    // A branch that was picked back then is still honoured.
    window.localStorage.setItem(
      "codeg:gitlog:selection:/worktrees/b",
      JSON.stringify({ branch: "feature/x", author: null })
    )
    expect(loadSelection("/worktrees/b").branch).toBe("feature/x")
  })

  it("treats a saved filter without a branch as the HEAD view", () => {
    window.localStorage.setItem(
      "codeg:gitlog:selection:/worktrees/a",
      JSON.stringify({ author: "Alice" })
    )
    expect(loadSelection("/worktrees/a")).toEqual({
      branch: "HEAD",
      author: "Alice",
    })
  })

  it("treats corrupt saved filters as a fresh HEAD view", () => {
    window.localStorage.setItem(
      "codeg:gitlog:selection:/worktrees/a",
      "{invalid"
    )
    expect(loadSelection("/worktrees/a").branch).toBe("HEAD")
  })
})

import { describe, expect, it } from "vitest"

import {
  branchLeafActions,
  buildBranchRows,
  isNavigableRow,
  type BranchOperationMeta,
  type BranchRow,
  type BuildBranchRowsInput,
} from "@/lib/branch-selector-rows"
import {
  buildBranchTree,
  buildRemoteBranchSections,
  localBranchItems,
  sectionKey,
  worktreeBranchNodes,
  type BranchTreeNode,
} from "@/lib/branch-tree"

const OPS: BranchOperationMeta[] = [
  { id: "pull", label: "Pull code" },
  { id: "push", label: "Push..." },
]

function localTree(names: string[]): BranchTreeNode[] {
  return buildBranchTree(localBranchItems(names), "local")
}

// Compact, readable shape for sequence assertions.
function summarize(row: BranchRow): string {
  switch (row.kind) {
    case "operation":
      return `op:${row.opId}`
    case "separator":
      return "sep"
    case "section":
      return `section:${row.scope}(${row.count})${row.expanded ? "+" : "-"}`
    case "group":
      return `group:${row.label}@${row.depth}${row.expanded ? "+" : "-"}`
    case "leaf":
      return `leaf:${row.fullName}@${row.depth}${row.isCurrent ? "*" : ""}`
    case "empty":
      return `empty:${row.scope}`
  }
}

function baseInput(
  overrides: Partial<BuildBranchRowsInput> = {}
): BuildBranchRowsInput {
  return {
    operations: OPS,
    worktreeNodes: [],
    localNodes: [],
    remoteSections: [],
    localCount: 0,
    remoteCount: 0,
    branch: null,
    worktreeBranchSet: new Set(),
    collapsed: new Set(),
    query: "",
    ...overrides,
  }
}

const LOCAL = [
  "main",
  "feature/auth/login",
  "feature/auth/logout",
  "release/1.0",
]

describe("buildBranchRows — empty query (tree mode)", () => {
  it("puts operations first, a separator, then default-expanded sections + flattened tree", () => {
    const rows = buildBranchRows(
      baseInput({ localNodes: localTree(LOCAL), localCount: 4, remoteCount: 0 })
    )
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:worktree(0)+",
      "empty:worktree",
      "section:local(4)+",
      "group:feature/auth/@1+",
      "leaf:feature/auth/login@2",
      "leaf:feature/auth/logout@2",
      "leaf:main@1",
      "leaf:release/1.0@1",
      "section:remote(0)+",
      "empty:remote",
    ])
  })

  it("collapsing the local section hides all its children", () => {
    const rows = buildBranchRows(
      baseInput({
        localNodes: localTree(LOCAL),
        localCount: 4,
        collapsed: new Set([sectionKey("local")]),
      })
    )
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:worktree(0)+",
      "empty:worktree",
      "section:local(4)-",
      "section:remote(0)+",
      "empty:remote",
    ])
  })

  it("collapsing a prefix group hides only that subtree", () => {
    const nodes = localTree(LOCAL)
    const groupKey = nodes.find((n) => n.type === "group")!.key
    const rows = buildBranchRows(
      baseInput({
        localNodes: nodes,
        localCount: 4,
        collapsed: new Set([groupKey]),
      })
    )
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:worktree(0)+",
      "empty:worktree",
      "section:local(4)+",
      "group:feature/auth/@1-",
      "leaf:main@1",
      "leaf:release/1.0@1",
      "section:remote(0)+",
      "empty:remote",
    ])
  })
})

describe("buildBranchRows — worktree section", () => {
  // A repo whose "task/132" and "loop/x" branches are checked out in linked
  // worktrees, viewed from the main working tree.
  const WORKTREES = ["task/132", "loop/x"]
  const worktreeInput = (overrides = {}) =>
    baseInput({
      worktreeNodes: worktreeBranchNodes(WORKTREES, null),
      worktreeBranchSet: new Set(WORKTREES),
      localNodes: localTree([...LOCAL, ...WORKTREES]),
      localCount: 6,
      ...overrides,
    })

  it("sits above the local section, expanded by default", () => {
    const rows = buildBranchRows(worktreeInput())
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:worktree(2)+",
      "leaf:loop/x@1",
      "leaf:task/132@1",
      "section:local(6)+",
      "group:feature/auth/@1+",
      "leaf:feature/auth/login@2",
      "leaf:feature/auth/logout@2",
      "leaf:loop/x@1",
      "leaf:main@1",
      "leaf:release/1.0@1",
      "leaf:task/132@1",
      "section:remote(0)+",
      "empty:remote",
    ])
  })

  it("groups worktrees that share a prefix, keyed apart from the local tree", () => {
    // The same `task/` prefix exists in both sections under different scoped
    // keys, so folding one leaves the other alone. WHICH of them starts folded
    // is the list component's default-seed decision, not this model's.
    const shared = ["task/131", "task/132"]
    const rowsWith = (collapsed: Set<string>) =>
      buildBranchRows(
        baseInput({
          worktreeNodes: worktreeBranchNodes(shared, null),
          worktreeBranchSet: new Set(shared),
          localNodes: localTree([...LOCAL, ...shared]),
          localCount: 6,
          collapsed,
        })
      ).map(summarize)

    const localFolded = rowsWith(new Set(["g local task"]))
    expect(localFolded.slice(3, 7)).toEqual([
      "section:worktree(2)+",
      "group:task/@1+",
      "leaf:task/131@2",
      "leaf:task/132@2",
    ])
    expect(localFolded).toContain("group:task/@1-")

    const worktreeFolded = rowsWith(new Set(["g worktree task"]))
    expect(worktreeFolded.slice(3, 5)).toEqual([
      "section:worktree(2)+",
      "group:task/@1-",
    ])
    expect(worktreeFolded).toContain("group:task/@1+")
  })

  it("counts leaves, not nodes, in its header", () => {
    const shared = ["task/131", "task/132", "loop/x"]
    const rows = buildBranchRows(
      baseInput({
        worktreeNodes: worktreeBranchNodes(shared, null),
        worktreeBranchSet: new Set(shared),
        localNodes: localTree(LOCAL),
        localCount: 4,
      })
    )
    expect(rows.map(summarize)).toContain("section:worktree(3)+")
  })

  it("keeps its place with an empty row when the repo has no other worktree", () => {
    const rows = buildBranchRows(
      baseInput({ localNodes: localTree(LOCAL), localCount: 4 })
    )
    // Same shape the remote section takes when a repo has no remote, so the
    // local block never shifts position between repos.
    expect(rows.map(summarize).slice(3, 5)).toEqual([
      "section:worktree(0)+",
      "empty:worktree",
    ])
  })

  it("emits nothing at all for a surface that passes null", () => {
    // The git-log branch filter reuses this row model and has no worktree
    // section; `[]` would give it the header + empty row above, which its own
    // renderer would mislabel as a second "Local branches".
    const rows = buildBranchRows(
      baseInput({
        worktreeNodes: null,
        localNodes: localTree(LOCAL),
        localCount: 4,
      })
    )
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:local(4)+",
      "group:feature/auth/@1+",
      "leaf:feature/auth/login@2",
      "leaf:feature/auth/logout@2",
      "leaf:main@1",
      "leaf:release/1.0@1",
      "section:remote(0)+",
      "empty:remote",
    ])
  })

  it("stays absent while searching on a null surface", () => {
    const rows = buildBranchRows(
      worktreeInput({ worktreeNodes: null, query: "task" })
    )
    expect(rows.map(summarize)).toEqual([
      "section:local(1)+",
      "leaf:task/132@1",
    ])
  })

  it("collapses independently of the local section", () => {
    const rows = buildBranchRows(
      worktreeInput({ collapsed: new Set([sectionKey("worktree")]) })
    )
    const summaries = rows.map(summarize)
    expect(summaries).toContain("section:worktree(2)-")
    // Its own leaves are gone, but the local tree still lists both branches.
    expect(summaries.slice(0, 5)).toEqual([
      "op:pull",
      "op:push",
      "sep",
      "section:worktree(2)-",
      "section:local(6)+",
    ])
    expect(summaries.filter((s) => s === "leaf:task/132@1")).toHaveLength(1)
  })

  it("keys its leaves apart from the local tree's, one branch two rows", () => {
    const rows = buildBranchRows(worktreeInput())
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("flags its leaves as worktree checkouts, so the bubble offers the removals", () => {
    const rows = buildBranchRows(worktreeInput())
    const leaf = rows.find(
      (row) => row.kind === "leaf" && row.fullName === "task/132"
    )
    expect(leaf).toMatchObject({ isWorktree: true, isRemote: false })
    expect(
      branchLeafActions(leaf as Extract<BranchRow, { kind: "leaf" }>)
    ).toContain("deleteWorktree")
  })

  it("ranks its own matches first while searching, above the local hit", () => {
    const rows = buildBranchRows(worktreeInput({ query: "task" }))
    expect(rows.map(summarize)).toEqual([
      "section:worktree(1)+",
      "leaf:task/132@1",
      "section:local(1)+",
      "leaf:task/132@1",
    ])
  })

  it("drops its header when the query matches only local branches", () => {
    // Search omits empty sections outright — the header only earns its row when
    // it has a hit, unlike the resting tree view.
    const rows = buildBranchRows(worktreeInput({ query: "release" }))
    expect(rows.map(summarize)).toEqual([
      "section:local(1)+",
      "leaf:release/1.0@1",
    ])
  })
})

describe("buildBranchRows — leaf flags (drive the action bubble)", () => {
  it("emits no leaf-action rows — actions live in the right-side bubble now", () => {
    const rows = buildBranchRows(
      baseInput({ localNodes: localTree(LOCAL), localCount: 4, branch: "main" })
    )
    expect(rows.map(summarize)).toContain("leaf:main@1*")
    const validKinds = new Set([
      "operation",
      "separator",
      "section",
      "group",
      "leaf",
      "empty",
    ])
    expect(rows.every((r) => validKinds.has(r.kind))).toBe(true)
  })

  it("marks the remote leaf that tracks the current local branch (bubble hides its delete)", () => {
    const remoteSections = buildRemoteBranchSections([
      "origin/main",
      "origin/dev",
    ])
    const rows = buildBranchRows(
      baseInput({ remoteSections, remoteCount: 2, branch: "main" })
    )
    const tracking = rows.find(
      (r) => r.kind === "leaf" && r.fullName === "origin/main"
    )
    const other = rows.find(
      (r) => r.kind === "leaf" && r.fullName === "origin/dev"
    )
    expect(tracking).toMatchObject({ isTracking: true })
    expect(other).toMatchObject({ isTracking: false })
  })
})

describe("buildBranchRows — operation grouping separators", () => {
  it("inserts a separator after each groupEnd op (non-search)", () => {
    const ops: BranchOperationMeta[] = [
      { id: "pull", label: "Pull code" },
      { id: "fetch", label: "Fetch", groupEnd: true },
      { id: "commit", label: "Commit" },
    ]
    const rows = buildBranchRows(
      baseInput({
        operations: ops,
        localNodes: localTree(["main"]),
        localCount: 1,
      })
    )
    // pull, fetch, SEP(groupEnd), commit, SEP(ops↔branches), then branches.
    expect(rows.slice(0, 5).map(summarize)).toEqual([
      "op:pull",
      "op:fetch",
      "sep",
      "op:commit",
      "sep",
    ])
  })

  it("omits group separators while searching", () => {
    const ops: BranchOperationMeta[] = [
      { id: "pull", label: "Pull code" },
      { id: "fetch", label: "Fetch pull", groupEnd: true },
    ]
    const rows = buildBranchRows(baseInput({ operations: ops, query: "pull" }))
    expect(rows.map(summarize)).toEqual(["op:pull", "op:fetch"])
  })
})

describe("buildBranchRows — search mode", () => {
  it("flattens matched leaves under section headers, dropping groups", () => {
    const rows = buildBranchRows(
      baseInput({
        localNodes: localTree(LOCAL),
        localCount: 4,
        query: "feature",
      })
    )
    // "feature" matches no operation label, so no ops block and no separator.
    expect(rows.map(summarize)).toEqual([
      "section:local(2)+",
      "leaf:feature/auth/login@1",
      "leaf:feature/auth/logout@1",
    ])
  })

  it("filters operations by label and omits the branch side when nothing matches", () => {
    const rows = buildBranchRows(
      baseInput({ localNodes: localTree(LOCAL), localCount: 4, query: "push" })
    )
    expect(rows.map(summarize)).toEqual(["op:push"])
  })

  it("keeps the separator when both an operation and branches match", () => {
    const rows = buildBranchRows(
      baseInput({ localNodes: localTree(LOCAL), localCount: 4, query: "e" })
    )
    // "Pull code" matches "e"; "Push..." does not. "main" has no "e". All three
    // branch hits are equal-tier substrings at the same position, so they keep a
    // stable alphabetical order.
    expect(rows.map(summarize)).toEqual([
      "op:pull",
      "sep",
      "section:local(3)+",
      "leaf:feature/auth/login@1",
      "leaf:feature/auth/logout@1",
      "leaf:release/1.0@1",
    ])
  })
})

describe("buildBranchRows — search relevance ranking", () => {
  it("orders exact > prefix > segment-boundary > substring", () => {
    const rows = buildBranchRows(
      baseInput({
        // domain: mid-string "main"; maintenance: prefix; feature/main:
        // "/"-segment boundary; main: exact.
        localNodes: localTree([
          "domain",
          "maintenance",
          "feature/main",
          "main",
        ]),
        localCount: 4,
        query: "main",
      })
    )
    expect(rows.map(summarize)).toEqual([
      "section:local(4)+",
      "leaf:main@1",
      "leaf:maintenance@1",
      "leaf:feature/main@1",
      "leaf:domain@1",
    ])
  })

  it("ranks a prefix hit above a substring hit regardless of render order", () => {
    const rows = buildBranchRows(
      baseInput({
        // Alphabetically "prerelease" (substring) sorts before "release/api"
        // (prefix); relevance ranking must flip them.
        localNodes: localTree(["prerelease", "release/api"]),
        localCount: 2,
        query: "release",
      })
    )
    expect(rows.map(summarize)).toEqual([
      "section:local(2)+",
      "leaf:release/api@1",
      "leaf:prerelease@1",
    ])
  })

  it("breaks equal-tier ties alphabetically by full ref", () => {
    const rows = buildBranchRows(
      baseInput({
        localNodes: localTree(["feature/beta", "feature/alpha"]),
        localCount: 2,
        query: "feature",
      })
    )
    expect(rows.map(summarize)).toEqual([
      "section:local(2)+",
      "leaf:feature/alpha@1",
      "leaf:feature/beta@1",
    ])
  })

  it("scores the collapsed leaf label, so an exact label hit ranks first", () => {
    const remoteSections = buildRemoteBranchSections([
      "origin/main-old",
      "origin/main",
    ])
    const rows = buildBranchRows(
      baseInput({
        operations: [],
        remoteSections,
        remoteCount: 2,
        query: "main",
      })
    )
    // Both refs contain "main", but "origin/main"'s display label is exactly
    // "main" (exact) while "main-old" is only a prefix. In search mode an empty
    // local side emits no section, so the remote section leads.
    expect(rows.map(summarize)).toEqual([
      "section:remote(2)+",
      "leaf:origin/main@1",
      "leaf:origin/main-old@1",
    ])
  })
})

describe("buildBranchRows — multiple remotes", () => {
  it("nests each remote as a wrapper group one level deeper", () => {
    const remoteSections = buildRemoteBranchSections([
      "origin/main",
      "upstream/main",
      "origin/dev",
    ])
    const rows = buildBranchRows(
      baseInput({ operations: [], remoteSections, remoteCount: 3 })
    )
    expect(rows.map(summarize)).toEqual([
      "section:worktree(0)+",
      "empty:worktree",
      "section:local(0)+",
      "empty:local",
      "section:remote(3)+",
      "group:origin@1+",
      "leaf:origin/dev@2",
      "leaf:origin/main@2",
      "group:upstream@1+",
      "leaf:upstream/main@2",
    ])
  })

  it("collapsing a remote wrapper hides just that remote's branches", () => {
    const remoteSections = buildRemoteBranchSections([
      "origin/main",
      "upstream/main",
    ])
    const originKey = remoteSections.find((s) => s.remoteName === "origin")!.key
    const rows = buildBranchRows(
      baseInput({
        operations: [],
        remoteSections,
        remoteCount: 2,
        collapsed: new Set([originKey]),
      })
    )
    expect(rows.map(summarize)).toEqual([
      "section:worktree(0)+",
      "empty:worktree",
      "section:local(0)+",
      "empty:local",
      "section:remote(2)+",
      "group:origin@1-",
      "group:upstream@1+",
      "leaf:upstream/main@2",
    ])
  })
})

describe("branchLeafActions", () => {
  const leaf = (
    over: Partial<Extract<BranchRow, { kind: "leaf" }>> & {
      isMainWorktree?: boolean
    } = {}
  ) => ({
    isRemote: false,
    isTracking: false,
    isWorktree: false,
    ...over,
  })

  it("offers plain delete for a local branch nothing has checked out", () => {
    expect(branchLeafActions(leaf())).toEqual([
      "switch",
      "merge",
      "rebase",
      "pull",
      "push",
      "delete",
    ])
  })

  // The bug this replaces: `git branch -d` refuses point blank while a worktree
  // holds the ref, so plain delete could only ever fail on these branches.
  it("replaces delete with the worktree removals for a worktree branch", () => {
    const actions = branchLeafActions(leaf({ isWorktree: true }))
    expect(actions).not.toContain("delete")
    expect(actions.slice(-2)).toEqual([
      "deleteWorktree",
      "deleteWorktreeAndBranch",
    ])
  })

  // `isWorktree` is set on a remote leaf too (its local counterpart drives the
  // folder icon), but removing a worktree is not something a remote ref can do.
  it("keeps a remote leaf on deleteRemote even when its local is a worktree", () => {
    expect(
      branchLeafActions(leaf({ isRemote: true, isWorktree: true }))
    ).toEqual(["switch", "merge", "rebase", "pull", "deleteRemote"])
  })

  // Seen from a linked worktree, the repo's own checkout looks like just
  // another worktree — but git refuses to remove it AND refuses to delete its
  // branch, so offering either would be the same dead end in a new costume.
  it("offers nothing destructive for the main working tree's branch", () => {
    expect(
      branchLeafActions(leaf({ isWorktree: true, isMainWorktree: true }))
    ).toEqual(["switch", "merge", "rebase", "pull", "push"])
  })

  it("drops the destructive tail for the tracked remote branch", () => {
    expect(
      branchLeafActions(leaf({ isRemote: true, isTracking: true }))
    ).toEqual(["switch", "merge", "rebase", "pull"])
  })
})

describe("isNavigableRow", () => {
  it("skips separators and empty rows, keeps everything else", () => {
    expect(isNavigableRow({ kind: "separator", key: "s" })).toBe(false)
    expect(isNavigableRow({ kind: "empty", key: "e", scope: "local" })).toBe(
      false
    )
    expect(
      isNavigableRow({
        kind: "operation",
        key: "o",
        opId: "pull",
        label: "Pull",
        destructive: false,
      })
    ).toBe(true)
  })
})

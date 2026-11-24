import { describe, expect, it } from "vitest"
import {
  buildBranchTree,
  buildRemoteBranchSections,
  collectGroupKeys,
  containsBranch,
  expandedKeysForBranch,
  localBranchItems,
  sectionKey,
  worktreeBranchNodes,
  type BranchTreeItem,
  type BranchTreeNode,
} from "@/lib/branch-tree"

// Compact, readable shape for deep-equality assertions.
type Summary =
  | { g: string; count: number; children: Summary[] }
  | { l: string; full: string }

function summarize(node: BranchTreeNode): Summary {
  if (node.type === "leaf") return { l: node.label, full: node.fullName }
  return {
    g: node.label,
    count: node.count,
    children: node.children.map(summarize),
  }
}

function tree(names: string[], scope = "local"): Summary[] {
  return buildBranchTree(localBranchItems(names), scope).map(summarize)
}

function items(pairs: [full: string, display: string][]): BranchTreeItem[] {
  return pairs.map(([full, display]) => ({ full, display }))
}

describe("buildBranchTree", () => {
  it("returns an empty tree for no branches", () => {
    expect(tree([])).toEqual([])
  })

  it("renders a slashless branch as a single leaf, no groups", () => {
    expect(tree(["main"])).toEqual([{ l: "main", full: "main" }])
  })

  it("renders flat branches as sorted leaves", () => {
    expect(tree(["main", "dev"])).toEqual([
      { l: "dev", full: "dev" },
      { l: "main", full: "main" },
    ])
  })

  it("collapses a lone deep chain into ONE leaf (not a group chain)", () => {
    // The bug-prone case: single-child collapse must apply to leaf children too.
    expect(tree(["a/b/c"])).toEqual([{ l: "a/b/c", full: "a/b/c" }])
  })

  it("groups a shared prefix and keeps a lone sibling flat", () => {
    expect(tree(["feature/a", "feature/b", "release/1.0"])).toEqual([
      {
        g: "feature/",
        count: 2,
        children: [
          { l: "a", full: "feature/a" },
          { l: "b", full: "feature/b" },
        ],
      },
      { l: "release/1.0", full: "release/1.0" },
    ])
  })

  it("nests groups and collapses single-child leaf siblings", () => {
    expect(tree(["feat/auth/login", "feat/auth/logout", "feat/pay"])).toEqual([
      {
        g: "feat/",
        count: 3,
        children: [
          {
            g: "auth/",
            count: 2,
            children: [
              { l: "login", full: "feat/auth/login" },
              { l: "logout", full: "feat/auth/logout" },
            ],
          },
          { l: "pay", full: "feat/pay" },
        ],
      },
    ])
  })

  it("sorts groups before leaves, each by localeCompare", () => {
    expect(tree(["main", "feat/b", "feat/a", "dev"])).toEqual([
      {
        g: "feat/",
        count: 2,
        children: [
          { l: "a", full: "feat/a" },
          { l: "b", full: "feat/b" },
        ],
      },
      { l: "dev", full: "dev" },
      { l: "main", full: "main" },
    ])
  })

  it("counts leaf descendants recursively on an asymmetric tree", () => {
    const nodes = buildBranchTree(
      localBranchItems(["x/a", "x/b/c", "x/b/d", "x/b/e"]),
      "local"
    )
    expect(nodes).toHaveLength(1)
    const top = nodes[0]
    expect(top.type).toBe("group")
    if (top.type !== "group") return
    expect(top.label).toBe("x/")
    expect(top.count).toBe(4)
    const bGroup = top.children.find(
      (n): n is Extract<BranchTreeNode, { type: "group" }> => n.type === "group"
    )
    expect(bGroup?.label).toBe("b/")
    expect(bGroup?.count).toBe(3)
  })

  it("keeps leaf labels relative to the nearest surviving ancestor", () => {
    const nodes = buildBranchTree(
      localBranchItems(["feat/auth/login", "feat/auth/logout"]),
      "local"
    )
    // feat + auth collapse into one group; the leaf is "login", not "auth/login".
    const group = nodes[0]
    expect(group.type).toBe("group")
    if (group.type !== "group") return
    expect(group.label).toBe("feat/auth/")
    expect(
      group.children.map((c) => (c.type === "leaf" ? c.label : ""))
    ).toEqual(["login", "logout"])
  })

  it("filters stray empty segments without emitting blank groups", () => {
    expect(tree(["feat//x"])).toEqual([{ l: "feat/x", full: "feat//x" }])
    expect(tree(["x/"])).toEqual([{ l: "x", full: "x/" }])
  })

  it("handles unicode labels and groups without throwing", () => {
    expect(tree(["café/a", "café/b"])).toEqual([
      {
        g: "café/",
        count: 2,
        children: [
          { l: "a", full: "café/a" },
          { l: "b", full: "café/b" },
        ],
      },
    ])
  })

  it("keeps fullName verbatim even when display was stripped", () => {
    const nodes = buildBranchTree(
      items([
        ["origin/feature/x", "feature/x"],
        ["origin/feature/y", "feature/y"],
      ]),
      "remote"
    )
    expect(summarize(nodes[0])).toEqual({
      g: "feature/",
      count: 2,
      children: [
        { l: "x", full: "origin/feature/x" },
        { l: "y", full: "origin/feature/y" },
      ],
    })
  })
})

describe("buildRemoteBranchSections", () => {
  it("strips the prefix and shows no wrapper for a single remote", () => {
    const sections = buildRemoteBranchSections([
      "origin/main",
      "origin/feature/x",
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0].remoteName).toBeNull()
    expect(sections[0].nodes.map(summarize)).toEqual([
      { l: "feature/x", full: "origin/feature/x" },
      { l: "main", full: "origin/main" },
    ])
  })

  it("groups a shared prefix under a single remote", () => {
    const sections = buildRemoteBranchSections([
      "origin/feat/a",
      "origin/feat/b",
    ])
    expect(sections[0].remoteName).toBeNull()
    expect(sections[0].nodes.map(summarize)).toEqual([
      {
        g: "feat/",
        count: 2,
        children: [
          { l: "a", full: "origin/feat/a" },
          { l: "b", full: "origin/feat/b" },
        ],
      },
    ])
  })

  it("keeps a wrapper per remote and avoids cross-remote key collisions", () => {
    const sections = buildRemoteBranchSections(["origin/main", "upstream/main"])
    expect(sections.map((s) => s.remoteName)).toEqual(["origin", "upstream"])
    const originLeaf = sections[0].nodes[0]
    const upstreamLeaf = sections[1].nodes[0]
    expect(originLeaf.type).toBe("leaf")
    expect(upstreamLeaf.type).toBe("leaf")
    if (originLeaf.type !== "leaf" || upstreamLeaf.type !== "leaf") return
    expect(originLeaf.fullName).toBe("origin/main")
    expect(upstreamLeaf.fullName).toBe("upstream/main")
    // Same short name, different scoped keys → no collision.
    expect(originLeaf.key).not.toBe(upstreamLeaf.key)
  })
})

describe("expandedKeysForBranch", () => {
  it("returns every ancestor group key of a nested branch", () => {
    const nodes = buildBranchTree(
      localBranchItems(["feat/auth/login", "feat/auth/logout", "feat/pay"]),
      "local"
    )
    expect(expandedKeysForBranch(nodes, "feat/auth/login")).toEqual([
      "g local feat",
      "g local feat/auth",
    ])
  })

  it("returns [] for a top-level leaf", () => {
    const nodes = buildBranchTree(
      localBranchItems(["feature/a", "feature/b", "release/1.0"]),
      "local"
    )
    expect(expandedKeysForBranch(nodes, "release/1.0")).toEqual([])
  })

  it("isolates scope across remotes", () => {
    const sections = buildRemoteBranchSections([
      "origin/feat/a",
      "origin/feat/b",
      "upstream/feat/c",
      "upstream/feat/d",
    ])
    const [origin, upstream] = sections
    // The branch lives only in the upstream tree.
    expect(expandedKeysForBranch(origin.nodes, "upstream/feat/c")).toEqual([])
    expect(expandedKeysForBranch(upstream.nodes, "upstream/feat/c")).toEqual([
      "g remote:upstream feat",
    ])
  })

  it("returns [] for an absent branch", () => {
    const nodes = buildBranchTree(localBranchItems(["main", "dev"]), "local")
    expect(expandedKeysForBranch(nodes, "nope")).toEqual([])
  })
})

describe("containsBranch", () => {
  it("distinguishes a present top-level leaf from an absent branch", () => {
    const nodes = buildBranchTree(
      localBranchItems(["feature/a", "feature/b", "release/1.0"]),
      "local"
    )
    // expandedKeysForBranch returns [] for both, so containsBranch is needed.
    expect(containsBranch(nodes, "release/1.0")).toBe(true)
    expect(containsBranch(nodes, "nope")).toBe(false)
  })

  it("finds a deeply nested leaf", () => {
    const nodes = buildBranchTree(
      localBranchItems(["feat/auth/login", "feat/auth/logout"]),
      "local"
    )
    expect(containsBranch(nodes, "feat/auth/login")).toBe(true)
    expect(containsBranch(nodes, "feat/auth")).toBe(false)
  })
})

describe("sectionKey", () => {
  it("namespaces section keys by scope", () => {
    expect(sectionKey("local")).toBe("s local")
    expect(sectionKey("remote")).toBe("s remote")
    expect(sectionKey("remote:origin")).toBe("s remote:origin")
  })
})

describe("worktreeBranchNodes", () => {
  it("returns nothing when the repo has no other worktree", () => {
    expect(worktreeBranchNodes([], null)).toEqual([])
  })

  it("groups branches that share a prefix, exactly like the local tree", () => {
    expect(worktreeBranchNodes(["task/b", "task/a"], null)).toEqual([
      {
        type: "group",
        label: "task/",
        key: "g worktree task",
        count: 2,
        children: [
          {
            type: "leaf",
            fullName: "task/a",
            label: "a",
            key: "l worktree task/a",
          },
          {
            type: "leaf",
            fullName: "task/b",
            label: "b",
            key: "l worktree task/b",
          },
        ],
      },
    ])
  })

  it("collapses a branch that shares no prefix into one whole-ref leaf", () => {
    expect(worktreeBranchNodes(["loop/x"], null)).toEqual([
      {
        type: "leaf",
        fullName: "loop/x",
        label: "loop/x",
        key: "l worktree loop/x",
      },
    ])
  })

  it("puts the main working tree first, above the prefix groups", () => {
    // Groups sort before leaves, so `main` only stays on top because it is
    // hoisted out of the trie — that's the "back to the project root" target.
    const nodes = worktreeBranchNodes(
      ["task/b", "Loop/x", "main", "task/a"],
      "main"
    )
    expect(nodes.map((node) => node.label)).toEqual(["main", "task/", "Loop/x"])
  })

  it("hoists the main branch even when it would fall inside a group", () => {
    const nodes = worktreeBranchNodes(
      ["task/base", "task/a", "task/b"],
      "task/base"
    )
    expect(nodes[0]).toMatchObject({
      type: "leaf",
      fullName: "task/base",
      label: "task/base",
    })
    expect(nodes[1]).toMatchObject({ type: "group", label: "task/", count: 2 })
  })

  it("ignores a main branch no worktree actually holds", () => {
    expect(
      worktreeBranchNodes(["task/a", "task/b"], "main").map(
        (node) => node.label
      )
    ).toEqual(["task/"])
  })

  it("scopes keys to the worktree section, so the local tree's leaf differs", () => {
    const [worktreeLeaf] = worktreeBranchNodes(["dev"], null)
    const [localLeaf] = buildBranchTree(localBranchItems(["dev"]), "local")
    expect(worktreeLeaf.key).not.toBe(localLeaf.key)
  })

  it("leaves the caller's array untouched", () => {
    const branches = ["task/b", "task/a"]
    worktreeBranchNodes(branches, null)
    expect(branches).toEqual(["task/b", "task/a"])
  })
})

describe("collectGroupKeys", () => {
  it("collects every prefix-group key, descending nested groups in render order", () => {
    const nodes = buildBranchTree(
      localBranchItems([
        "feat/auth/login",
        "feat/auth/logout",
        "feat/pay",
        "main",
      ]),
      "local"
    )
    expect(collectGroupKeys(nodes)).toEqual([
      "g local feat",
      "g local feat/auth",
    ])
  })

  it("returns [] when there are no surviving prefix groups", () => {
    // Distinct top-level branches + a single collapsed chain — all leaves.
    const nodes = buildBranchTree(
      localBranchItems(["main", "dev", "a/b/c"]),
      "local"
    )
    expect(collectGroupKeys(nodes)).toEqual([])
  })

  it("collects tree-internal groups but not the multi-remote wrapper key", () => {
    const [origin] = buildRemoteBranchSections([
      "origin/feat/a",
      "origin/feat/b",
      "upstream/main",
    ])
    // Only the in-tree "feat/" group — the wrapper (section.key) lives outside.
    expect(collectGroupKeys(origin.nodes)).toEqual(["g remote:origin feat"])
    expect(collectGroupKeys(origin.nodes)).not.toContain(origin.key)
  })
})

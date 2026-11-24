/**
 * Hierarchical, prefix-compressed grouping of git branch names, shared by all
 * three branch selectors (top-bar dropdown, below-input picker, git-log
 * sidebar filter).
 *
 * Branch names are slash-delimited (`feature/auth/login`). We build a trie over
 * the `/` segments and **collapse any internal node with exactly one child**
 * (regardless of whether that child is a group or a leaf), so a group level
 * exists only where two or more branches share a prefix and then diverge:
 *
 *   [feature/a, feature/b, release/1.0]  → group "feature/" {a, b}, leaf "release/1.0"
 *   [a/b/c]                              → single leaf "a/b/c" (no groups)
 *
 * Note this differs from the file-tree compression in `aux-panel-git-log-tab`,
 * which only collapses single-child *directories* — a leaf-only chain like
 * `a/b/c` must collapse to one leaf here, not a three-level group chain.
 *
 * Git forbids a ref being both a prefix and a leaf (`feat` and `feat/x` can't
 * coexist), so the trie is clean: internal nodes are pure prefixes, leaves are
 * whole branches.
 */

export interface BranchTreeLeaf {
  type: "leaf"
  /** Original git ref, untouched — used for ALL git ops and identity checks. */
  fullName: string
  /** Remainder relative to the nearest surviving ancestor group, for display. */
  label: string
  /** Scope-prefixed stable id (React key / cmdk value). */
  key: string
}

export interface BranchTreeGroup {
  type: "group"
  /** Compressed prefix, always ends with "/", e.g. "feat/auth/". */
  label: string
  /** Scope-prefixed cumulative prefix — the one identity used for expansion. */
  key: string
  children: BranchTreeNode[]
  /** Recursive leaf-descendant count, for the "(n)" suffix. */
  count: number
}

export type BranchTreeNode = BranchTreeGroup | BranchTreeLeaf

export interface BranchTreeItem {
  /** Original git ref (kept verbatim on the leaf for git ops). */
  full: string
  /** What gets split on "/" and rendered (e.g. remote prefix already stripped). */
  display: string
}

/**
 * A remote section ready to render. With a single remote the prefix is stripped
 * and no wrapper level is shown (`remoteName: null`); with multiple remotes each
 * remote becomes a top-level wrapper group (`remoteName` set).
 */
export interface RemoteBranchSection {
  /** Remote name to show as a wrapper group, or null for the single-remote case. */
  remoteName: string | null
  /** Reserved expansion key for the wrapper ("" when `remoteName` is null). */
  key: string
  /** Number of branches under this remote, for the wrapper's "(n)". */
  count: number
  nodes: BranchTreeNode[]
}

// Keys join with a space; git refs can never contain spaces, and the scope
// strings below never do either, so the join is unambiguous. A space sigil is
// also deliberately plain ASCII (no control-character sigil that could turn the
// source file binary).
const SEP = " "
const leafKey = (scope: string, full: string) => `l${SEP}${scope}${SEP}${full}`
const groupKey = (scope: string, prefix: string) =>
  `g${SEP}${scope}${SEP}${prefix}`

/** Reserved expansion key for a whole section (e.g. Local / Remote / a remote). */
export function sectionKey(scope: string): string {
  return `s${SEP}${scope}`
}

interface TrieNode {
  children: Map<string, TrieNode>
  /** The original full ref when a branch ends exactly here, else null. */
  full: string | null
}

function splitSegments(display: string): string[] {
  return display.split("/").filter(Boolean)
}

function insert(root: TrieNode, item: BranchTreeItem): void {
  const segments = splitSegments(item.display)
  if (segments.length === 0) return
  let current = root
  segments.forEach((segment, index) => {
    const isLeaf = index === segments.length - 1
    let node = current.children.get(segment)
    if (!node) {
      node = { children: new Map(), full: null }
      current.children.set(segment, node)
    }
    if (isLeaf) node.full = item.full
    current = node
  })
}

function isLeafNode(node: TrieNode): boolean {
  return node.full !== null && node.children.size === 0
}

function countLeaves(node: TrieNode): number {
  let total = 0
  for (const child of node.children.values()) {
    total += isLeafNode(child) ? 1 : countLeaves(child)
  }
  return total
}

function sortNodes(nodes: BranchTreeNode[]): BranchTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "group" ? -1 : 1
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  })
}

/**
 * Convert the child reached via `segment` into a tree node, collapsing any
 * single-child chain (of either kind) into a combined label. `parentPath` is
 * the cumulative display path of the nearest surviving ancestor group.
 */
function collapseChild(
  segment: string,
  child: TrieNode,
  scope: string,
  parentPath: string
): BranchTreeNode {
  const labelSegments = [segment]
  let current = child
  // Walk down while this is a pure single-child intermediate node.
  while (current.full === null && current.children.size === 1) {
    const [nextSegment, nextNode] = current.children.entries().next().value as [
      string,
      TrieNode,
    ]
    labelSegments.push(nextSegment)
    current = nextNode
  }
  const label = labelSegments.join("/")
  const fullPath = parentPath ? `${parentPath}/${label}` : label

  if (isLeafNode(current)) {
    return {
      type: "leaf",
      fullName: current.full as string,
      label,
      key: leafKey(scope, current.full as string),
    }
  }
  return {
    type: "group",
    label: `${label}/`,
    key: groupKey(scope, fullPath),
    children: toNodes(current, scope, fullPath),
    count: countLeaves(current),
  }
}

function toNodes(
  node: TrieNode,
  scope: string,
  parentPath: string
): BranchTreeNode[] {
  const result: BranchTreeNode[] = []
  for (const [segment, child] of node.children) {
    result.push(collapseChild(segment, child, scope, parentPath))
  }
  return sortNodes(result)
}

/**
 * Build a prefix-compressed tree from `items`. `scope` namespaces the emitted
 * keys so identical prefixes in different sections/remotes never collide.
 */
export function buildBranchTree(
  items: BranchTreeItem[],
  scope: string
): BranchTreeNode[] {
  const root: TrieNode = { children: new Map(), full: null }
  for (const item of items) insert(root, item)
  return toNodes(root, scope, "")
}

/** Whether any leaf in `nodes` has the given `fullName`. */
export function containsBranch(
  nodes: BranchTreeNode[],
  fullName: string
): boolean {
  for (const node of nodes) {
    if (node.type === "leaf") {
      if (node.fullName === fullName) return true
    } else if (containsBranch(node.children, fullName)) {
      return true
    }
  }
  return false
}

/**
 * The expansion keys of every group ancestor of the leaf whose `fullName`
 * matches — used to auto-expand the path to the current branch. `[]` both when
 * the branch is a top-level leaf and when it's absent (use `containsBranch` to
 * tell those apart).
 */
export function expandedKeysForBranch(
  nodes: BranchTreeNode[],
  fullName: string
): string[] {
  const path: string[] = []
  const walk = (current: BranchTreeNode[]): boolean => {
    for (const node of current) {
      if (node.type === "leaf") {
        if (node.fullName === fullName) return true
        continue
      }
      path.push(node.key)
      if (walk(node.children)) return true
      path.pop()
    }
    return false
  }
  walk(nodes)
  return [...path]
}

/**
 * The expansion keys of every prefix group in `nodes`, in render order. Used to
 * seed the branch selector's default-collapsed set so prefix groups start
 * folded while their section stays open. Sections and the multi-remote wrapper
 * are keyed outside the tree, so they're never included here.
 */
export function collectGroupKeys(nodes: BranchTreeNode[]): string[] {
  const keys: string[] = []
  const walk = (current: BranchTreeNode[]) => {
    for (const node of current) {
      if (node.type === "group") {
        keys.push(node.key)
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return keys
}

/**
 * Bucket remote branches by remote name and build a tree per remote. Mirrors the
 * existing UX: a single remote strips its prefix with no wrapper level; multiple
 * remotes keep the remote name as the top-level group. Leaves always keep the
 * full `origin/...` ref as `fullName`.
 */
export function buildRemoteBranchSections(
  remote: string[]
): RemoteBranchSection[] {
  const groups = new Map<string, string[]>()
  for (const branch of remote) {
    const slash = branch.indexOf("/")
    const name = slash > 0 ? branch.slice(0, slash) : "origin"
    const bucket = groups.get(name)
    if (bucket) bucket.push(branch)
    else groups.set(name, [branch])
  }

  const names = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  )
  const multiple = names.length > 1

  return names.map((name) => {
    const branches = groups.get(name) as string[]
    const scope = multiple ? `remote:${name}` : "remote"
    const items = branches.map((full) => ({
      full,
      display: full.replace(/^[^/]+\//, ""),
    }))
    return {
      remoteName: multiple ? name : null,
      key: multiple ? sectionKey(scope) : "",
      count: branches.length,
      nodes: buildBranchTree(items, scope),
    }
  })
}

/** Convenience: build `{full, display}` items for local branches (no stripping). */
export function localBranchItems(local: string[]): BranchTreeItem[] {
  return local.map((full) => ({ full, display: full }))
}

/**
 * Nodes for the branch selector's worktree section: the repo's main working
 * tree first — the usual "back to the project root" target — then the linked
 * worktrees as a prefix tree. `branches` is `GitBranchList.worktree_branches`,
 * i.e. the branches checked out somewhere OTHER than the folder being viewed.
 *
 * Prefix-grouped exactly like the local/remote trees, down to the groups
 * defaulting to collapsed: a repo with several `task/*` worktrees reads as a
 * hierarchy instead of a flat wall, and the section carries no expansion rule
 * of its own to remember.
 *
 * The main working tree's branch is hoisted OUT of the trie and kept as the
 * first top-level leaf, labelled with its full ref. Left in, `sortNodes` would
 * float every prefix group above it (groups sort before leaves) or bury it
 * inside one, and the "back to the project root" target would move around per
 * repo. Keys are scoped to "worktree", so a branch that also appears in the
 * local tree keeps a distinct identity in both places.
 */
export function worktreeBranchNodes(
  branches: string[],
  mainBranch: string | null
): BranchTreeNode[] {
  const linked = branches.filter((full) => full !== mainBranch)
  const nodes = buildBranchTree(
    linked.map((full) => ({ full, display: full })),
    "worktree"
  )
  if (mainBranch == null || !branches.includes(mainBranch)) return nodes
  return [
    {
      type: "leaf",
      fullName: mainBranch,
      label: mainBranch,
      key: leafKey("worktree", mainBranch),
    },
    ...nodes,
  ]
}

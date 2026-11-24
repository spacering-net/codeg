/**
 * Flat, virtualization-ready row model for the branch selector popup.
 *
 * The rich branch selector (`BranchDropdown`) renders operations (pull / fetch /
 * commit / push / new branch / worktree) AND the full local+remote branch tree
 * as ONE searchable, virtualized, flat list — mirroring
 * the model picker's `flattenModelGroups` + `ModelOptionList` split. This module
 * is the pure half: it flattens the prefix-grouped {@link BranchTreeNode} trees
 * (from `@/lib/branch-tree`) plus the operation metadata into a linear
 * `BranchRow[]` the renderer maps 1:1 to virtua rows.
 *
 * Deliberately pure — no React, no callbacks, no icons, no i18n. The renderer
 * resolves icons/handlers by `kind`/`opId` and builds every translated string
 * (section headers by `scope`+`count`), so all display concerns stay out of
 * here and the flattening logic is unit-testable in isolation.
 */

import { sectionKey } from "@/lib/branch-tree"
import type {
  BranchTreeLeaf,
  BranchTreeNode,
  RemoteBranchSection,
} from "@/lib/branch-tree"

/** Container-supplied operation, resolved to icon + handler by the renderer. */
export interface BranchOperationMeta {
  id: string
  /** Already-translated label — the ONLY string search matches operations on. */
  label: string
  destructive?: boolean
  /** Emit a separator after this op (non-search) to visually group operations. */
  groupEnd?: boolean
}

export type BranchLeafAction =
  | "switch"
  | "merge"
  | "rebase"
  /** Update the branch in place, without checking it out. */
  | "pull"
  /** Publish the branch, without checking it out. Local branches only. */
  | "push"
  | "delete"
  | "deleteRemote"
  /**
   * Remove the worktree holding this branch, keeping the branch (and its
   * workspace folder, for a worktree you mean to recreate). Worktree branches
   * only — they are the ones `delete` can never touch.
   */
  | "deleteWorktree"
  /** Remove the worktree, the branch, and the worktree's workspace folder. */
  | "deleteWorktreeAndBranch"

/**
 * Which block a section header opens. "worktree" is the shortcut list of
 * branches checked out in the repo's other worktrees — a flat subset shown
 * above Local, which still lists every local branch including those.
 */
export type BranchSectionScope = "local" | "remote" | "worktree"

export type BranchRow =
  | {
      kind: "operation"
      key: string
      opId: string
      label: string
      destructive: boolean
    }
  | { kind: "separator"; key: string }
  | {
      kind: "section"
      key: string
      scope: BranchSectionScope
      count: number
      expanded: boolean
    }
  | {
      kind: "group"
      key: string
      depth: number
      label: string
      count: number
      expanded: boolean
    }
  | {
      kind: "leaf"
      key: string
      depth: number
      fullName: string
      label: string
      isRemote: boolean
      isCurrent: boolean
      isTracking: boolean
      isWorktree: boolean
    }
  | { kind: "empty"; key: string; scope: BranchSectionScope }

export interface BuildBranchRowsInput {
  operations: BranchOperationMeta[]
  /**
   * Branches checked out in the repo's OTHER worktrees, already ordered and
   * prefix-grouped (see `worktreeBranchNodes`). Rendered as a shortcut section
   * above Local, which keeps listing every local branch including these — the
   * section is a shortcut, not a partition.
   *
   * Empty vs absent are DIFFERENT, and every caller has to say which it means:
   * `[]` is "this surface has the section, the repo just has no other worktree"
   * → the "(0)" header + empty row, exactly as the remote section behaves with
   * no remote, so the local block never shifts position between repos. `null` is
   * "this surface has no worktree section at all" → nothing is emitted. The
   * git-log branch filter reuses this row model and is a `null` caller; folding
   * the two cases together silently grew a phantom section there.
   */
  worktreeNodes: BranchTreeNode[] | null
  localNodes: BranchTreeNode[]
  remoteSections: RemoteBranchSection[]
  /** Total local branch count (for the section header's "(n)"). */
  localCount: number
  /** Total remote branch count (for the section header's "(n)"). */
  remoteCount: number
  /** Current branch ref (marks the current leaf, suppresses its actions). */
  branch: string | null
  /** Branch names checked out in a worktree — leaf gets the worktree icon. */
  worktreeBranchSet: Set<string>
  /** Group/section keys the user has collapsed (default-expanded = absent). */
  collapsed: Set<string>
  /** Search query; when non-empty the tree flattens to matched leaves. */
  query: string
}

const worktreeSectionKey = sectionKey("worktree")
const localSectionKey = sectionKey("local")
const remoteSectionKey = sectionKey("remote")

interface LeafContext {
  branch: string | null
  worktreeBranchSet: Set<string>
  collapsed: Set<string>
}

/** Strip a remote leaf's `<remote>/` prefix (local leaves are returned as-is). */
function localName(fullName: string, isRemote: boolean): string {
  return isRemote ? fullName.replace(/^[^/]+\//, "") : fullName
}

/**
 * Emit a single leaf row. Per-branch actions (switch/merge/rebase/delete) are
 * NOT rows — the renderer shows them in a right-side bubble when a leaf is
 * clicked (`isTracking` there hides delete for the tracked remote branch).
 */
function emitLeaf(
  out: BranchRow[],
  leaf: BranchTreeLeaf,
  depth: number,
  isRemote: boolean,
  ctx: LeafContext
): void {
  const b = leaf.fullName
  const isCurrent = b === ctx.branch
  const isTracking =
    isRemote && !!ctx.branch && localName(b, true) === ctx.branch
  const isWorktree = ctx.worktreeBranchSet.has(localName(b, isRemote))

  out.push({
    kind: "leaf",
    key: leaf.key,
    depth,
    fullName: b,
    label: leaf.label,
    isRemote,
    isCurrent,
    isTracking,
    isWorktree,
  })
}

/** Recursively flatten a prefix tree, descending only expanded groups. */
function emitTree(
  out: BranchRow[],
  nodes: BranchTreeNode[],
  depth: number,
  isRemote: boolean,
  ctx: LeafContext
): void {
  for (const node of nodes) {
    if (node.type === "leaf") {
      emitLeaf(out, node, depth, isRemote, ctx)
      continue
    }
    const expanded = !ctx.collapsed.has(node.key)
    out.push({
      kind: "group",
      key: node.key,
      depth,
      label: node.label,
      count: node.count,
      expanded,
    })
    if (expanded) emitTree(out, node.children, depth + 1, isRemote, ctx)
  }
}

/** All leaf descendants of `nodes`, in render order. */
function collectLeaves(nodes: BranchTreeNode[]): BranchTreeLeaf[] {
  const leaves: BranchTreeLeaf[] = []
  const walk = (list: BranchTreeNode[]) => {
    for (const node of list) {
      if (node.type === "leaf") leaves.push(node)
      else walk(node.children)
    }
  }
  walk(nodes)
  return leaves
}

// How strongly a text matches the query, higher = stronger. This is the "match
// degree" the search results sort by: an exact hit outranks a prefix hit, a
// prefix outranks a match that begins right after a "/" segment boundary, and
// those all outrank a plain mid-string substring hit.
const MATCH_NONE = 0
const MATCH_SUBSTRING = 1
const MATCH_SEGMENT = 2
const MATCH_PREFIX = 3
const MATCH_EXACT = 4

interface MatchRank {
  /** One of the MATCH_* tiers; MATCH_NONE means the query isn't present. */
  tier: number
  /** Index of the first hit in the text (earlier = better); -1 when absent. */
  index: number
}

/** Rank a single already-lowercased query `q` against `text`. */
function scoreText(text: string, q: string): MatchRank {
  const lower = text.toLowerCase()
  const index = lower.indexOf(q)
  if (index === -1) return { tier: MATCH_NONE, index }
  let tier: number
  if (lower === q) tier = MATCH_EXACT
  else if (index === 0) tier = MATCH_PREFIX
  else if (lower[index - 1] === "/") tier = MATCH_SEGMENT
  else tier = MATCH_SUBSTRING
  return { tier, index }
}

/**
 * Best rank of a leaf, scoring both its full ref AND its (possibly collapsed)
 * display label and keeping the stronger — so searching "login" treats a leaf
 * whose visible label is exactly "login" as an exact hit even though its full
 * ref is "feature/auth/login".
 */
function rankLeaf(leaf: BranchTreeLeaf, q: string): MatchRank {
  const full = scoreText(leaf.fullName, q)
  const label = scoreText(leaf.label, q)
  if (full.tier !== label.tier) return full.tier > label.tier ? full : label
  // Same tier: prefer the earlier hit position.
  return full.index <= label.index ? full : label
}

/**
 * Keep the leaves matching `q`, ordered by relevance: exact hits first, then
 * prefix, then segment-boundary, then substring; within a tier, an earlier
 * match position wins, then the ref name breaks ties for a stable order.
 */
function matchAndRankLeaves(
  leaves: BranchTreeLeaf[],
  q: string
): BranchTreeLeaf[] {
  return leaves
    .map((leaf) => ({ leaf, rank: rankLeaf(leaf, q) }))
    .filter((entry) => entry.rank.tier > MATCH_NONE)
    .sort((a, b) => {
      if (a.rank.tier !== b.rank.tier) return b.rank.tier - a.rank.tier
      if (a.rank.index !== b.rank.index) return a.rank.index - b.rank.index
      return a.leaf.fullName.localeCompare(b.leaf.fullName, undefined, {
        sensitivity: "base",
      })
    })
    .map((entry) => entry.leaf)
}

/**
 * Flatten operations + branch trees into a single linear row list.
 *
 * - Empty query: operations block → separator → Worktree section (its own
 *   prefix tree; absent entirely when `worktreeNodes` is null) → Local section
 *   (its prefix tree, descending only expanded groups) → Remote section
 *   (single-remote strips the wrapper; multi-remote nests each remote as a
 *   group). Every section present defaults open.
 * - Non-empty query: operations whose label matches → separator → matched
 *   worktree, then local, then remote leaves, flat under their section headers
 *   and ranked by relevance (exact > prefix > "/"-segment boundary > substring,
 *   ties broken by earlier match position then name); groups dropped, collapse
 *   state ignored, empty sections omitted.
 *
 * Indentation depth: operations flat; a section header is depth 0; its children
 * are depth 1 (and deeper per nesting).
 */
export function buildBranchRows(input: BuildBranchRowsInput): BranchRow[] {
  const {
    operations,
    worktreeNodes,
    localNodes,
    remoteSections,
    localCount,
    remoteCount,
    branch,
    worktreeBranchSet,
    collapsed,
    query,
  } = input

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const ctx: LeafContext = {
    branch,
    worktreeBranchSet,
    collapsed,
  }

  const rows: BranchRow[] = []

  // --- Operations ------------------------------------------------------------
  // Grouped by a separator after each `groupEnd` op (non-search only) to mirror
  // the old menu's pull/fetch | commit/push | … blocks.
  for (const op of operations) {
    if (searching && !op.label.toLowerCase().includes(q)) continue
    rows.push({
      kind: "operation",
      key: `op:${op.id}`,
      opId: op.id,
      label: op.label,
      destructive: op.destructive ?? false,
    })
    if (!searching && op.groupEnd) {
      rows.push({ kind: "separator", key: `sep:op:${op.id}` })
    }
  }
  const hasOperations = rows.some((row) => row.kind === "operation")

  // --- Branches --------------------------------------------------------------
  const branchRows: BranchRow[] = []

  if (searching) {
    const worktreeMatches = worktreeNodes
      ? matchAndRankLeaves(collectLeaves(worktreeNodes), q)
      : []
    if (worktreeMatches.length > 0) {
      branchRows.push({
        kind: "section",
        key: worktreeSectionKey,
        scope: "worktree",
        count: worktreeMatches.length,
        expanded: true,
      })
      for (const leaf of worktreeMatches) {
        emitLeaf(branchRows, leaf, 1, false, ctx)
      }
    }

    const localMatches = matchAndRankLeaves(collectLeaves(localNodes), q)
    if (localMatches.length > 0) {
      branchRows.push({
        kind: "section",
        key: localSectionKey,
        scope: "local",
        count: localMatches.length,
        expanded: true,
      })
      for (const leaf of localMatches) emitLeaf(branchRows, leaf, 1, false, ctx)
    }

    // Rank every remote's leaves together so a strong hit under the second
    // remote still outranks a weak hit under the first (the per-remote wrapper
    // groups are already dropped in search mode, so the list is flat anyway).
    const remoteMatches = matchAndRankLeaves(
      remoteSections.flatMap((section) => collectLeaves(section.nodes)),
      q
    )
    if (remoteMatches.length > 0) {
      branchRows.push({
        kind: "section",
        key: remoteSectionKey,
        scope: "remote",
        count: remoteMatches.length,
        expanded: true,
      })
      for (const leaf of remoteMatches) emitLeaf(branchRows, leaf, 1, true, ctx)
    }
  } else {
    // Worktree section — only on the surfaces that asked for one (`null` skips
    // it outright; `[]` still gets the header + empty row).
    if (worktreeNodes) {
      const worktreeExpanded = !collapsed.has(worktreeSectionKey)
      branchRows.push({
        kind: "section",
        key: worktreeSectionKey,
        scope: "worktree",
        // Leaf count, not node count: a prefix group stands for its branches.
        count: collectLeaves(worktreeNodes).length,
        expanded: worktreeExpanded,
      })
      if (worktreeExpanded) {
        if (worktreeNodes.length === 0) {
          branchRows.push({
            kind: "empty",
            key: "empty:worktree",
            scope: "worktree",
          })
        } else {
          emitTree(branchRows, worktreeNodes, 1, false, ctx)
        }
      }
    }

    // Local section
    const localExpanded = !collapsed.has(localSectionKey)
    branchRows.push({
      kind: "section",
      key: localSectionKey,
      scope: "local",
      count: localCount,
      expanded: localExpanded,
    })
    if (localExpanded) {
      if (localNodes.length === 0) {
        branchRows.push({ kind: "empty", key: "empty:local", scope: "local" })
      } else {
        emitTree(branchRows, localNodes, 1, false, ctx)
      }
    }

    // Remote section
    const remoteExpanded = !collapsed.has(remoteSectionKey)
    branchRows.push({
      kind: "section",
      key: remoteSectionKey,
      scope: "remote",
      count: remoteCount,
      expanded: remoteExpanded,
    })
    if (remoteExpanded) {
      if (remoteCount === 0) {
        branchRows.push({ kind: "empty", key: "empty:remote", scope: "remote" })
      } else {
        for (const section of remoteSections) {
          if (section.remoteName == null) {
            emitTree(branchRows, section.nodes, 1, true, ctx)
            continue
          }
          // Multiple remotes: each remote is a wrapper group toggled by its
          // own section key, its branches nested one level deeper.
          const wrapperExpanded = !collapsed.has(section.key)
          branchRows.push({
            kind: "group",
            key: section.key,
            depth: 1,
            label: section.remoteName,
            count: section.count,
            expanded: wrapperExpanded,
          })
          if (wrapperExpanded) {
            emitTree(branchRows, section.nodes, 2, true, ctx)
          }
        }
      }
    }
  }

  if (hasOperations && branchRows.length > 0) {
    rows.push({ kind: "separator", key: "sep:ops-branches" })
  }
  rows.push(...branchRows)

  return rows
}

/** Row kinds the keyboard cursor can land on (skips separators + empty rows). */
export function isNavigableRow(row: BranchRow): boolean {
  return row.kind !== "separator" && row.kind !== "empty"
}

/**
 * The per-branch actions offered for a leaf, in three groups: what this branch
 * does to the CURRENT one (switch/merge/rebase), what it syncs with its remote
 * (pull/push — both in place, no checkout), and the destructive tail. "push" is
 * local-only: publishing `origin/x` is meaningless.
 *
 * The destructive tail depends on where the branch lives:
 * - remote → "deleteRemote", except for the remote branch the current local
 *   branch tracks (deleting that is nonsensical), which gets nothing;
 * - local, checked out in another worktree → the two worktree removals, and NOT
 *   "delete": git refuses to delete a branch a worktree holds, so plain delete
 *   there is an error message with extra steps;
 * - local, checked out in the repo's own main working tree → nothing, since
 *   neither of those escapes applies to it (see `isMainWorktree`);
 * - plain local → "delete".
 */
export function branchLeafActions({
  isRemote,
  isTracking,
  isWorktree,
  isMainWorktree = false,
}: Pick<
  Extract<BranchRow, { kind: "leaf" }>,
  "isRemote" | "isTracking" | "isWorktree"
> & {
  /**
   * This branch is the one the repo's *main* working tree has checked out (only
   * ever true when viewing from a linked worktree). Its checkout is the repo
   * itself, so neither removal applies and plain delete would still be refused —
   * it gets no destructive action at all.
   */
  isMainWorktree?: boolean
}): BranchLeafAction[] {
  const actions: BranchLeafAction[] = ["switch", "merge", "rebase", "pull"]
  if (!isRemote) actions.push("push")
  if (isTracking) return actions
  if (isRemote) actions.push("deleteRemote")
  else if (isMainWorktree) return actions
  else if (isWorktree) actions.push("deleteWorktree", "deleteWorktreeAndBranch")
  else actions.push("delete")
  return actions
}

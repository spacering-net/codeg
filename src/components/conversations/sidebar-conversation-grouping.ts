import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
  SidebarLayoutEntry,
} from "@/lib/types"
import {
  DEFAULT_SECTION_ORDER,
  normalizeSectionOrder,
  type SidebarRecentFilter,
  type SidebarSortMode,
  type SidebarSectionKey,
  type SidebarSectionOrder,
} from "@/lib/sidebar-view-mode-storage"

// How many conversations the "Recent" section shows before its "show more" row,
// and how many each click adds. Recent deliberately re-lists what the Folders /
// Chat sections already show, so an unbounded one pushes every section below it
// off the screen — a page keeps it a glance-able "where was I" list. Lives here
// (not in the list component) because `buildRows` needs it to tell an untouched
// first page from an expanded one.
export const RECENT_PAGE_SIZE = 15

export function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function compareByUpdatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const updatedDiff =
    parseTimestamp(right.updated_at) - parseTimestamp(left.updated_at)
  if (updatedDiff !== 0) return updatedDiff

  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff

  return right.id - left.id
}

export function compareByCreatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff

  const updatedDiff =
    parseTimestamp(right.updated_at) - parseTimestamp(left.updated_at)
  if (updatedDiff !== 0) return updatedDiff

  return right.id - left.id
}

/**
 * Newest-created first, id as a stable tie-break — matching the backend
 * `list_children` ORDER BY created_at DESC, id DESC so a merged/inserted child
 * lands where a refetch would put it. Sub-sessions render newest-on-top like the
 * root list, so a freshly-spawned sub-agent surfaces right under its parent.
 * Deliberately created_at + id only (no `updated_at` middle key like
 * {@link compareByCreatedAtDesc}) to mirror the SQL order the raw fetch snapshot
 * is trusted to already be in. Parity holds at millisecond + id resolution:
 * `parseTimestamp` (Date.parse) truncates to ms, so two children created in the
 * same millisecond fall to the id tie-break here while the backend orders them
 * by full-precision `created_at` — harmless because ids increase with creation
 * time, so both still agree on newest-first.
 */
export function compareByChildCreatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff
  return right.id - left.id
}

/**
 * Most-recently-pinned first. Only ever applied to rows with a non-null
 * `pinned_at` (the pinned bucket), so the empty-string fallback is just a guard.
 */
export function compareByPinnedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const diff =
    parseTimestamp(right.pinned_at ?? "") - parseTimestamp(left.pinned_at ?? "")
  if (diff !== 0) return diff
  return right.id - left.id
}

/**
 * Relative time label (e.g. "5m", "3h", "2d"). `now` is passed in rather than
 * read from `Date.now()` so a whole render tick shares one value: every
 * unchanged row then produces an identical label string and the card `memo`
 * stays hit. The list refreshes `now` once a minute (see
 * `SidebarConversationList`), bounding label staleness without making a single
 * status event re-render every card.
 */
export function formatRelative(iso: string, now: number): string {
  const ts = parseTimestamp(iso)
  if (!ts) return ""
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}

function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Return `prev` when `next` has identical string membership, else `next`.
 *
 * `tabs` is rebuilt (new array) on every `conversations` change (tab-context
 * re-derives titles/status), so `openTabKeys` recomputes every status event.
 * Without this reuse the freshly-built Set would be a new reference each time
 * and would defeat the `FolderGroupItem` memo for *every* folder. Content
 * equality keeps the reference stable when the open-tab set is actually
 * unchanged.
 */
export function reuseSet(prev: Set<string>, next: Set<string>): Set<string> {
  if (prev === next) return prev
  if (prev.size !== next.size) return next
  for (const key of next) {
    if (!prev.has(key)) return next
  }
  return prev
}

export interface SelectedConversationRef {
  id: number
  agentType: string
}

/**
 * Return `prev` when it denotes the same conversation as `next`, else `next`.
 * Same motivation as {@link reuseSet}: keeps `selectedConversation` reference
 * stable across the `tabs` churn so unaffected folders stay memoized.
 */
export function reuseSelected(
  prev: SelectedConversationRef | null,
  next: SelectedConversationRef | null
): SelectedConversationRef | null {
  if (
    prev &&
    next &&
    prev.id === next.id &&
    prev.agentType === next.agentType
  ) {
    return prev
  }
  return next
}

/**
 * Group conversations by folder, sorting each bucket, while reusing the
 * previous render's bucket array whenever a folder's sorted membership is
 * referentially unchanged.
 *
 * Reference stability is the whole point: a single `conversation_status_changed`
 * event replaces exactly one summary object (slice + spread in
 * `updateConversationLocal`), so only the touched folder's bucket fails the
 * shallow-equality check and gets a fresh array. Every sibling folder keeps its
 * old array reference, letting a memoized `FolderGroupItem` bail out — and
 * inside the one folder that did change, every unchanged summary keeps its
 * object identity so the card `memo` still bails out for all but the one
 * affected row.
 *
 * `prev` is the map returned by the last call (the caller threads it via a ref).
 *
 * `childToParent` (optional) merges worktree child folders into their parent: a
 * conversation whose `folder_id` is a key is bucketed under the mapped parent
 * id instead, so the parent group renders the main repo's and all its worktrees'
 * conversations together (sorted as one bucket). The conversation objects
 * themselves are untouched — only the grouping key is redirected, never
 * `folder_id` — so per-conversation cwd resolution stays correct.
 */
export function groupByFolderWithReuse(
  filtered: readonly DbConversationSummary[],
  sortMode: SidebarSortMode,
  prev: Map<number, DbConversationSummary[]>,
  childToParent?: ReadonlyMap<number, number>
): Map<number, DbConversationSummary[]> {
  const next = new Map<number, DbConversationSummary[]>()
  for (const conv of filtered) {
    const groupId = childToParent?.get(conv.folder_id) ?? conv.folder_id
    const list = next.get(groupId)
    if (list) list.push(conv)
    else next.set(groupId, [conv])
  }

  const comparator =
    sortMode === "updated" ? compareByUpdatedAtDesc : compareByCreatedAtDesc
  for (const [folderId, list] of next) {
    list.sort(comparator)
    const prevList = prev.get(folderId)
    // Replacing an existing key's value mid-iteration is safe (we never add or
    // remove keys here).
    if (prevList && arraysShallowEqual(prevList, list)) {
      next.set(folderId, prevList)
    }
  }
  return next
}

/**
 * Select the pinned conversations (those with a non-null `pinned_at`), sorted
 * most-recently-pinned first, reusing the previous array reference when the
 * sorted membership is referentially unchanged.
 *
 * Same reference-stability motivation as {@link groupByFolderWithReuse}: a
 * single status event replaces exactly one summary object, so this would
 * otherwise build a fresh array each tick and defeat the Pinned section's memo.
 * Built from the FULL `conversations` list (never the completed-filtered one): a
 * pinned conversation stays in the Pinned section even when "Show completed" is
 * off — pinning is an explicit "keep this handy" override of that filter.
 *
 * `prev` is the array returned by the last call (the caller threads it via a
 * ref).
 */
export function selectPinnedWithReuse(
  conversations: readonly DbConversationSummary[],
  prev: DbConversationSummary[]
): DbConversationSummary[] {
  const next: DbConversationSummary[] = []
  for (const conv of conversations) {
    if (conv.pinned_at != null) next.push(conv)
  }
  next.sort(compareByPinnedAtDesc)
  return arraysShallowEqual(prev, next) ? prev : next
}

/**
 * Select the folderless "chat mode" conversations (`kind === "chat"`) for the
 * flat "Chat" sidebar section. Sorted most-recently-updated first, with
 * reference reuse (same motivation as {@link selectPinnedWithReuse}).
 *
 * Excludes pinned conversations (they surface in the Pinned section, an explicit
 * override) and — unless `showCompleted` — completed ones, matching how
 * `folderConversations` is filtered for the folders section.
 *
 * `prev` is the array returned last call (threaded via a ref by the caller).
 */
export function selectChatConversationsWithReuse(
  conversations: readonly DbConversationSummary[],
  showCompleted: boolean,
  prev: DbConversationSummary[]
): DbConversationSummary[] {
  const next: DbConversationSummary[] = []
  for (const conv of conversations) {
    if (conv.pinned_at != null) continue
    if (conv.kind !== "chat") continue
    if (!showCompleted && conv.status === "completed") continue
    next.push(conv)
  }
  next.sort(compareByUpdatedAtDesc)
  return arraysShallowEqual(prev, next) ? prev : next
}

/**
 * Select the flat "Recent" bucket: every conversation the sidebar can reach,
 * folder-bound and chat alike, newest first — the whole point of the section is
 * that it does NOT distinguish the two. Reference reuse as in
 * {@link selectPinnedWithReuse}.
 *
 * Deliberate inclusions / exclusions:
 * - Pinned conversations are excluded. They already have a dedicated top
 *   section, and a Recent copy would be a second row for the same conversation
 *   two sections apart.
 * - Completed ones follow `showCompleted`, like every other section.
 * - A folder conversation is included only when its folder is OPEN
 *   (`openFolderIds`). `list_all_conversations` returns rows for every
 *   non-deleted folder — open or not — and the Folders section silently drops
 *   the closed ones by only rendering `orderedFolderIds`; Recent must apply the
 *   same reachability rule or closing a folder would leave its sessions on
 *   screen (with no folder entry to theme or resolve them). Chat conversations
 *   live in a hidden folder that is never in the open set, so they are admitted
 *   by `kind` instead.
 * - Sorted by `sortMode` (not always `updated_at`) so the row order agrees with
 *   the timestamp each card actually shows.
 * - `filter` optionally narrows the mix to chats only or folder sessions only;
 *   the default (`"all"`) is the section's whole point.
 *
 * `prev` is the array returned last call (threaded via a ref by the caller).
 */
export function selectRecentConversationsWithReuse(
  conversations: readonly DbConversationSummary[],
  showCompleted: boolean,
  sortMode: SidebarSortMode,
  openFolderIds: ReadonlySet<number>,
  prev: DbConversationSummary[],
  filter: SidebarRecentFilter = "all"
): DbConversationSummary[] {
  const next: DbConversationSummary[] = []
  for (const conv of conversations) {
    if (conv.pinned_at != null) continue
    if (!showCompleted && conv.status === "completed") continue
    const isChat = conv.kind === "chat"
    if (!isChat && !openFolderIds.has(conv.folder_id)) continue
    // The user's "just chats" / "just folder sessions" narrowing. Same split
    // the Chat and Folders sections use, so the two views always agree.
    if (filter === "chats" && !isChat) continue
    if (filter === "folders" && isChat) continue
    next.push(conv)
  }
  next.sort(
    sortMode === "updated" ? compareByUpdatedAtDesc : compareByCreatedAtDesc
  )
  return arraysShallowEqual(prev, next) ? prev : next
}

// ── Folder display ordering (worktree nesting) ──────────────────────────────

/** The folder fields needed to nest worktree children under their repo root. */
export type FolderOrderInput = Pick<
  FolderDetail,
  "id" | "parent_id" | "sort_order" | "name"
>

/**
 * Group each top-level repo's OPEN worktree child folders under it, returning a
 * `repoId → [worktreeChildId, ...]` map that only contains repos with at least
 * one worktree child. A folder is a worktree child of `p` when its `parent_id`
 * is `p` and `p` is a top-level entry in `topLevelFolderIds`; children are
 * ordered `sort_order`, then `name`, then `id` for a stable, input-order-
 * independent sequence.
 *
 * Drives the "Show worktrees" container tree: a repo present as a key renders as
 * a container (its own sessions move into an indented "root" sub-group, and each
 * worktree becomes an indented sub-group after it). An orphan worktree whose
 * parent is closed/removed is not a top-level entry's child, so it appears in no
 * value list and stands alone as an ordinary top-level folder. Pure — no side
 * effects, never mutates inputs.
 */
export function worktreeChildrenByParent(
  topLevelFolderIds: readonly number[],
  folders: readonly FolderOrderInput[]
): Map<number, number[]> {
  const topLevel = new Set(topLevelFolderIds)
  const childrenByParent = new Map<number, FolderOrderInput[]>()
  for (const f of folders) {
    if (f.parent_id == null) continue
    if (!topLevel.has(f.parent_id)) continue
    const list = childrenByParent.get(f.parent_id)
    if (list) list.push(f)
    else childrenByParent.set(f.parent_id, [f])
  }

  const out = new Map<number, number[]>()
  for (const [parentId, list] of childrenByParent) {
    // Stable order within a repo: sort_order, then name, then id as a final
    // tie-break so the sequence is deterministic regardless of input order.
    list.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      const byName = a.name.localeCompare(b.name)
      return byName !== 0 ? byName : a.id - b.id
    })
    out.set(
      parentId,
      list.map((f) => f.id)
    )
  }
  return out
}

/**
 * The alias half of a worktree sub-group header, in preference order: the user
 * alias, then the branch. `null` when it has neither.
 *
 * The header pairs it with the directory name through the same
 * `FolderAliasLabel` a repo header uses, so a worktree reads
 * `task/49 [ codeg-task-49 ]` — the branch is what identifies the worktree, and
 * the directory is what identifies it on disk. With neither, `FolderAliasLabel`
 * falls back to the bare directory name on its own.
 *
 * The alias leads because worktree folders get theirs seeded with the branch
 * they were created on (`open_worktree_folder_core`), which makes it the one
 * value actually present for every worktree: the folder row's own `git_branch`
 * column is never written by the folder flow (it stays NULL), so relying on it
 * alone left every worktree labeled by its directory name
 * (`codeg-automation-3-run-8`) instead. The seeded branch lives in the alias
 * rather than in `git_branch` on purpose — it is a label fixed at creation, not
 * a live readout, and `git_branch` seeds the store's branch map, where a stale
 * value would misreport what is checked out now. A user who renames the folder
 * still wins over both, since the alias is exactly where that rename lands.
 */
export function worktreeHeaderAlias(
  alias: string | null | undefined,
  branch: string | null | undefined
): string | null {
  return alias?.trim() || branch?.trim() || null
}

// ── Folder groups: the mixed top-level layout ───────────────────────────────
// The "Folders" section's top level holds two kinds of entry — folder GROUPS and
// ungrouped folders — interleaved in one user-controlled order. Both carry their
// position in `sort_order`, and (this is the whole trick) the two tables share
// one numeric space at the top level, so a single ascending sort over both
// produces the mixed sequence. Inside a group, its member folders have their own
// 1..n sequence.
//
// Everything below is pure and reference-free so it can be unit-tested without
// the store, and so the drag gesture can compute a *candidate* layout without
// touching the backend.

/** One entry in the sidebar's top-level sequence. */
export interface SidebarEntry {
  kind: "folder" | "group"
  id: number
}

/**
 * The resolved shape of the "Folders" section: the mixed top-level sequence
 * plus, for each group, its ordered member folder ids.
 *
 * Deliberately ids-only — it is a *shape*, not a data snapshot, so it stays
 * stable across the status events that constantly replace conversation objects.
 */
export interface SidebarLayout {
  top: readonly SidebarEntry[]
  /** groupId → ordered member folder ids. A group with no members still has an
   *  entry (an empty array) so an empty group stays visible and droppable. */
  membersByGroup: ReadonlyMap<number, readonly number[]>
}

/** No groups: every folder is top level. Shared so the group-free path (and
 *  every pre-groups test) allocates nothing. */
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = {
  top: [],
  membersByGroup: new Map(),
}

/** Ascending `sort_order`, ties broken on id, so the sequence is stable even
 *  when two rows share a position (possible right after a partial write). */
function compareBySortOrder(
  left: { sort_order: number; id: number },
  right: { sort_order: number; id: number }
): number {
  const diff = left.sort_order - right.sort_order
  return diff !== 0 ? diff : left.id - right.id
}

/**
 * Resolve the mixed top-level order and each group's members from the raw
 * folder + group lists.
 *
 * `folders` must already be the REORDERABLE set — open, non-chat, and with
 * worktree children excluded (they follow their repo and never take a slot of
 * their own). `orderedFolderIds` from the caller is the fallback order used for
 * ungrouped folders during a drag; see `layoutFromOrderedIds`.
 *
 * Two defenses, both load-bearing:
 * - A folder whose `group_id` names a group that isn't in `groups` (deleted in
 *   another window between the two snapshots) falls back to the TOP LEVEL. The
 *   alternative — dropping it — would make a folder vanish from the sidebar
 *   because of a race, which is much worse than it appearing in the wrong slot
 *   for one frame.
 * - Every group gets a `membersByGroup` entry even when empty, because a freshly
 *   created group has no members and must still render (it is the thing you drag
 *   folders into).
 */
export function buildSidebarLayout(args: {
  folders: readonly FolderDetail[]
  groups: readonly FolderGroupDetail[]
}): SidebarLayout {
  const { folders, groups } = args
  if (groups.length === 0) {
    return {
      top: [...folders]
        .sort(compareBySortOrder)
        .map((f) => ({ kind: "folder" as const, id: f.id })),
      membersByGroup: new Map(),
    }
  }

  const groupIds = new Set(groups.map((g) => g.id))
  const membersByGroup = new Map<number, number[]>()
  for (const g of groups) membersByGroup.set(g.id, [])

  const topFolders: FolderDetail[] = []
  const membersByGroupRaw = new Map<number, FolderDetail[]>()
  for (const folder of folders) {
    const groupId = folder.group_id
    if (groupId == null || !groupIds.has(groupId)) {
      topFolders.push(folder)
      continue
    }
    const bucket = membersByGroupRaw.get(groupId)
    if (bucket) bucket.push(folder)
    else membersByGroupRaw.set(groupId, [folder])
  }

  for (const [groupId, bucket] of membersByGroupRaw) {
    membersByGroup.set(
      groupId,
      bucket.sort(compareBySortOrder).map((f) => f.id)
    )
  }

  // The mixed sort: groups and ungrouped folders in ONE ascending pass over the
  // shared top-level `sort_order` space. Ties break group-before-folder (then by
  // id) purely so the result is deterministic.
  const top: SidebarEntry[] = [
    ...groups.map((g) => ({
      kind: "group" as const,
      id: g.id,
      sort_order: g.sort_order,
    })),
    ...topFolders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      sort_order: f.sort_order,
    })),
  ]
    .sort((a, b) => {
      const diff = a.sort_order - b.sort_order
      if (diff !== 0) return diff
      if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1
      return a.id - b.id
    })
    .map(({ kind, id }) => ({ kind, id }))

  return { top, membersByGroup }
}

/**
 * The group-free layout for a pre-resolved folder id order — the shape
 * `buildRows` falls back to when no groups exist, and the seed the row model
 * uses so its output is byte-identical to the pre-groups model.
 */
export function layoutFromOrderedIds(
  orderedFolderIds: readonly number[]
): SidebarLayout {
  return {
    top: orderedFolderIds.map((id) => ({ kind: "folder" as const, id })),
    membersByGroup: new Map(),
  }
}

/** Flatten a layout into the top-level folder/group sequence with each group's
 *  members inlined right after their group — the order the sidebar renders, and
 *  the order the backend's per-container counter expects. */
export function layoutToEntries(layout: SidebarLayout): SidebarLayoutEntry[] {
  const entries: SidebarLayoutEntry[] = []
  for (const entry of layout.top) {
    if (entry.kind === "folder") {
      entries.push({ kind: "folder", id: entry.id, groupId: null })
      continue
    }
    entries.push({ kind: "group", id: entry.id, groupId: null })
    for (const memberId of layout.membersByGroup.get(entry.id) ?? []) {
      entries.push({ kind: "folder", id: memberId, groupId: entry.id })
    }
  }
  return entries
}

/** Every folder id the layout places, top level and group members alike. */
export function layoutFolderIds(layout: SidebarLayout): number[] {
  const ids: number[] = []
  for (const entry of layout.top) {
    if (entry.kind === "folder") {
      ids.push(entry.id)
      continue
    }
    ids.push(...(layout.membersByGroup.get(entry.id) ?? []))
  }
  return ids
}

/**
 * Move one entry to `(targetGroupId, targetIndex)`, returning a NEW layout.
 * The folder-group analogue of {@link applyReorder}.
 *
 * - Moving a GROUP only ever reorders the top level; `targetGroupId` is ignored
 *   (groups never nest) and its members travel with it untouched.
 * - Moving a FOLDER removes it from wherever it currently is — top level or some
 *   group — and inserts it into the target container at `targetIndex`. That one
 *   operation covers all four gestures: reorder at top level, reorder within a
 *   group, drag INTO a group, and drag OUT of one.
 *
 * `targetIndex` is clamped into the destination's range AFTER removal, so
 * "drop past the end" appends rather than being rejected. An unknown entry
 * returns the input layout unchanged.
 */
export function applyLayoutMove(
  layout: SidebarLayout,
  moved: SidebarEntry,
  targetGroupId: number | null,
  targetIndex: number
): SidebarLayout {
  if (moved.kind === "group") {
    const from = layout.top.findIndex(
      (e) => e.kind === "group" && e.id === moved.id
    )
    if (from < 0) return layout
    const top = applyReorder(layout.top, from, targetIndex)
    return { top, membersByGroup: layout.membersByGroup }
  }

  // Locate the folder: top level, or inside exactly one group.
  const topIndex = layout.top.findIndex(
    (e) => e.kind === "folder" && e.id === moved.id
  )
  let sourceGroupId: number | null = null
  if (topIndex < 0) {
    for (const [groupId, members] of layout.membersByGroup) {
      if (members.includes(moved.id)) {
        sourceGroupId = groupId
        break
      }
    }
    if (sourceGroupId === null) return layout
  }

  // Dropping into a group that isn't in this layout would strand the folder, so
  // treat an unknown target as the top level.
  const destination =
    targetGroupId !== null && layout.membersByGroup.has(targetGroupId)
      ? targetGroupId
      : null

  if (sourceGroupId === destination) {
    // Same container: a plain reorder, so the other container is untouched.
    if (destination === null) {
      return {
        top: applyReorder(layout.top, topIndex, targetIndex),
        membersByGroup: layout.membersByGroup,
      }
    }
    const members = layout.membersByGroup.get(destination) ?? []
    const from = members.indexOf(moved.id)
    const membersByGroup = new Map(layout.membersByGroup)
    membersByGroup.set(destination, applyReorder(members, from, targetIndex))
    return { top: layout.top, membersByGroup }
  }

  // Cross-container: remove from the source, then insert into the destination.
  let top = layout.top
  const membersByGroup = new Map(layout.membersByGroup)
  if (sourceGroupId === null) {
    top = layout.top.filter((_, i) => i !== topIndex)
  } else {
    membersByGroup.set(
      sourceGroupId,
      (membersByGroup.get(sourceGroupId) ?? []).filter((id) => id !== moved.id)
    )
  }

  if (destination === null) {
    const next = [...top]
    next.splice(clampIndex(targetIndex, next.length), 0, {
      kind: "folder",
      id: moved.id,
    })
    return { top: next, membersByGroup }
  }

  const members = [...(membersByGroup.get(destination) ?? [])]
  members.splice(clampIndex(targetIndex, members.length), 0, moved.id)
  membersByGroup.set(destination, members)
  return { top, membersByGroup }
}

/** Clamp an insertion index into `[0, length]` (length = append at the end). */
function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, index))
}

/** Where an entry currently sits, or null if the layout doesn't hold it. */
export function locateEntry(
  layout: SidebarLayout,
  entry: SidebarEntry
): { groupId: number | null; index: number } | null {
  if (entry.kind === "group") {
    const index = layout.top.findIndex(
      (e) => e.kind === "group" && e.id === entry.id
    )
    return index < 0 ? null : { groupId: null, index }
  }
  const topIndex = layout.top.findIndex(
    (e) => e.kind === "folder" && e.id === entry.id
  )
  if (topIndex >= 0) return { groupId: null, index: topIndex }
  for (const [groupId, members] of layout.membersByGroup) {
    const index = members.indexOf(entry.id)
    if (index >= 0) return { groupId, index }
  }
  return null
}

/**
 * Reconcile an optimistic (mid-drag) layout against the authoritative one.
 *
 * The drag holds its own layout so siblings shift live under the pointer, but
 * the workspace keeps moving underneath: an automation can mint a worktree, a
 * task can remove one, another window can delete a group. Without this the drag
 * snapshot would either resurrect a folder that is gone or hide one that just
 * arrived, and then PERSIST that view on drop.
 *
 * Rule: `candidate` decides the ORDER, `authoritative` decides the MEMBERSHIP.
 * Anything the authoritative layout no longer has is dropped; anything it has
 * that the candidate doesn't is appended (folders to the top level, groups to
 * the end) so it stays reachable and un-clobbered.
 */
export function reconcileLayout(
  candidate: SidebarLayout,
  authoritative: SidebarLayout
): SidebarLayout {
  const liveGroups = new Set<number>()
  for (const entry of authoritative.top) {
    if (entry.kind === "group") liveGroups.add(entry.id)
  }
  const liveFolders = new Set(layoutFolderIds(authoritative))

  const seenGroups = new Set<number>()
  const seenFolders = new Set<number>()
  const top: SidebarEntry[] = []
  const membersByGroup = new Map<number, number[]>()

  for (const entry of candidate.top) {
    if (entry.kind === "group") {
      if (!liveGroups.has(entry.id) || seenGroups.has(entry.id)) continue
      seenGroups.add(entry.id)
      top.push(entry)
      const members: number[] = []
      for (const memberId of candidate.membersByGroup.get(entry.id) ?? []) {
        if (!liveFolders.has(memberId) || seenFolders.has(memberId)) continue
        seenFolders.add(memberId)
        members.push(memberId)
      }
      membersByGroup.set(entry.id, members)
      continue
    }
    if (!liveFolders.has(entry.id) || seenFolders.has(entry.id)) continue
    seenFolders.add(entry.id)
    top.push(entry)
  }

  // Anything new since the drag began, in the authoritative order.
  for (const entry of authoritative.top) {
    if (entry.kind === "group") {
      if (seenGroups.has(entry.id)) continue
      seenGroups.add(entry.id)
      top.push(entry)
      membersByGroup.set(entry.id, [])
    } else if (!seenFolders.has(entry.id)) {
      seenFolders.add(entry.id)
      top.push(entry)
    }
  }
  for (const [groupId, members] of authoritative.membersByGroup) {
    const bucket = membersByGroup.get(groupId)
    if (!bucket) continue
    for (const memberId of members) {
      if (seenFolders.has(memberId)) continue
      seenFolders.add(memberId)
      bucket.push(memberId)
    }
  }

  return { top, membersByGroup }
}

/**
 * One row of the drag surface: what it renders, and where a drop on it lands
 * the dragged entry.
 *
 * The drag surface collapses the whole Folders section to fixed-height rows so
 * `pointerYToTargetIndex` is a plain `floor(y / rowHeight)` — the drop target
 * therefore has to be baked into the row rather than re-derived from the live
 * (variable-height, virtualized) list.
 */
export interface DragSlot {
  render:
    | { kind: "folder"; id: number; depth: number }
    | { kind: "group"; id: number }
    /** The trailing "move out of the group" drop zone. */
    | { kind: "ungroup" }
  target: { groupId: number | null; index: number }
}

/**
 * Build the drag surface for one gesture. Two shapes, because the two things
 * you can drag have different destination spaces:
 *
 * - Dragging a GROUP: one row per top-level entry, groups collapsed to their
 *   heading. Groups never nest, so every drop is a top-level reposition and the
 *   members travel along without ever being drop targets themselves.
 * - Dragging a FOLDER: top-level entries, with every group EXPANDED to show its
 *   members — even a group that is collapsed in the real list, since otherwise a
 *   collapsed group's interior would be unreachable. A drop on a group's own
 *   heading means "into this group, at the top", which is also the only way into
 *   an empty group.
 *
 * A folder dragged out of a group gets a trailing drop zone, because a workspace
 * where every folder lives in some group would otherwise have no top-level row
 * to aim at. It is omitted for a folder already at the top level, where it would
 * duplicate a row that already exists (and where its "remove from group" label
 * would be a lie).
 */
export function buildDragSlots(
  layout: SidebarLayout,
  dragged: SidebarEntry
): DragSlot[] {
  const slots: DragSlot[] = []
  if (dragged.kind === "group") {
    layout.top.forEach((entry, index) => {
      slots.push({
        render:
          entry.kind === "group"
            ? { kind: "group", id: entry.id }
            : { kind: "folder", id: entry.id, depth: 0 },
        target: { groupId: null, index },
      })
    })
    return slots
  }

  layout.top.forEach((entry, index) => {
    if (entry.kind === "folder") {
      slots.push({
        render: { kind: "folder", id: entry.id, depth: 0 },
        target: { groupId: null, index },
      })
      return
    }
    slots.push({
      render: { kind: "group", id: entry.id },
      target: { groupId: entry.id, index: 0 },
    })
    const members = layout.membersByGroup.get(entry.id) ?? []
    members.forEach((memberId, memberIndex) => {
      slots.push({
        render: { kind: "folder", id: memberId, depth: 1 },
        target: { groupId: entry.id, index: memberIndex },
      })
    })
  })

  if (locateEntry(layout, dragged)?.groupId != null) {
    slots.push({
      render: { kind: "ungroup" },
      target: { groupId: null, index: layout.top.length },
    })
  }
  return slots
}

// ── Flat row model (Phase 2 virtualization) ─────────────────────────────────
// The sidebar tree (folders → their conversation rows) is flattened into a
// single linear array so it can be windowed by `virtua`. Each visible folder
// contributes one header row, and — when expanded — either one empty-hint row
// or its sorted conversation rows.

export interface FolderHeaderRow {
  kind: "folder"
  folderId: number
}

/**
 * The "root" sub-group header shown (only under "Show worktrees") directly below
 * a repo CONTAINER header: it groups the repo's OWN (non-worktree) conversations
 * under an indented, FolderRoot-glyph "root folder" heading, parallel to each
 * worktree sub-group. Distinct from {@link FolderHeaderRow} so it can share the
 * container's numeric `folderId` (the repo id, used for its bucket / count /
 * theme) without colliding with the container's own folder header row, and so
 * the sticky-header machinery — keyed on `kind === "folder"` — deliberately
 * skips it (single-level sticky: the container stands in for its root sessions).
 */
export interface RootGroupHeaderRow {
  kind: "root-group"
  folderId: number
}

export interface ConversationRow {
  kind: "conversation"
  /**
   * The summary object reference is passed through untouched (never copied), so
   * a status event that replaces exactly one summary keeps every other row's
   * `conversation` identity — the linchpin that lets the card `memo` bail out
   * through the virtualized render. See {@link groupByFolderWithReuse}.
   */
  conversation: DbConversationSummary
  /**
   * Nesting depth in the delegation tree: 0 for a root / pinned / chat
   * conversation, 1 for its direct delegation children, 2 for grandchildren,
   * etc. Drives the card's per-level indent (a pure function of this number).
   */
  depth: number
  /**
   * Set (only) on rows emitted by the "Recent" section. Recent deliberately
   * re-lists conversations that also appear under their folder or in Chat, so
   * the SAME conversation can occupy two rows of the one flat array; this flag
   * is what keeps their React keys distinct and lets
   * {@link flatIndexOfConversation} prefer the canonical (in-section) row.
   * Absent — never `false` — so existing row-shape assertions are unaffected.
   */
  recent?: true
}

export interface EmptyHintRow {
  kind: "empty"
  folderId: number
  /**
   * Total (unfiltered, pinned-excluded) conversation count for this folder, used
   * by the renderer to pick between the "empty folder" and "no unfinished
   * conversations" hints.
   */
  totalConversationCount: number
}

/**
 * The single empty-state hint shown under an expanded but empty "Chat" section
 * ("No chats yet"). Unlike {@link EmptyHintRow} it is folderless — chat
 * conversations are a flat list — so it carries no folder id and renders with a
 * flat (non-rail) indent.
 */
export interface ChatsEmptyRow {
  kind: "chats-empty"
}

/**
 * The single empty-state hint shown under an expanded but empty "Folders"
 * section ("No folders open"). Like {@link ChatsEmptyRow} it is folderless — it
 * stands in for the whole (empty) folder list rather than one folder — so it
 * carries no folder id and renders with a flat (non-rail) indent. Distinct from
 * {@link EmptyHintRow}, which is the per-folder "this folder is empty" hint.
 */
export interface FoldersEmptyRow {
  kind: "folders-empty"
}

/**
 * The single empty-state hint shown under an expanded but empty "Recent"
 * section ("No recent conversations"). Folderless like {@link ChatsEmptyRow}.
 * Under the default "all" filter it is reached only when nothing passes
 * Recent's own gates (see {@link selectRecentConversationsWithReuse}) — Recent
 * spans every section, so any other conversation fills it. A "chats" /
 * "folders" filter can also narrow the section to nothing, and the renderer
 * names that filter in the hint.
 */
export interface RecentEmptyRow {
  kind: "recent-empty"
}

/**
 * The paging footer of the "Recent" section. Recent re-lists every reachable
 * conversation, so an untruncated one buries the sections below it; the list
 * shows a page at a time and this row reveals the next one. Carries how many
 * rows are still hidden so the label can say it.
 *
 * It is also where the list gets folded back up, which is why `remaining === 0`
 * does NOT retire the row: once the section is past its first page the footer
 * survives with `canReset` alone, as a pure "back to the first page" control.
 * Retiring it there would take the only way out of a fully expanded list away
 * exactly when the list is longest.
 */
export interface RecentMoreRow {
  kind: "recent-more"
  remaining: number
  /** Set only when the section is showing more than its first page, i.e. when
   *  collapsing back to {@link RECENT_PAGE_SIZE} would actually hide rows.
   *  Written only when true so equality assertions on the un-expanded footer
   *  keep passing. */
  canReset?: true
}

/**
 * A collapsible section heading. Four exist: "pinned" (always on top, shown only
 * when there are pinned conversations) plus the three user-reorderable ones —
 * "folders" (wraps the whole folder list), "chats" (a flat list of folderless
 * chat-mode conversations), and "recent" (a flat, folder-agnostic list of the
 * newest conversations, shown only when the user keeps it enabled). All live in
 * the same flat row array so the single Virtualizer windows them like any other
 * row — there is no separate, un-virtualized list.
 */
export interface SectionHeaderRow {
  kind: "section"
  section: SidebarSectionKey
  expanded: boolean
  /** Pinned count, folder count, chat- or recent-conversation count — shown
   *  beside the title. */
  count: number
}

/**
 * A folder GROUP's heading, inside the "Folders" section. Sits at the same
 * indent as a top-level folder header and gates its member folders' rows.
 *
 * Distinct from {@link SectionHeaderRow} (a group is user-created data, not one
 * of the four fixed sections) and from {@link FolderHeaderRow} (a group owns no
 * conversations of its own). The sticky-header machinery, keyed on
 * `kind === "folder"`, deliberately skips it: sticky stays single-level, and the
 * member folder's own header is the one worth pinning while you scroll its
 * conversations.
 */
export interface FolderGroupHeaderRow {
  kind: "folder-group"
  groupId: number
  expanded: boolean
}

/**
 * The hint under an expanded but empty group ("No folders in this group"). A
 * group with no members is a normal state — it is what you get the instant you
 * create one — so it must render something rather than collapsing to a bare
 * heading with nothing under it.
 */
export interface GroupEmptyRow {
  kind: "group-empty"
  groupId: number
}

/**
 * A transient placeholder at the child indent, shown while a conversation's
 * delegation children are being lazily fetched (between expand and the
 * `listChildConversations` response). Replaced by the real child rows once
 * loaded, or by nothing if the parent turns out to have no (live) children.
 */
export interface SubsessionLoadingRow {
  kind: "subsession-loading"
  parentId: number
  depth: number
  /** Set on the placeholder under a Recent-section parent — same duplicate-key
   *  concern as {@link ConversationRow.recent}: one expanded parent listed in
   *  both its folder and Recent produces two placeholders. */
  recent?: true
}

export type SidebarRow =
  | SectionHeaderRow
  | FolderGroupHeaderRow
  | GroupEmptyRow
  | FolderHeaderRow
  | RootGroupHeaderRow
  | ConversationRow
  | EmptyHintRow
  | ChatsEmptyRow
  | FoldersEmptyRow
  | RecentEmptyRow
  | RecentMoreRow
  | SubsessionLoadingRow

const MAX_RENDER_DEPTH = 32

// Shared empty defaults so callers (and existing tests) that don't track
// sub-session expansion can omit the two params without allocating per call —
// the row output is then identical to the pre-subtree flat model.
const EMPTY_EXPANDED: ReadonlySet<number> = new Set()
const EMPTY_CHILDREN: ReadonlyMap<number, readonly DbConversationSummary[]> =
  new Map()
// No repo is a worktree container by default (Show worktrees off) — every folder
// then takes the flat path, identical to the pre-worktree row model.
const EMPTY_CONTAINER_CHILDREN: ReadonlyMap<number, readonly number[]> =
  new Map()
// No Recent rows by default (the section is opt-in at the buildRows layer), so
// the row output stays identical to the pre-Recent model for callers that don't
// pass it.
const EMPTY_CONVERSATIONS: readonly DbConversationSummary[] = []
// No group is collapsed by default (absent key = expanded), matching
// `folderExpanded`. Shared so the group-free path allocates nothing.
const EMPTY_GROUP_EXPANDED: Record<number, boolean> = {}

/**
 * Merge a freshly-fetched children snapshot with child summaries already applied
 * from live events (buffered into the lazy-load placeholder while the fetch was
 * in flight). Keyed by id with the live event winning, so a child created or
 * updated after the fetch's DB query is never lost — closing the lazy-load
 * lost-update race. Sorted created_at-descending (newest first) to match
 * `list_children`.
 */
export function mergeChildrenById(
  snapshot: readonly DbConversationSummary[],
  buffered: readonly DbConversationSummary[]
): DbConversationSummary[] {
  const byId = new Map<number, DbConversationSummary>()
  for (const c of snapshot) byId.set(c.id, c)
  for (const b of buffered) byId.set(b.id, b)
  return [...byId.values()].sort(compareByChildCreatedAtDesc)
}

/**
 * Push a conversation row and — when it is expanded and its delegation children
 * are cached — recursively push its subtree (depth+1 per level). Bounded by
 * `conversationExpanded` (a finite, user-controlled set) and by what is actually
 * in `childrenByParent` (only fetched parents descend), so it always terminates;
 * `MAX_RENDER_DEPTH` is defense-in-depth against pathological data. The
 * `parent_id` chain is a tree by construction (set once at insert, never
 * updated), so cycles cannot occur.
 *
 * Child summaries are pushed by reference (never copied), exactly like root
 * rows, so a status event replacing one child keeps every sibling's identity and
 * the card `memo` still bails out through the virtualized render.
 */
function pushConversationRow(
  rows: SidebarRow[],
  conversation: DbConversationSummary,
  depth: number,
  conversationExpanded: ReadonlySet<number>,
  childrenByParent: ReadonlyMap<number, readonly DbConversationSummary[]>,
  childrenLoading: ReadonlySet<number>,
  // Tags this row — and its whole subtree — as a Recent-section copy. See
  // {@link ConversationRow.recent}.
  recent = false
): void {
  const row: ConversationRow = { kind: "conversation", conversation, depth }
  if (recent) row.recent = true
  rows.push(row)
  if (
    depth >= MAX_RENDER_DEPTH ||
    conversation.child_count <= 0 ||
    !conversationExpanded.has(conversation.id)
  ) {
    return
  }
  const kids = childrenByParent.get(conversation.id)
  // Spinner while: not fetched yet (undefined), OR an in-flight placeholder
  // (empty array still loading — events may not have buffered any child yet).
  if (
    kids === undefined ||
    (kids.length === 0 && childrenLoading.has(conversation.id))
  ) {
    const loadingRow: SubsessionLoadingRow = {
      kind: "subsession-loading",
      parentId: conversation.id,
      depth: depth + 1,
    }
    if (recent) loadingRow.recent = true
    rows.push(loadingRow)
    return
  }
  // Loaded (possibly merged with mid-flight events). An empty array that is NOT
  // loading means a stale child_count → the `for` renders nothing, self-healing.
  for (const kid of kids) {
    pushConversationRow(
      rows,
      kid,
      depth + 1,
      conversationExpanded,
      childrenByParent,
      childrenLoading,
      recent
    )
  }
}

/**
 * Flatten the (optional) pinned section and the folders section into a single
 * linear row list for windowing by the one Virtualizer — pinned conversations
 * are ordinary conversation rows in the SAME array, never a separate list.
 *
 * Pure and deliberately **does not take `now`**: the per-minute `now` tick that
 * refreshes relative time labels must not rebuild this array (that would defeat
 * the Phase 1 memo chain). `timeLabel` stays computed at the row renderer from
 * the shared `now` against the row's `conversation`.
 *
 * Structure (top to bottom): the "Pinned" section (when present) is always
 * first; the "Folders", "Chat" and "Recent" sections follow in the order set by
 * `sectionOrder` (default Folders → Chat → Recent). Each section's own
 * presence/expansion rules are unchanged by that order:
 * - The "Pinned" section header + its conversations appear only when `pinned`
 *   is non-empty, and its rows only when `pinnedExpanded`.
 * - The "Folders" section header ALWAYS appears (like "Chat"), so the section
 *   stays a permanent entry point — its Open-folder / Clone / Import actions stay
 *   reachable even with nothing open. Its rows appear only when `foldersExpanded`:
 *   when expanded with no open folders it contributes a single `folders-empty`
 *   hint row; otherwise its folder rows follow `orderedFolderIds`: a collapsed
 *   folder contributes only its header; an expanded empty folder contributes
 *   header + one (per-folder) empty-hint row; an expanded non-empty folder
 *   contributes header + its (already sorted) bucket. `byFolder` /
 *   `folderTotalCounts` exclude pinned conversations (they live in the Pinned
 *   section), so a folder whose only conversations are pinned reads as empty. The
 *   fully-empty initial workspace (no folders AND no conversations) never reaches
 *   buildRows — the list renders its dedicated open-folder call-to-action there.
 * - The "Chat" section header ALWAYS appears (even with zero chat
 *   conversations), so the section is a permanent entry point — its New-chat
 *   affordance and an empty hint stay reachable. When expanded and empty it
 *   contributes a single `chats-empty` hint row; otherwise its (flat, folderless)
 *   conversation rows. Pinned chat conversations live in the Pinned section, so
 *   they are excluded from `chatConversations`.
 * - The "Recent" section contributes NOTHING AT ALL (not even a header) unless
 *   `showRecent` — it is the one section the user can switch off, and a
 *   permanently-visible header for a hidden section would defeat that. When
 *   shown it mirrors the Chat section: header always, then either a single
 *   `recent-empty` hint or its flat conversation rows. Its rows are tagged
 *   `recent` because they intentionally duplicate rows already emitted by
 *   Folders / Chat (see {@link ConversationRow.recent}).
 */
export function buildRows(args: {
  pinned: readonly DbConversationSummary[]
  pinnedExpanded: boolean
  orderedFolderIds: readonly number[]
  byFolder: Map<number, DbConversationSummary[]>
  folderExpanded: Record<number, boolean>
  folderTotalCounts: Map<number, number>
  foldersExpanded: boolean
  chatConversations: readonly DbConversationSummary[]
  chatsExpanded: boolean
  /** The flat "Recent" bucket — every reachable conversation, folder-bound and
   *  chat alike (or just one kind, under the user's filter), newest first (see
   *  {@link selectRecentConversationsWithReuse}). Only read when `showRecent`.
   *  Optional — defaults to empty. */
  recentConversations?: readonly DbConversationSummary[]
  /** Whether the Recent section's rows are shown (its own collapse toggle).
   *  Optional — defaults to expanded. */
  recentExpanded?: boolean
  /** Whether the Recent section exists at all (the user's "Show Recent"
   *  preference). Optional — omitted (e.g. in tests) emits no Recent rows,
   *  matching the pre-Recent row model. The app passes it explicitly; its
   *  product default is ON. */
  showRecent?: boolean
  /** How many Recent conversations to emit before stopping and appending a
   *  {@link RecentMoreRow}. Optional — omitted means no limit (the historical
   *  behavior, kept for tests). The app raises it a page at a time, and the
   *  footer row carries `canReset` once it is past the first page so the list
   *  can be folded back to {@link RECENT_PAGE_SIZE}. */
  recentLimit?: number
  /** Vertical order of the Folders / Chat / Recent sections. The Pinned section
   *  (when present) always stays on top regardless. Normalized defensively, so
   *  a partial or repeated list still renders each section exactly once.
   *  Optional — omitted (e.g. in tests) defaults to the historical layout. */
  sectionOrder?: SidebarSectionOrder
  /** Ids whose delegation subtree is open. A conversation row with
   *  `child_count > 0` and id in this set recurses into its cached children.
   *  Optional — omitted (e.g. in tests) means nothing is expanded. */
  conversationExpanded?: ReadonlySet<number>
  /** Lazily-fetched direct children keyed by parent id. Absent key = not yet
   *  fetched (renders a loading row when expanded); empty array = no live
   *  children (renders nothing — self-heals stale `child_count`). Optional. */
  childrenByParent?: ReadonlyMap<number, readonly DbConversationSummary[]>
  /** Parent ids whose children are currently being fetched. With an empty
   *  placeholder array in `childrenByParent`, membership here renders the loading
   *  spinner; an empty array WITHOUT membership is a settled-empty subtree
   *  (renders nothing). Optional. */
  childrenLoading?: ReadonlySet<number>
  /** "Show worktrees" container map: `repoId → [worktreeChildId, ...]`. A repo
   *  present here renders as a CONTAINER — its header is followed (when the
   *  container is expanded via `folderExpanded[repoId]`) by a `root-group` header
   *  + the repo's own sessions (depth 1), then each worktree's header + sessions
   *  (depth 1). Absent/empty (the default) = the flat model: every folder renders
   *  its header + its own bucket at depth 0, exactly as before. Optional. */
  containerChildren?: ReadonlyMap<number, readonly number[]>
  /** Repo ids whose `root-group` sub-group is collapsed (its own sessions
   *  hidden). Absent = expanded (the default). Only consulted for container
   *  repos. Optional. */
  rootGroupCollapsed?: ReadonlySet<number>
  /** The mixed top-level layout: folder GROUPS interleaved with ungrouped
   *  folders, plus each group's members. Omitted (or group-free) reproduces the
   *  pre-groups row model exactly — `orderedFolderIds` is then the whole story,
   *  which is why every existing caller and test keeps working untouched.
   *
   *  When present, `orderedFolderIds` is ignored for the Folders section's
   *  ordering (the layout IS the order) but is still what the caller derived the
   *  layout from, so the two never disagree. */
  layout?: SidebarLayout
  /** Collapsed state of each folder group, keyed by group id. Absent key =
   *  expanded (the default), mirroring `folderExpanded`. Optional. */
  groupExpanded?: Record<number, boolean>
  /**
   * The buckets were narrowed by a filter (the sidebar's tag filter), so an
   * empty bucket means "nothing here matches", not "this folder is empty".
   * Such folders — and worktree sub-groups, and groups left with no matching
   * member — are dropped instead of drawing a header over an empty hint, and
   * the Folders section counts only the folders still shown. Optional —
   * omitted keeps every folder, as before.
   */
  hideEmptyFolders?: boolean
}): SidebarRow[] {
  const {
    pinned,
    pinnedExpanded,
    orderedFolderIds,
    byFolder,
    folderExpanded,
    folderTotalCounts,
    foldersExpanded,
    chatConversations,
    chatsExpanded,
    recentConversations = EMPTY_CONVERSATIONS,
    recentExpanded = true,
    showRecent = false,
    recentLimit,
    sectionOrder = DEFAULT_SECTION_ORDER,
    conversationExpanded = EMPTY_EXPANDED,
    childrenByParent = EMPTY_CHILDREN,
    childrenLoading = EMPTY_EXPANDED,
    containerChildren = EMPTY_CONTAINER_CHILDREN,
    rootGroupCollapsed = EMPTY_EXPANDED,
    layout,
    groupExpanded = EMPTY_GROUP_EXPANDED,
    hideEmptyFolders = false,
  } = args
  const rows: SidebarRow[] = []

  // Under `hideEmptyFolders`: does this display bucket hold any row, and does
  // this folder entry — a container counts its worktrees too — hold any?
  const bucketHasRows = (folderId: number) =>
    (byFolder.get(folderId)?.length ?? 0) > 0
  const entryHasRows = (folderId: number) =>
    bucketHasRows(folderId) ||
    (containerChildren.get(folderId) ?? []).some(bucketHasRows)

  if (pinned.length > 0) {
    rows.push({
      kind: "section",
      section: "pinned",
      expanded: pinnedExpanded,
      count: pinned.length,
    })
    if (pinnedExpanded) {
      for (const conv of pinned) {
        pushConversationRow(
          rows,
          conv,
          0,
          conversationExpanded,
          childrenByParent,
          childrenLoading
        )
      }
    }
  }

  // The Folders, Chat and Recent sections sit below the (always-top) Pinned
  // section in an order the user controls via `sectionOrder`. Each is its own
  // closure so the order they emit into `rows` is just the dispatch loop at the
  // bottom — the row logic inside each (headers always present, each with its
  // own empty hint) stays intact regardless of position.
  // Emit one folder's body (its conversation rows, or a single empty hint) at
  // `baseDepth` — 0 for a plain top-level folder, 1 for a container's root
  // sub-group or a worktree sub-group. The empty hint carries no depth; the
  // renderer derives its indent from the folder id (worktree/container → 1).
  const pushFolderBody = (folderId: number, baseDepth: number) => {
    const convs = byFolder.get(folderId)
    if (!convs || convs.length === 0) {
      rows.push({
        kind: "empty",
        folderId,
        totalConversationCount: folderTotalCounts.get(folderId) ?? 0,
      })
      return
    }
    for (const conv of convs) {
      pushConversationRow(
        rows,
        conv,
        baseDepth,
        conversationExpanded,
        childrenByParent,
        childrenLoading
      )
    }
  }

  // Emit one folder's header + (when expanded) its body, at `baseDepth`.
  // `baseDepth` is 0 for a top-level folder and 1 for a folder inside a group —
  // a group member reuses the SAME depth machinery as a worktree sub-group, so
  // its indent, connector rails and conversation rows all shift together.
  const pushFolderEntry = (folderId: number, baseDepth: number) => {
    if (hideEmptyFolders && !entryHasRows(folderId)) return
    const worktrees = containerChildren.get(folderId)
    if (!worktrees || worktrees.length === 0) {
      // Plain folder (or, under Show worktrees, a repo with no open worktrees):
      // header + its own bucket — the flat model.
      rows.push({ kind: "folder", folderId })
      if (folderExpanded[folderId] ?? true) pushFolderBody(folderId, baseDepth)
      return
    }
    // Container repo: its header gates the WHOLE subtree (root sub-group +
    // worktrees). Collapsing it hides everything below, so the connector spine
    // only spans an expanded container.
    rows.push({ kind: "folder", folderId })
    if (!(folderExpanded[folderId] ?? true)) return
    // The repo's OWN sessions move into an indented "root" sub-group, first.
    if (!hideEmptyFolders || bucketHasRows(folderId)) {
      rows.push({ kind: "root-group", folderId })
      if (!rootGroupCollapsed.has(folderId))
        pushFolderBody(folderId, baseDepth + 1)
    }
    // Then each worktree as its own indented sub-group.
    for (const worktreeId of worktrees) {
      if (hideEmptyFolders && !bucketHasRows(worktreeId)) continue
      rows.push({ kind: "folder", folderId: worktreeId })
      if (folderExpanded[worktreeId] ?? true) {
        pushFolderBody(worktreeId, baseDepth + 1)
      }
    }
  }

  const pushFolders = () => {
    // The Folders section header is always present (a permanent entry point),
    // mirroring the Chat section — so a workspace with chats but no open folders
    // still shows the "Folders" heading and its "add a folder" actions. The
    // fully-empty initial workspace (no folders AND no conversations) never
    // reaches buildRows; the list renders a dedicated open-folder CTA there.
    //
    // The count is FOLDERS, not top-level entries: groups are containers, and a
    // header reading "3" next to three groups holding a dozen folders would
    // undercount the thing the section is about.
    rows.push({
      kind: "section",
      section: "folders",
      expanded: foldersExpanded,
      // Filtered: the folders still shown, so the badge agrees with the list.
      count: hideEmptyFolders
        ? orderedFolderIds.filter(entryHasRows).length
        : orderedFolderIds.length,
    })
    if (!foldersExpanded) return
    // No layout given (or one with no groups at all) → the historical path,
    // driven straight off `orderedFolderIds`, byte-identical to before groups.
    const resolved =
      layout && layout.top.length > 0
        ? layout
        : layoutFromOrderedIds(orderedFolderIds)
    const rowsBefore = rows.length
    for (const entry of resolved.top) {
      if (entry.kind === "folder") {
        pushFolderEntry(entry.id, 0)
        continue
      }
      const members = resolved.membersByGroup.get(entry.id) ?? []
      // A group with nothing that matches goes too — but only under a filter:
      // unfiltered, an empty group is a real state that renders its own hint.
      if (hideEmptyFolders && !members.some(entryHasRows)) continue
      const expanded = groupExpanded[entry.id] ?? true
      // No member count on the row: the heading's badge shows RUNNING sessions,
      // which the render layer derives from live conversation state rather than
      // from the row model (a status event must never rebuild rows).
      rows.push({ kind: "folder-group", groupId: entry.id, expanded })
      if (!expanded) continue
      if (members.length === 0) {
        // A group you just created has no members yet; without this the heading
        // would sit above nothing and read as broken.
        rows.push({ kind: "group-empty", groupId: entry.id })
        continue
      }
      for (const memberId of members) pushFolderEntry(memberId, 1)
    }
    // Nothing drawn under the header: no folders open at all, or — filtered —
    // none with a match. The renderer words the hint for each.
    if (rows.length === rowsBefore) rows.push({ kind: "folders-empty" })
  }

  const pushChats = () => {
    // The Chat section header is always present (a permanent entry point),
    // unlike the conditional Pinned/Folders headers.
    rows.push({
      kind: "section",
      section: "chats",
      expanded: chatsExpanded,
      count: chatConversations.length,
    })
    if (chatsExpanded) {
      if (chatConversations.length === 0) {
        rows.push({ kind: "chats-empty" })
      } else {
        for (const conv of chatConversations) {
          pushConversationRow(
            rows,
            conv,
            0,
            conversationExpanded,
            childrenByParent,
            childrenLoading
          )
        }
      }
    }
  }

  const pushRecent = () => {
    rows.push({
      kind: "section",
      section: "recent",
      expanded: recentExpanded,
      count: recentConversations.length,
    })
    if (!recentExpanded) return
    if (recentConversations.length === 0) {
      rows.push({ kind: "recent-empty" })
      return
    }
    // Recent re-lists everything the other sections already show, so it is
    // paged: only the first `recentLimit` land, and a "show more" row offers
    // the rest. No limit given (tests, and the section's original behavior) =
    // the whole bucket. The header's own count always reports the total.
    const shown =
      recentLimit == null
        ? recentConversations
        : recentConversations.slice(0, Math.max(0, recentLimit))
    for (const conv of shown) {
      pushConversationRow(
        rows,
        conv,
        0,
        conversationExpanded,
        childrenByParent,
        childrenLoading,
        true
      )
    }
    const remaining = recentConversations.length - shown.length
    // The gate is "more than a page is on screen", not "recentLimit is past a
    // page": a raised limit outlives the conversations it revealed (delete them
    // and the limit still reads 30), which would leave a reset button that
    // changes nothing on click. `recentLimit == null` is the unpaged mode —
    // nothing was ever collapsed, so there is nothing to restore.
    const canReset = recentLimit != null && shown.length > RECENT_PAGE_SIZE
    if (remaining > 0 || canReset) {
      const row: RecentMoreRow = { kind: "recent-more", remaining }
      if (canReset) row.canReset = true
      rows.push(row)
    }
  }

  // Normalized (not consumed raw) so a truncated / repeated / unknown-entry
  // order can never drop a section off the sidebar or emit one twice.
  for (const section of normalizeSectionOrder(sectionOrder)) {
    if (section === "folders") pushFolders()
    else if (section === "chats") pushChats()
    else if (showRecent) pushRecent()
  }

  return rows
}

/**
 * Flat index of the conversation row for `(id, agentType)`, or -1 if absent
 * (folder collapsed, filtered out, or unknown). Used by `scrollToActive` to
 * drive `VirtualizerHandle.scrollToIndex` — off-screen virtualized rows are not
 * in the DOM, so a querySelector-based lookup no longer works.
 *
 * A conversation listed in Recent occupies two rows; the CANONICAL one (its
 * folder / Chat / Pinned row) always wins, whichever comes first in the array,
 * so "locate the active conversation" lands where the conversation actually
 * lives. A Recent row is the answer only when it is the sole occurrence — e.g.
 * the conversation's own section is collapsed.
 */
export function flatIndexOfConversation(
  rows: readonly SidebarRow[],
  id: number,
  agentType: string
): number {
  let recentMatch = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      row.kind === "conversation" &&
      row.conversation.id === id &&
      row.conversation.agent_type === agentType
    ) {
      if (!row.recent) return i
      if (recentMatch < 0) recentMatch = i
    }
  }
  return recentMatch
}

// ── Folder drag index math (Phase 2 custom pointer reorder) ──────────────────

/**
 * Map a pointer's Y position over the (fixed row height) collapsed drag surface
 * to a target folder slot, clamped to `[0, count - 1]`.
 *
 * @param pointerY   `clientY` of the pointer
 * @param surfaceTop `getBoundingClientRect().top` of the scroll viewport
 * @param scrollTop  current scroll offset of the viewport
 * @param rowHeight  height of one folder header row in px (fixed, 32)
 * @param count      number of folder rows on the surface
 */
export function pointerYToTargetIndex(
  pointerY: number,
  surfaceTop: number,
  scrollTop: number,
  rowHeight: number,
  count: number
): number {
  if (count <= 0) return 0
  if (rowHeight <= 0) return 0
  const raw = Math.floor((pointerY - surfaceTop + scrollTop) / rowHeight)
  return Math.max(0, Math.min(count - 1, raw))
}

/**
 * Move the item at `from` to `to`, returning a new array. Out-of-range indices
 * are clamped; a no-op move still returns a fresh array copy.
 */
export function applyReorder<T>(
  order: readonly T[],
  from: number,
  to: number
): T[] {
  const next = order.slice()
  if (from < 0 || from >= next.length) return next
  const clampedTo = Math.max(0, Math.min(next.length - 1, to))
  if (from === clampedTo) return next
  const [moved] = next.splice(from, 1)
  next.splice(clampedTo, 0, moved)
  return next
}

// ── Sticky folder header (floating overlay) ─────────────────────────────────
// virtua renders every row as `position:absolute; top:<offset>` inside a
// `contain:strict` container and unmounts off-screen rows, so CSS
// `position:sticky` cannot pin a folder header. Instead a single floating
// overlay stands in for the folder currently scrolled through. These pure
// helpers resolve "which folder" and the iOS-style handoff offset from the
// virtua handle's measured pixel offsets — see the wiring in
// `SidebarConversationList`.

/**
 * For every flat row, the index of the folder header that owns it: a folder
 * header owns itself; a conversation/empty row owns the nearest folder header
 * above it (or -1 if none precedes it). Lets the scroll handler resolve the
 * active folder in O(1) from the topmost visible row index, instead of an
 * O(folder span) backward scan that would jank in very large folders.
 *
 * A SECTION header ends the previous folder's span (back to -1): the flat rows
 * of the Chat and Recent sections belong to no folder, so without this reset
 * they would inherit the last folder of the Folders section and keep its sticky
 * header pinned over a list it has nothing to do with.
 *
 * A FOLDER-GROUP header ends it for the same reason, one level down: the group
 * heading and its empty-state hint belong to no folder, so the folder that
 * happened to sit above the group must not keep its header pinned across the
 * group's band.
 */
export function buildOwnerHeaderIndex(rows: readonly SidebarRow[]): Int32Array {
  const out = new Int32Array(rows.length)
  let current = -1
  for (let i = 0; i < rows.length; i++) {
    const kind = rows[i].kind
    if (kind === "folder") current = i
    else if (kind === "section" || kind === "folder-group") current = -1
    out[i] = current
  }
  return out
}

/** Flat indices of every folder header row, in ascending order. */
export function folderHeaderFlatIndices(rows: readonly SidebarRow[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "folder") indices.push(i)
  }
  return indices
}

/**
 * The next folder header flat index strictly after `activeHeaderIndex`, or
 * `null` when `activeHeaderIndex` is the last folder. `headerIndices` must be
 * ascending (as produced by {@link folderHeaderFlatIndices}).
 */
export function nextHeaderAfter(
  headerIndices: readonly number[],
  activeHeaderIndex: number
): number | null {
  for (let i = 0; i < headerIndices.length; i++) {
    if (headerIndices[i] > activeHeaderIndex) return headerIndices[i]
  }
  return null
}

/**
 * Flat index of the folder header row for `folderId`, or -1 if absent. Used
 * after a collapse-from-overlay toggle to scroll that header to the top.
 */
export function headerIndexForFolder(
  rows: readonly SidebarRow[],
  folderId: number
): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === "folder" && row.folderId === folderId) return i
  }
  return -1
}

/**
 * Pure geometry for the floating sticky folder header. All inputs are measured
 * pixel offsets from the virtua handle; no DOM access.
 *
 * - `visible`: the active folder's own header has scrolled above the viewport
 *   top, so the overlay should stand in for it. (At the very top, where
 *   `scrollOffset === activeHeaderOffset`, the real header is shown instead.)
 * - `translateY`: iOS-style handoff — once the next folder's header is within
 *   one header height of the top it pushes the overlay up so the incoming header
 *   displaces it. Rounded to whole pixels to avoid sub-pixel shimmer against the
 *   real (still-mounted within the buffer) header underneath.
 */
export function computeStickyState(args: {
  scrollOffset: number
  activeHeaderOffset: number
  nextHeaderOffset: number | null
  headerHeight: number
}): { visible: boolean; translateY: number } {
  const { scrollOffset, activeHeaderOffset, nextHeaderOffset, headerHeight } =
    args
  const visible = scrollOffset > activeHeaderOffset
  let translateY = 0
  if (visible && nextHeaderOffset != null) {
    const d = nextHeaderOffset - scrollOffset
    if (d >= 0 && d < headerHeight) {
      translateY = Math.round(d - headerHeight)
    }
  }
  return { visible, translateY }
}

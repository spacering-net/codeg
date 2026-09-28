import { create } from "zustand"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  applySidebarLayout as apiApplySidebarLayout,
  createFolderGroup as apiCreateFolderGroup,
  deleteFolderGroup as apiDeleteFolderGroup,
  getFolder as apiGetFolder,
  getGitHead,
  listAllConversations,
  listAllFolderDetails,
  listFolderGroups,
  listOpenFolderDetails,
  openFolder as apiOpenFolder,
  openFolderById as apiOpenFolderById,
  openWorktreeFolder as apiOpenWorktreeFolder,
  removeFolderFromWorkspace as apiRemoveFolderFromWorkspace,
  setFolderGroup as apiSetFolderGroup,
  updateFolderGroup as apiUpdateFolderGroup,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  forgetClosedConversation,
  forgetClosedTabsInFolder,
} from "@/lib/closed-tab-stack"
import type {
  AgentStats,
  AgentType,
  DbConversationSummary,
  FolderDetail,
  FolderGroupChange,
  FolderGroupDetail,
  GitHeadInfo,
  SidebarLayoutEntry,
} from "@/lib/types"
import type { FolderThemeColor } from "@/lib/theme-presets"

/**
 * Workspace-level shared state (folders, conversations, branches) as a Zustand
 * store. Components subscribe to the narrowest slice they render via
 * `useAppWorkspaceStore(selector)`; event bridges and callbacks read fresh
 * state through `useAppWorkspaceStore.getState()` instead of ref mirrors.
 *
 * Event wiring (side-channel subscriptions, branch polling, initial fetches)
 * stays in `AppWorkspaceProvider` — the store itself is transport-agnostic.
 */
export interface AppWorkspaceStoreState {
  folders: FolderDetail[]
  allFolders: FolderDetail[]
  /**
   * Sidebar folder groups, in `sort_order`. Fetched alongside the folder lists
   * (one `fetchFolders`), since a group without its members — or a member whose
   * group hasn't arrived — would render a half-built sidebar.
   */
  folderGroups: FolderGroupDetail[]
  foldersHydrated: boolean
  foldersLoading: boolean

  conversations: DbConversationSummary[]
  conversationsLoading: boolean
  conversationsError: string | null

  /**
   * Display branch name per folder (null when detached or non-repo).
   */
  branches: Map<number, string | null>

  /**
   * Full HEAD state per folder (repo-ness, detached, short sha). The poll keeps
   * this in sync alongside `branches`; consumers that only need the display
   * branch name keep reading `branches`. `BranchDropdown` reads this to tell a
   * detached HEAD apart from a non-git folder (issue #279).
   */
  gitHeads: Map<number, GitHeadInfo | null>

  /**
   * Derived from `conversations` on every write so subscribers get a stable
   * reference between conversation changes.
   */
  stats: AgentStats | null

  /**
   * Currently-active folder id as driven by the active tab.
   * TabProvider sets this; `useActiveFolder` / other consumers read it.
   */
  activeFolderId: number | null

  fetchFolders: () => Promise<void>
  refreshConversations: () => Promise<void>
  /**
   * Non-reactive by-id lookup for callbacks/effects. Render-time reads must
   * use a selector (`useAppWorkspaceStore((s) => s.allFolders.find(...))`)
   * instead, or they won't update when the folder changes.
   */
  getFolder: (id: number) => FolderDetail | undefined
  updateConversationLocal: (
    id: number,
    patch: Partial<
      Pick<
        DbConversationSummary,
        "status" | "title" | "pinned_at" | "pin_order"
      >
    >
  ) => void
  applyConversationUpsert: (summary: DbConversationSummary) => void
  applyConversationRemove: (id: number) => void
  getBranch: (folderId: number) => string | null | undefined
  setBranch: (folderId: number, branch: string | null) => void
  /** Equality-guarded merge of one folder's polled HEAD into branches/gitHeads. */
  applyGitHead: (folderId: number, head: GitHeadInfo) => void
  /**
   * Resolve one folder's HEAD on demand, for a surface showing a folder the
   * active-folder poll isn't covering. Fire-and-forget and idempotent: a folder
   * whose HEAD is already known, or whose fetch is already in flight, costs
   * nothing, so N mounted branch chips across M folders make M requests.
   */
  ensureGitHead: (folderId: number, path: string) => void
  /**
   * Insert/replace a folder in local state, mirroring the backend's list
   * split: a `kind === "chat"` folder goes into `allFolders` only (matching
   * `list_open_folder_details`, which excludes chat folders from the
   * user-facing list), every other kind into both lists.
   */
  upsertFolder: (detail: FolderDetail) => void
  /**
   * Drop a folder that no longer exists (a removed task worktree) from local
   * state — both lists plus its branch/HEAD entries. Idempotent: an unknown id
   * writes nothing, so a duplicate broadcast costs no re-render. The removal is
   * also stamped so a `fetchFolders` that was already in flight can't put the
   * folder back (see `removedFolderSeq`). Distinct from
   * `removeFolderFromWorkspace`, which merely CLOSES a still-existing folder
   * (and so leaves it in `allFolders` for by-id cwd lookups).
   */
  applyFolderRemove: (folderId: number) => void
  openFolder: (path: string) => Promise<FolderDetail>
  openWorktreeFolder: (
    path: string,
    sourceFolderId: number
  ) => Promise<FolderDetail>
  addFolderToWorkspaceById: (folderId: number) => Promise<FolderDetail>
  removeFolderFromWorkspace: (folderId: number) => Promise<void>
  /**
   * Persist a whole sidebar layout (top-level order + each group's members)
   * after a drag. Optimistic: local `group_id` / `sort_order` are patched first
   * and rolled back if the write fails, so the list never snaps back mid-drop.
   */
  applySidebarLayout: (entries: SidebarLayoutEntry[]) => Promise<void>
  createFolderGroup: (
    name: string,
    color?: FolderThemeColor
  ) => Promise<FolderGroupDetail>
  updateFolderGroup: (
    groupId: number,
    patch: { name?: string; color?: FolderThemeColor }
  ) => Promise<void>
  /** Delete a group; its member folders return to the top level (never closed). */
  deleteFolderGroup: (groupId: number) => Promise<void>
  /** Move one folder into (`groupId`) or out of (`null`) a group, appending it. */
  setFolderGroup: (folderId: number, groupId: number | null) => Promise<void>
  /** Apply a `folder-group://changed` broadcast from another window/client. */
  applyFolderGroupChange: (change: FolderGroupChange) => void
  refreshFolder: (id: number) => Promise<void>
  setActiveFolderId: (id: number | null) => void
}

function computeStats(conversations: DbConversationSummary[]): AgentStats {
  const byAgent = new Map<AgentType, number>()
  let totalMessages = 0

  for (const s of conversations) {
    byAgent.set(s.agent_type, (byAgent.get(s.agent_type) ?? 0) + 1)
    totalMessages += s.message_count
  }

  return {
    total_conversations: conversations.length,
    total_messages: totalMessages,
    by_agent: Array.from(byAgent.entries()).map(([agent_type, count]) => ({
      agent_type,
      conversation_count: count,
    })),
  }
}

/** Keep `stats` in lockstep with every `conversations` write. */
function withConversations(conversations: DbConversationSummary[]) {
  return {
    conversations,
    stats: conversations.length > 0 ? computeStats(conversations) : null,
  }
}

// Bound on the soft-delete tombstone set (see `deletedIds`). The eviction
// window — 512 deletions — far exceeds any realistic late/out-of-order event
// delay, so a row can never be resurrected in practice while memory stays
// bounded across a long-lived session.
const DELETED_TOMBSTONE_CAP = 512

// Tombstones for soft-deleted ids: a stale/out-of-order `upsert` that lands
// after a `deleted` (e.g. a concurrent rename racing a delete from another
// client) must not resurrect the row. Ids are DB autoincrement and never
// reused, so the tombstone is permanent; the set is FIFO-bounded.
const deletedIds = new Set<number>()

/**
 * Has this client seen `id` deleted? `reopen_last_closed_tab` asks before it
 * restores a conversation: `applyConversationRemove` purges what is on the
 * stack at that moment, but a tab that was still OPEN when the delete landed
 * gets recorded afterwards, when the user closes it by hand. Consulting the
 * tombstone at restore time means a deletion seen at any point wins.
 */
export function isConversationDeleted(id: number): boolean {
  return deletedIds.has(id)
}

// Folder removals, as `folder id → the mutation sequence number it landed at`.
// `fetchFolders` replaces both lists wholesale, so a snapshot that was ALREADY
// IN FLIGHT when a removal arrived would put the folder straight back on screen;
// a fetch subtracts exactly the ids removed AFTER it requested its snapshot.
//
// Scoped by sequence rather than kept as a permanent tombstone (the way
// `deletedIds` is for conversations) because folder ids ARE reused: a row is
// revived by path — `folder_service::add_folder` clears `deleted_at` on the same
// row — so a task retried after its worktree was cleaned re-creates that exact
// folder id. A LATER fetch must therefore be trusted verbatim; it may be the
// only place a revive is ever learned, since the reconnect refetch exists
// precisely to reconcile events dropped while the socket was down.
const removedFolderSeq = new Map<number, number>()
let folderMutationSeq = 0

/** True when `folderId` was removed after a snapshot requested at `seq`. */
function removedSince(folderId: number, seq: number): boolean {
  const at = removedFolderSeq.get(folderId)
  return at !== undefined && at > seq
}

function forgetRemovedFolder(folderId: number): void {
  // The folder exists again, so no snapshot should be filtered on its account.
  removedFolderSeq.delete(folderId)
}

function rememberRemovedFolder(folderId: number): void {
  folderMutationSeq += 1
  removedFolderSeq.set(folderId, folderMutationSeq)
  if (removedFolderSeq.size > DELETED_TOMBSTONE_CAP) {
    // FIFO eviction — Map preserves insertion order. Evicting the oldest is
    // safe: an old entry can only ever fail the `removedSince` test anyway.
    const oldest = removedFolderSeq.keys().next().value
    if (oldest !== undefined) removedFolderSeq.delete(oldest)
  }
}

// Group deletions, stamped the same way and for the same reason: `fetchFolders`
// replaces `folderGroups` wholesale, so a snapshot already in flight when a
// delete landed would put the band straight back on screen — and nothing would
// take it down again, because the `deleted` broadcast has already been applied
// and no-ops the second time. Folders pointing at a filtered-out group fall back
// to the top level on their own (`buildSidebarLayout` treats an unknown
// `group_id` as ungrouped), so filtering the group list is the whole fix.
const deletedGroupSeq = new Map<number, number>()

/** True when `groupId` was deleted after a snapshot requested at `seq`. */
function groupDeletedSince(groupId: number, seq: number): boolean {
  const at = deletedGroupSeq.get(groupId)
  return at !== undefined && at > seq
}

function rememberDeletedGroup(groupId: number): void {
  folderMutationSeq += 1
  deletedGroupSeq.set(groupId, folderMutationSeq)
  if (deletedGroupSeq.size > DELETED_TOMBSTONE_CAP) {
    const oldest = deletedGroupSeq.keys().next().value
    if (oldest !== undefined) deletedGroupSeq.delete(oldest)
  }
}

function forgetDeletedGroup(groupId: number): void {
  // A group with this id exists again, so no snapshot should be filtered on its
  // account. (Group ids come from an AUTOINCREMENT column and so are not reused
  // in practice; this keeps the map honest anyway, and bounded.)
  deletedGroupSeq.delete(groupId)
}

// Monotonic id per `fetchFolders` call, so an older snapshot can never land on
// top of a newer one. Every drag now ends in a `layout` nudge that triggers a
// refetch, so two fetches are routinely in flight at once and out-of-order
// completion would leave the sidebar showing the second-to-last order.
let folderFetchSeq = 0
let lastAppliedFolderFetch = 0

/**
 * Folders whose on-demand HEAD read is in flight (see `ensureGitHead`), each
 * stamped with a token identifying the read that owns the slot. A canvas board
 * mounts one branch chip per card, so without this the same folder would be
 * asked N times in the same frame.
 *
 * A token rather than a bare id because a folder row can be removed and revived
 * under the SAME id — a retried task re-creating its worktree does exactly that
 * (see `upsertFolder`). `removedFolderSeq` cannot tell the two incarnations
 * apart, since `upsertFolder` forgets the tombstone the moment the row is back.
 * `applyFolderRemove` drops the slot, so the revived folder is free to ask
 * again, and the older read recognises that it no longer owns the slot and
 * discards its answer instead of writing the departed directory's branch onto
 * the new one.
 */
const gitHeadInFlight = new Map<number, symbol>()

/**
 * Undo an optimistic folder/group mutation whose request failed, then re-read
 * from the server.
 *
 * The restore alone is not enough. It reinstates a snapshot captured before the
 * request, so anything that landed WHILE the request was in flight — a peer's
 * layout change, another window's rename — is erased along with our own failed
 * write. The refetch is what converges: it is ordered against every other fetch
 * by `folderFetchSeq`, so whatever the server actually holds wins. The restore
 * still happens first so the sidebar snaps back immediately instead of sitting
 * on a lie for a round trip.
 */
function rollbackAndResync(
  set: (partial: Partial<AppWorkspaceStoreState>) => void,
  get: () => AppWorkspaceStoreState,
  restore: Partial<AppWorkspaceStoreState>
): void {
  set(restore)
  void get().fetchFolders()
}

export const useAppWorkspaceStore = create<AppWorkspaceStoreState>()(
  (set, get) => ({
    folders: [],
    allFolders: [],
    folderGroups: [],
    foldersHydrated: false,
    foldersLoading: true,

    conversations: [],
    conversationsLoading: true,
    conversationsError: null,

    branches: new Map(),
    gitHeads: new Map(),
    stats: null,
    activeFolderId: null,

    fetchFolders: async () => {
      set({ foldersLoading: true })
      // Stamped BEFORE the requests go out: anything removed from here on is
      // newer than the snapshot they return.
      const seqAtRequest = folderMutationSeq
      const fetchId = ++folderFetchSeq
      try {
        const [openRaw, allRaw, groups] = await Promise.all([
          listOpenFolderDetails(),
          listAllFolderDetails(),
          // Fetched in the SAME round trip as the folders: a snapshot where one
          // has landed and the other hasn't renders a group with no members (or
          // members whose group is unknown, which fall back to the top level and
          // visibly jump once the other arrives).
          listFolderGroups(),
        ])
        // Both lists are replaced wholesale, so a snapshot that predates a
        // removal would resurrect the folder. Subtract only what was removed
        // AFTER this snapshot was requested — an earlier removal is already
        // reflected in it, and if that row was since revived the snapshot is
        // the truth (this is how a revive during a disconnect is learned).
        // A snapshot older than one already applied is thrown away wholesale
        // rather than merged: it is not "extra information", it is a strictly
        // earlier view of the same three lists, and applying it would undo the
        // newer one.
        if (fetchId < lastAppliedFolderFetch) return
        lastAppliedFolderFetch = fetchId
        const live = (list: FolderDetail[]) =>
          removedFolderSeq.size === 0
            ? list
            : list.filter((f) => !removedSince(f.id, seqAtRequest))
        const openList = live(openRaw)
        const allList = live(allRaw)
        // Same subtraction for groups deleted after this snapshot was requested.
        const groupList =
          deletedGroupSeq.size === 0
            ? groups
            : groups.filter((g) => !groupDeletedSince(g.id, seqAtRequest))
        const branches = new Map(get().branches)
        for (const f of allList) {
          if (!branches.has(f.id)) {
            branches.set(f.id, f.git_branch ?? null)
          }
        }
        set({
          folders: openList,
          allFolders: allList,
          folderGroups: groupList,
          branches,
        })
      } catch (err) {
        console.error("[AppWorkspace] fetchFolders failed:", err)
      } finally {
        set({ foldersLoading: false, foldersHydrated: true })
      }
    },

    refreshConversations: async () => {
      set({ conversationsLoading: true })
      try {
        const list = await listAllConversations()
        set({ ...withConversations(list), conversationsError: null })
      } catch (err) {
        set({ conversationsError: toErrorMessage(err) })
      } finally {
        set({ conversationsLoading: false })
      }
    },

    getFolder: (id) => get().allFolders.find((f) => f.id === id),

    updateConversationLocal: (id, patch) => {
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === id)
      // Unknown id (e.g. a delegation-child status event reaching the global
      // channel) → leave state untouched so `stats` and sidebar consumers
      // don't re-render on a logical no-op.
      if (idx < 0) return
      const next = prev.slice()
      // A pin toggle or a pin reorder is a view preference, not activity —
      // mirror the backend (`update_pin` / `reorder_pins`) and leave
      // `updated_at` untouched so an updated-sorted folder doesn't briefly
      // float the row. Status/title patches still bump.
      const bumpUpdatedAt = !("pinned_at" in patch) && !("pin_order" in patch)
      next[idx] = {
        ...next[idx],
        ...patch,
        ...(bumpUpdatedAt ? { updated_at: new Date().toISOString() } : {}),
      }
      // `stats` (computeStats) depends ONLY on the conversation count and each
      // row's agent_type/message_count. This path replaces a row IN PLACE (count
      // never changes), and the patch type is restricted to status/title/
      // pinned_at/pin_order — none of which is a stat input — so a patch here
      // can never move a stat.
      // Reuse the existing `stats` reference instead of recomputing O(n) and
      // minting a fresh object: otherwise every turn-boundary
      // `conversation_status_changed` tick (one per turn start/stop, per running
      // agent) would re-render every `stats` subscriber for a no-op. The
      // `statsAffecting` guard keeps this self-correcting if the patch type is
      // ever widened to include a stat input (it recomputes then); today it is
      // always false, i.e. always reuse.
      const statsAffecting = "message_count" in patch || "agent_type" in patch
      set(
        statsAffecting
          ? withConversations(next)
          : { conversations: next, stats: get().stats }
      )
    },

    // Insert-or-replace a conversation by id (create + field updates). Root-only:
    // delegation children (parent_id set) are not sidebar rows. New rows prepend
    // (most-recent-first); existing rows replace in place to keep their position.
    applyConversationUpsert: (summary) => {
      if (summary.parent_id != null) return
      if (deletedIds.has(summary.id)) return
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === summary.id)
      if (idx < 0) {
        set(withConversations([summary, ...prev]))
        return
      }
      const next = prev.slice()
      next[idx] = summary
      set(withConversations(next))
    },

    // Remove a conversation by id. Idempotent: an unknown id leaves state
    // untouched (no re-render; keeps `stats` stable).
    applyConversationRemove: (id) => {
      // The single funnel for "this conversation is gone": the backend
      // broadcasts Deleted to every client including the one that asked, so
      // this covers a local delete, another window's, and a partially-failed
      // bulk delete (each success emits on its own). Reaching into the
      // closed-tab stack here is what stops `reopen_last_closed_tab` from
      // restoring a conversation that was closed BEFORE it was deleted — the
      // close-time opt-out only sees tabs that are still open.
      forgetClosedConversation(id)
      deletedIds.add(id)
      if (deletedIds.size > DELETED_TOMBSTONE_CAP) {
        // FIFO eviction — Set preserves insertion order.
        const oldest = deletedIds.values().next().value
        if (oldest !== undefined) deletedIds.delete(oldest)
      }
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === id)
      if (idx < 0) return
      const next = prev.slice()
      next.splice(idx, 1)
      set(withConversations(next))
    },

    getBranch: (folderId) => get().branches.get(folderId),

    setBranch: (folderId, branch) => {
      const next = new Map(get().branches)
      next.set(folderId, branch)
      set({ branches: next })
    },

    applyGitHead: (folderId, head) => {
      const { branches, gitHeads } = get()
      const patch: Partial<AppWorkspaceStoreState> = {}
      // `branches` stays the display branch name (null when detached or
      // non-repo) — unchanged contract for tab-bar/context-bar consumers.
      if (branches.get(folderId) !== head.branch) {
        const next = new Map(branches)
        next.set(folderId, head.branch)
        patch.branches = next
      }
      const existing = gitHeads.get(folderId)
      if (
        !existing ||
        existing.is_repo !== head.is_repo ||
        existing.branch !== head.branch ||
        existing.detached !== head.detached ||
        existing.short_sha !== head.short_sha
      ) {
        const next = new Map(gitHeads)
        next.set(folderId, head)
        patch.gitHeads = next
      }
      if (Object.keys(patch).length > 0) set(patch)
    },

    ensureGitHead: (folderId, path) => {
      if (!path) return
      // Already resolved, or someone else is already asking. `gitHeads` is the
      // authority here rather than `branches`: `branches` is pre-seeded from the
      // folder row's `git_branch` (always null today) for EVERY folder, so it
      // can never answer "do we know this folder's HEAD?".
      if (get().gitHeads.has(folderId)) return
      if (gitHeadInFlight.has(folderId)) return
      const token = Symbol(folderId)
      gitHeadInFlight.set(folderId, token)
      void getGitHead(path)
        .then((head) => {
          // Only if this read still owns the slot. A folder removed (and maybe
          // revived under the same id) while we were waiting has had the slot
          // dropped by `applyFolderRemove`, and the answer we are holding is
          // about the directory that used to be there.
          if (gitHeadInFlight.get(folderId) !== token) return
          get().applyGitHead(folderId, head)
        })
        .catch((err) => {
          console.error("[AppWorkspace] ensureGitHead failed:", err)
        })
        .finally(() => {
          // Released on failure too, so a folder that was mid-clone (or briefly
          // unreachable) can be asked again on the next mount instead of being
          // stuck reading "no branch" for the rest of the session. Only ever OUR
          // slot: a newer read for a revived id owns it now and must not have it
          // cleared out from under it.
          if (gitHeadInFlight.get(folderId) === token) {
            gitHeadInFlight.delete(folderId)
          }
        })
    },

    upsertFolder: (detail) => {
      // The folder exists again (a retried task re-creating its worktree revives
      // the very same row/id) — drop any tombstone so refetches keep it.
      forgetRemovedFolder(detail.id)
      const upsert = (prev: FolderDetail[]) => {
        const idx = prev.findIndex((f) => f.id === detail.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = detail
          return updated
        }
        return [...prev, detail]
      }
      const { folders, allFolders } = get()
      // Mirror the backend's list split: hidden chat folders are excluded from
      // `list_open_folder_details` (the user-facing `folders` list) but kept in
      // `list_all_folder_details` (`allFolders`, for by-id cwd / active-folder
      // lookups). Seeding a chat folder into `folders` would render a "Chat"
      // header row in the sidebar until the next refetch.
      set({
        ...(detail.kind !== "chat" ? { folders: upsert(folders) } : {}),
        allFolders: upsert(allFolders),
      })
    },

    applyFolderRemove: (folderId) => {
      // Same reasoning as `applyConversationRemove`: tabs closed while the
      // folder still existed are already on the reopen stack, and their cwd is
      // about to stop existing.
      forgetClosedTabsInFolder(folderId)
      rememberRemovedFolder(folderId)
      // Disown any on-demand HEAD read still running for this folder. Dropping
      // the slot does two things at once: the id is free to be asked about again
      // the moment it comes back (`upsertFolder` revives the very same row id
      // after a retried task re-creates its worktree), and the older read finds
      // itself no longer the owner and discards its answer instead of writing
      // the departed directory's branch onto the new one.
      gitHeadInFlight.delete(folderId)
      const { folders, allFolders, branches, gitHeads } = get()
      const patch: Partial<AppWorkspaceStoreState> = {}
      if (folders.some((f) => f.id === folderId)) {
        patch.folders = folders.filter((f) => f.id !== folderId)
      }
      if (allFolders.some((f) => f.id === folderId)) {
        patch.allFolders = allFolders.filter((f) => f.id !== folderId)
      }
      if (branches.has(folderId)) {
        const next = new Map(branches)
        next.delete(folderId)
        patch.branches = next
      }
      if (gitHeads.has(folderId)) {
        const next = new Map(gitHeads)
        next.delete(folderId)
        patch.gitHeads = next
      }
      if (Object.keys(patch).length > 0) set(patch)
    },

    openFolder: async (path) => {
      const detail = await apiOpenFolder(path)
      const { upsertFolder, setBranch, refreshConversations } = get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)
      void refreshConversations()
      return detail
    },

    openWorktreeFolder: async (path, sourceFolderId) => {
      const detail = await apiOpenWorktreeFolder(path, sourceFolderId)
      const { upsertFolder, setBranch, refreshConversations } = get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)
      void refreshConversations()
      return detail
    },

    addFolderToWorkspaceById: async (folderId) => {
      const detail = await apiOpenFolderById(folderId)
      const { upsertFolder, setBranch, refreshConversations } = get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)
      void refreshConversations()
      return detail
    },

    removeFolderFromWorkspace: async (folderId) => {
      await apiRemoveFolderFromWorkspace(folderId)
      const { folders, branches, refreshConversations } = get()
      const patch: Partial<AppWorkspaceStoreState> = {
        folders: folders.filter((f) => f.id !== folderId),
      }
      if (branches.has(folderId)) {
        const next = new Map(branches)
        next.delete(folderId)
        patch.branches = next
      }
      set(patch)
      void refreshConversations()
    },

    applySidebarLayout: async (entries) => {
      const {
        folders: prevFolders,
        allFolders: prevAllFolders,
        folderGroups: prevGroups,
      } = get()

      // Mirror the backend's per-container counter so local state matches what
      // was just written, without waiting for the `layout` broadcast to arrive.
      // Positions are 1-based there, so they are here too.
      const nextOrder = new Map<number | null, number>()
      const folderPatch = new Map<
        number,
        { sort: number; group: number | null }
      >()
      const groupPatch = new Map<number, number>()
      const seenFolders = new Set<number>()
      const seenGroups = new Set<number>()
      for (const entry of entries) {
        if (entry.kind === "group") {
          if (seenGroups.has(entry.id)) continue
          seenGroups.add(entry.id)
          const slot = (nextOrder.get(null) ?? 0) + 1
          nextOrder.set(null, slot)
          groupPatch.set(entry.id, slot)
        } else {
          if (seenFolders.has(entry.id)) continue
          seenFolders.add(entry.id)
          const container = entry.groupId ?? null
          const slot = (nextOrder.get(container) ?? 0) + 1
          nextOrder.set(container, slot)
          folderPatch.set(entry.id, { sort: slot, group: container })
        }
      }

      // Only the named rows change; everything else keeps its position, exactly
      // like the backend leaves unnamed rows alone. List ORDER is left as the
      // server returned it — the sidebar derives its own order from
      // `sort_order` / `group_id`, so re-sorting the arrays here would be a
      // second, divergent source of truth.
      const patchList = (prev: FolderDetail[]) =>
        prev.map((f) => {
          const patch = folderPatch.get(f.id)
          if (!patch) return f
          if (f.sort_order === patch.sort && f.group_id === patch.group)
            return f
          return { ...f, sort_order: patch.sort, group_id: patch.group }
        })

      set({
        folders: patchList(prevFolders),
        allFolders: patchList(prevAllFolders),
        folderGroups: prevGroups.map((g) => {
          const sort = groupPatch.get(g.id)
          if (sort === undefined || g.sort_order === sort) return g
          return { ...g, sort_order: sort }
        }),
      })

      try {
        await apiApplySidebarLayout(entries)
      } catch (err) {
        rollbackAndResync(set, get, {
          folders: prevFolders,
          allFolders: prevAllFolders,
          folderGroups: prevGroups,
        })
        throw err
      }
    },

    createFolderGroup: async (name, color) => {
      const group = await apiCreateFolderGroup(name, color)
      // A group with this id exists again, so an in-flight snapshot must no
      // longer be filtered on its account.
      forgetDeletedGroup(group.id)
      // Insert rather than refetch: the caller may immediately move a folder
      // into this group, and a group missing from local state would render that
      // folder back at the top level for a frame.
      const { folderGroups } = get()
      if (!folderGroups.some((g) => g.id === group.id)) {
        set({ folderGroups: [...folderGroups, group] })
      }
      return group
    },

    updateFolderGroup: async (groupId, patch) => {
      const prev = get().folderGroups
      const target = prev.find((g) => g.id === groupId)
      if (!target) return
      set({
        folderGroups: prev.map((g) =>
          g.id === groupId ? { ...g, ...patch } : g
        ),
      })
      try {
        await apiUpdateFolderGroup(groupId, patch)
      } catch (err) {
        rollbackAndResync(set, get, { folderGroups: prev })
        throw err
      }
    },

    deleteFolderGroup: async (groupId) => {
      const {
        folderGroups: prevGroups,
        folders: prevFolders,
        allFolders: prevAllFolders,
      } = get()
      // Members return to the top level — they are never closed or forgotten.
      // Their exact new `sort_order` comes from the server; clearing `group_id`
      // is enough for the sidebar to place them, and the `layout` broadcast
      // reconciles the positions.
      const ungroup = (list: FolderDetail[]) =>
        list.map((f) => (f.group_id === groupId ? { ...f, group_id: null } : f))
      // Stamped BEFORE the request: a `listFolderGroups` snapshot that was
      // already in flight would otherwise put this band back on screen, and the
      // `deleted` broadcast that would have taken it down has already been
      // applied (it no-ops the second time).
      rememberDeletedGroup(groupId)
      set({
        folderGroups: prevGroups.filter((g) => g.id !== groupId),
        folders: ungroup(prevFolders),
        allFolders: ungroup(prevAllFolders),
      })
      try {
        await apiDeleteFolderGroup(groupId)
      } catch (err) {
        forgetDeletedGroup(groupId)
        rollbackAndResync(set, get, {
          folderGroups: prevGroups,
          folders: prevFolders,
          allFolders: prevAllFolders,
        })
        throw err
      }
    },

    setFolderGroup: async (folderId, groupId) => {
      const { folders: prevFolders, allFolders: prevAllFolders } = get()
      const patchList = (list: FolderDetail[]) =>
        list.map((f) => (f.id === folderId ? { ...f, group_id: groupId } : f))
      set({
        folders: patchList(prevFolders),
        allFolders: patchList(prevAllFolders),
      })
      try {
        await apiSetFolderGroup(folderId, groupId)
      } catch (err) {
        rollbackAndResync(set, get, {
          folders: prevFolders,
          allFolders: prevAllFolders,
        })
        throw err
      }
    },

    applyFolderGroupChange: (change) => {
      if (change.kind === "upsert") {
        const { folderGroups } = get()
        forgetDeletedGroup(change.group.id)
        const idx = folderGroups.findIndex((g) => g.id === change.group.id)
        if (idx < 0) {
          set({ folderGroups: [...folderGroups, change.group] })
          return
        }
        const next = [...folderGroups]
        next[idx] = change.group
        set({ folderGroups: next })
        return
      }
      if (change.kind === "deleted") {
        const {
          folderGroups,
          folders: prevFolders,
          allFolders: prevAllFolders,
        } = get()
        // Stamped even when the group is already gone locally (our own echo):
        // a `listFolderGroups` snapshot from before the delete may still be in
        // flight, and this is the only record that would filter it out.
        rememberDeletedGroup(change.id)
        if (!folderGroups.some((g) => g.id === change.id)) return
        const ungroup = (list: FolderDetail[]) =>
          list.map((f) =>
            f.group_id === change.id ? { ...f, group_id: null } : f
          )
        set({
          folderGroups: folderGroups.filter((g) => g.id !== change.id),
          folders: ungroup(prevFolders),
          allFolders: ungroup(prevAllFolders),
        })
        return
      }
      // `layout`: membership/order changed somewhere. It carries no payload by
      // design, so re-read both lists.
      void get().fetchFolders()
    },

    refreshFolder: async (id) => {
      try {
        const detail = await apiGetFolder(id)
        const patchList = (prev: FolderDetail[]) => {
          const idx = prev.findIndex((f) => f.id === id)
          if (idx < 0) return prev
          const updated = [...prev]
          updated[idx] = detail
          return updated
        }
        const { folders, allFolders, branches } = get()
        const patch: Partial<AppWorkspaceStoreState> = {
          folders: patchList(folders),
          allFolders: patchList(allFolders),
        }
        // Only adopt the DB branch when the row actually carries one. A folder's
        // `git_branch` column is always null today — branch state is resolved by
        // git-head polling (`applyGitHead`) — so unconditionally writing it here
        // would clobber the polled branch name with null and make the selector
        // flash "no branch" until the next poll (up to 10s). Mirrors the same
        // null-guard the `folder://changed` handler already applies.
        if (detail.git_branch != null) {
          const nextBranches = new Map(branches)
          nextBranches.set(id, detail.git_branch)
          patch.branches = nextBranches
        }
        set(patch)
      } catch (err) {
        console.error("[AppWorkspace] refreshFolder failed:", err)
      }
    },

    setActiveFolderId: (id) => {
      if (get().activeFolderId === id) return
      set({ activeFolderId: id })
    },
  })
)

/**
 * Restore the pristine initial state (including tombstones). Used by tests, and
 * by the backend-scoped reset registry if a realm's backend identity ever
 * changes (an invariant-violating transition that does not occur today — see
 * `RemoteConnectionGate`). In normal operation the store lives for the window's
 * lifetime and is never reset.
 */
export function resetAppWorkspaceStore() {
  // NOTE: this clears state only; `fetchFolders` / `refreshConversations` have no
  // backend epoch, so a pre-reset in-flight fetch could re-commit stale data. Moot
  // today (the backend-identity guard never fires); a real in-place backend switch
  // would need per-store fetch epochs. See `RemoteConnectionGate`.
  deletedIds.clear()
  removedFolderSeq.clear()
  deletedGroupSeq.clear()
  gitHeadInFlight.clear()
  folderMutationSeq = 0
  folderFetchSeq = 0
  lastAppliedFolderFetch = 0
  useAppWorkspaceStore.setState(useAppWorkspaceStore.getInitialState(), true)
}

// Reset this backend-scoped store on any (currently-unreachable) in-realm
// backend switch. See `backend-scoped-store-reset.ts`.
registerBackendScopedStoreReset(resetAppWorkspaceStore)

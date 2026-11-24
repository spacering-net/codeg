import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppWorkspaceProvider } from "@/contexts/app-workspace-context"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type {
  ConversationChange,
  DbConversationSummary,
  FolderChange,
  FolderDetail,
} from "@/lib/types"

// Capture the `conversation://changed` handler + reconnect callback the
// provider registers, plus dispose/unsub spies, so tests can drive events and
// assert cleanup. `vi.hoisted` runs before the (hoisted) mock factories so they
// can close over this shared state without a TDZ error.
const h = vi.hoisted(() => ({
  handler: null as null | ((change: unknown) => void),
  folderHandler: null as null | ((change: unknown) => void),
  bulkHandler: null as null | ((change: unknown) => void),
  groupHandler: null as null | ((change: unknown) => void),
  reconnect: null as null | (() => void),
  folderReconnect: null as null | (() => void),
  disposeSpy: vi.fn(),
  folderDisposeSpy: vi.fn(),
  bulkDisposeSpy: vi.fn(),
  groupDisposeSpy: vi.fn(),
  reconnectUnsubSpy: vi.fn(),
  folderReconnectUnsubSpy: vi.fn(),
  listAll: vi.fn(async () => [] as unknown[]),
  listOpenFolders: vi.fn(async () => [] as unknown[]),
  listFolderGroups: vi.fn(async () => [] as unknown[]),
  listAllFolders: vi.fn(async () => [] as unknown[]),
  closeTabsByFolder: vi.fn(),
}))

// The folder-delete branch reaches into the tab store imperatively; stub it so
// this suite stays on the workspace store (the real action is exercised by the
// sidebar's own remove-folder path).
vi.mock("@/stores/tab-store", () => ({
  useTabStore: {
    getState: () => ({ closeTabsByFolder: h.closeTabsByFolder }),
  },
}))

vi.mock("@/lib/platform", () => ({
  // The provider registers four subscriptions — `conversation://changed`,
  // `conversations://bulk-changed`, `folder://changed` and
  // `folder-group://changed` — so route by exact channel and capture each
  // handler / dispose spy independently; the conversation-sync tests keep
  // asserting against `h.handler`/`h.disposeSpy` unchanged. Routing every
  // unmatched channel to `h.handler` would silently hand the newest
  // subscription the conversation tests' handler slot.
  subscribe: vi.fn(async (event: string, handler: (c: unknown) => void) => {
    if (event === "folder://changed") {
      h.folderHandler = handler
      return h.folderDisposeSpy
    }
    if (event === "folder-group://changed") {
      h.groupHandler = handler
      return h.groupDisposeSpy
    }
    if (event === "conversations://bulk-changed") {
      h.bulkHandler = handler
      return h.bulkDisposeSpy
    }
    h.handler = handler
    return h.disposeSpy
  }),
  // Both subscription effects register a reconnect backstop. The folder effect
  // runs after the conversation effect (later in the component body), so the
  // second registration is the folder one; distinct unsub spies keep each
  // subscription's cleanup independently assertable.
  onTransportReconnect: vi.fn((cb: () => void) => {
    if (h.reconnect == null) {
      h.reconnect = cb
      return h.reconnectUnsubSpy
    }
    h.folderReconnect = cb
    return h.folderReconnectUnsubSpy
  }),
}))

vi.mock("@/lib/api", () => ({
  listAllConversations: h.listAll,
  listAllFolderDetails: h.listAllFolders,
  listOpenFolderDetails: h.listOpenFolders,
  listFolderGroups: h.listFolderGroups,
  getGitBranch: vi.fn(async () => null),
  getGitHead: vi.fn(async () => ({
    is_repo: false,
    branch: null,
    detached: false,
    short_sha: null,
  })),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
  getFolder: vi.fn(),
}))

// The provider imports `useAcpEvent` only for the separate
// `ConversationStatusEventBridge` (not rendered here); stub the module so we
// don't pull in the heavy ACP context.
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: vi.fn(),
}))

function makeSummary(
  overrides: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
    parent_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    ...overrides,
  }
}

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number }
): FolderDetail {
  return {
    name: `folder-${overrides.id}`,
    path: `/repo/folder-${overrides.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: overrides.id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

// Subscribes via selectors the way real consumers do, so the assertions also
// exercise the store's slice reactivity (a missed notify would fail here).
function Probe() {
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const stats = useAppWorkspaceStore((s) => s.stats)
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  return (
    <div>
      <output data-testid="ids">
        {conversations.map((c) => c.id).join(",")}
      </output>
      <output data-testid="count">{conversations.length}</output>
      <output data-testid="statuses">
        {conversations.map((c) => `${c.id}:${c.status}`).join(",")}
      </output>
      <output data-testid="stat-total">
        {stats?.total_conversations ?? 0}
      </output>
      <output data-testid="stat-messages">{stats?.total_messages ?? 0}</output>
      <output data-testid="folder-ids">
        {folders.map((f) => f.id).join(",")}
      </output>
      <output data-testid="all-folder-ids">
        {allFolders.map((f) => f.id).join(",")}
      </output>
    </div>
  )
}

async function mountProvider() {
  const utils = render(
    <AppWorkspaceProvider>
      <Probe />
    </AppWorkspaceProvider>
  )
  // Flush mount effects: fetchFolders/refreshConversations + the async
  // subscribe() IIFE that captures the handler.
  await act(async () => {})
  return utils
}

function emit(change: ConversationChange) {
  act(() => {
    h.handler?.(change)
  })
}

function emitFolder(change: FolderChange) {
  act(() => {
    h.folderHandler?.(change)
  })
}

beforeEach(() => {
  h.handler = null
  h.folderHandler = null
  h.bulkHandler = null
  h.reconnect = null
  h.folderReconnect = null
  h.disposeSpy.mockClear()
  h.folderDisposeSpy.mockClear()
  h.bulkDisposeSpy.mockClear()
  h.groupDisposeSpy.mockClear()
  h.reconnectUnsubSpy.mockClear()
  h.folderReconnectUnsubSpy.mockClear()
  h.listAll.mockClear()
  h.listAll.mockResolvedValue([])
  h.listOpenFolders.mockClear()
  h.listOpenFolders.mockResolvedValue([])
  h.listAllFolders.mockClear()
  h.listAllFolders.mockResolvedValue([])
  h.closeTabsByFolder.mockClear()
  // The store is a module-level singleton: restore pristine state (including
  // the delete tombstones) so state can't leak between tests.
  resetAppWorkspaceStore()
})

describe("AppWorkspaceProvider conversation://changed sync", () => {
  it("registers a subscription and reconnect backstop on mount", async () => {
    await mountProvider()
    expect(h.handler).toBeTypeOf("function")
    expect(h.reconnect).toBeTypeOf("function")
  })

  it("inserts a new root conversation, prepending most-recent-first", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2 }) })
    expect(screen.getByTestId("ids")).toHaveTextContent("2,1")
    expect(screen.getByTestId("count")).toHaveTextContent("2")
    expect(screen.getByTestId("stat-total")).toHaveTextContent("2")
  })

  it("replaces an existing conversation in place (no reorder) and updates fields", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2 }) })
    // Re-upsert id 1 with a new status; it must keep its index (1), not jump.
    emit({
      kind: "upsert",
      summary: makeSummary({ id: 1, status: "pending_review" }),
    })
    expect(screen.getByTestId("ids")).toHaveTextContent("2,1")
    expect(screen.getByTestId("statuses")).toHaveTextContent(
      "2:in_progress,1:pending_review"
    )
  })

  it("ignores delegation children (parent_id set) — not sidebar rows", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 5, parent_id: 1 }) })
    expect(screen.getByTestId("ids")).toHaveTextContent("1")
    expect(screen.getByTestId("count")).toHaveTextContent("1")
  })

  it("removes on deleted and is idempotent for an unknown id", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2 }) })
    emit({ kind: "deleted", id: 1 })
    expect(screen.getByTestId("ids")).toHaveTextContent("2")
    emit({ kind: "deleted", id: 999 })
    expect(screen.getByTestId("ids")).toHaveTextContent("2")
    expect(screen.getByTestId("count")).toHaveTextContent("1")
  })

  it("does not resurrect a row when a stale upsert lands after a delete", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "deleted", id: 1 })
    expect(screen.getByTestId("count")).toHaveTextContent("0")
    // A stale/out-of-order upsert for the just-deleted id must be ignored —
    // ids are never reused, so the tombstone is authoritative.
    emit({
      kind: "upsert",
      summary: makeSummary({ id: 1, status: "pending_review" }),
    })
    expect(screen.getByTestId("count")).toHaveTextContent("0")
    expect(screen.getByTestId("ids").textContent).toBe("")
  })

  it("patches status for a known conversation and no-ops for an unknown one", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "status", id: 1, status: "pending_review" })
    expect(screen.getByTestId("statuses")).toHaveTextContent("1:pending_review")
    emit({ kind: "status", id: 999, status: "cancelled" })
    expect(screen.getByTestId("count")).toHaveTextContent("1")
    expect(screen.getByTestId("statuses")).toHaveTextContent("1:pending_review")
  })

  it("derives stats.total_messages from upserted message counts", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1, message_count: 3 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2, message_count: 4 }) })
    expect(screen.getByTestId("stat-total")).toHaveTextContent("2")
    expect(screen.getByTestId("stat-messages")).toHaveTextContent("7")
  })

  it("re-fetches the full list on transport reconnect (disconnect backstop)", async () => {
    await mountProvider()
    expect(h.listAll).toHaveBeenCalledTimes(1) // initial mount fetch
    await act(async () => {
      h.reconnect?.()
    })
    expect(h.listAll).toHaveBeenCalledTimes(2)
  })

  it("disposes the subscription and reconnect handler on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.disposeSpy).toHaveBeenCalledTimes(1)
    expect(h.reconnectUnsubSpy).toHaveBeenCalledTimes(1)
  })
})

describe("upsertFolder list routing", () => {
  it("seeds a chat folder into allFolders only — never the user-facing folders list", async () => {
    // Regression: the first chat send hands the backend-created hidden chat
    // folder to upsertFolder; putting it in `folders` rendered a "Chat" header
    // row in the sidebar until the next refetch/restart.
    await mountProvider()
    act(() => {
      useAppWorkspaceStore
        .getState()
        .upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat" }))
    })
    expect(screen.getByTestId("folder-ids").textContent).toBe("")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("7")
  })

  it("seeds a regular folder into both lists", async () => {
    await mountProvider()
    act(() => {
      useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 8 }))
    })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("8")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("8")
  })

  it("replaces an existing chat folder in allFolders in place", async () => {
    await mountProvider()
    const { upsertFolder } = useAppWorkspaceStore.getState()
    act(() => {
      upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat" }))
    })
    act(() => {
      upsertFolder(makeFolder({ id: 9, kind: "chat", name: "Chat" }))
    })
    act(() => {
      upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat 2" }))
    })
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("7,9")
    expect(screen.getByTestId("folder-ids").textContent).toBe("")
  })
})

describe("AppWorkspaceProvider conversations://bulk-changed sync", () => {
  it("answers a batch-import nudge with one full conversation refetch", async () => {
    await mountProvider()
    expect(h.bulkHandler).toBeTypeOf("function")
    expect(h.listAll).toHaveBeenCalledTimes(1) // initial mount fetch
    await act(async () => {
      h.bulkHandler?.({ imported: 3, updated: 1, folder_ids: [7] })
    })
    expect(h.listAll).toHaveBeenCalledTimes(2)
  })

  it("disposes the bulk subscription on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.bulkDisposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("AppWorkspaceProvider folder://changed sync", () => {
  it("registers a folder subscription + reconnect backstop on mount", async () => {
    await mountProvider()
    expect(h.folderHandler).toBeTypeOf("function")
    expect(h.folderReconnect).toBeTypeOf("function")
  })

  it("upserts a regular folder into both lists on a folder upsert event", async () => {
    // A headlessly-created worktree (e.g. an automation per-run worktree) must
    // land in `folders` (so a conversation inside it can be grouped/rendered)
    // and `allFolders` (cwd resolution) without a re-fetch.
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12, parent_id: 1 }) })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("12")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("12")
  })

  it("replaces an existing folder in place on a repeat upsert", async () => {
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12 }) })
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 13 }) })
    emitFolder({
      kind: "upsert",
      folder: makeFolder({ id: 12, name: "renamed" }),
    })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("12,13")
  })

  it("drops a folder from both lists on a folder delete event", async () => {
    // A task worktree removed after its merge must leave the sidebar right
    // away — otherwise it lingers until the next full `fetchFolders` (reload).
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12, parent_id: 1 }) })
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 13 }) })
    emitFolder({ kind: "deleted", id: 12 })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("13")
    expect(screen.getByTestId("folder-ids")).not.toHaveTextContent("12")
    expect(screen.getByTestId("all-folder-ids")).not.toHaveTextContent("12")
  })

  it("ignores a delete for a folder it never knew about", async () => {
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 13 }) })
    emitFolder({ kind: "deleted", id: 99 })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("13")
  })

  it("closes the folder's tabs alongside the removal", async () => {
    // The backend only deletes PERSISTED tabs; device-local drafts would
    // otherwise stay open on a cwd that no longer exists.
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12, parent_id: 1 }) })
    emitFolder({ kind: "deleted", id: 12 })
    expect(h.closeTabsByFolder).toHaveBeenCalledWith(12)
  })

  it("re-fetches folders on transport reconnect (disconnect backstop)", async () => {
    await mountProvider()
    // Mount already fetched folders once.
    expect(h.listOpenFolders).toHaveBeenCalledTimes(1)
    await act(async () => {
      h.folderReconnect?.()
    })
    expect(h.listOpenFolders).toHaveBeenCalledTimes(2)
    expect(h.listAllFolders).toHaveBeenCalledTimes(2)
  })

  it("disposes the folder subscription + reconnect handler on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.folderDisposeSpy).toHaveBeenCalledTimes(1)
    expect(h.folderReconnectUnsubSpy).toHaveBeenCalledTimes(1)
  })
})

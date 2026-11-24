import { afterEach, describe, expect, it } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type { FolderDetail } from "@/lib/types"

function makeFolder(id: number): FolderDetail {
  return {
    id,
    name: `folder-${id}`,
    path: `/repo/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
  }
}

// The keep-alive conversation panel (`ConversationTabView`) derives its folder
// from ITS OWN tab's `folderId`, never from the global `activeFolderId`. That is
// what decouples a background panel's re-renders from active-tab folder switches.
//
// This encodes the underlying store invariant the decoupling depends on:
// switching the active folder must NOT churn the folder objects in `allFolders`,
// so a folder-by-own-id derivation returns a stable reference across
// `setActiveFolderId` mutations (→ `useSyncExternalStore`/zustand bail out, no
// re-render for a panel pinned to a different folder).
describe("folder-by-own-id derivation is decoupled from activeFolderId", () => {
  afterEach(() => resetAppWorkspaceStore())

  const deriveOwnFolder = (ownFolderId: number | null) => {
    const s = useAppWorkspaceStore.getState()
    return ownFolderId != null
      ? (s.allFolders.find((f) => f.id === ownFolderId) ?? null)
      : null
  }

  it("keeps a stable folder reference when the active folder switches", () => {
    const f1 = makeFolder(1)
    const f2 = makeFolder(2)
    useAppWorkspaceStore.setState({ allFolders: [f1, f2] })

    useAppWorkspaceStore.getState().setActiveFolderId(1)
    const before = deriveOwnFolder(1)
    expect(before).toBe(f1)

    // Active tab switches to folder 2 — a background panel pinned to folder 1
    // must NOT see its derived folder change identity (else it would re-render).
    useAppWorkspaceStore.getState().setActiveFolderId(2)
    const after = deriveOwnFolder(1)
    expect(after).toBe(f1)
    expect(after).toBe(before)
  })

  it("resolves the panel's OWN folder, not the active one", () => {
    const f1 = makeFolder(1)
    const f2 = makeFolder(2)
    useAppWorkspaceStore.setState({ allFolders: [f1, f2] })
    useAppWorkspaceStore.getState().setActiveFolderId(1)
    // A panel pinned to folder 2 resolves folder 2 even while folder 1 is active.
    expect(deriveOwnFolder(2)).toBe(f2)
  })

  it("returns null for a folderless draft tab regardless of active folder", () => {
    useAppWorkspaceStore.setState({ allFolders: [makeFolder(1)] })
    useAppWorkspaceStore.getState().setActiveFolderId(1)
    expect(deriveOwnFolder(null)).toBeNull()
  })
})

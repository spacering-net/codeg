import { describe, expect, it } from "vitest"
import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"
import {
  applyLayoutMove,
  buildDragSlots,
  buildOwnerHeaderIndex,
  buildRows,
  buildSidebarLayout,
  layoutFolderIds,
  layoutFromOrderedIds,
  layoutToEntries,
  locateEntry,
  reconcileLayout,
  type SidebarLayout,
} from "./sidebar-conversation-grouping"

function folder(
  id: number,
  overrides: Partial<FolderDetail> = {}
): FolderDetail {
  return {
    id,
    name: `folder-${id}`,
    path: `/repo/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

function group(
  id: number,
  sortOrder: number,
  overrides: Partial<FolderGroupDetail> = {}
): FolderGroupDetail {
  return {
    id,
    name: `group-${id}`,
    color: "inherit",
    sort_order: sortOrder,
    ...overrides,
  }
}

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const createdAt = new Date(1_700_000_000_000 + id * 60_000).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    pinned_at: null,
    ...overrides,
  }
}

/** Compact `[kind:id, …]` view of a top-level sequence, for readable asserts. */
function topOf(layout: SidebarLayout): string[] {
  return layout.top.map((e) => `${e.kind}:${e.id}`)
}

describe("buildSidebarLayout", () => {
  it("interleaves groups and ungrouped folders by the shared sort_order space", () => {
    // The whole point of the shared numeric space: a group at 2 lands BETWEEN
    // the loose folders at 1 and 3, not before or after all of them.
    const layout = buildSidebarLayout({
      folders: [
        folder(1, { sort_order: 1 }),
        folder(9, { sort_order: 3 }),
        folder(5, { sort_order: 1, group_id: 7 }),
      ],
      groups: [group(7, 2)],
    })
    expect(topOf(layout)).toEqual(["folder:1", "group:7", "folder:9"])
    expect(layout.membersByGroup.get(7)).toEqual([5])
  })

  it("orders group members by their own 1..n sequence", () => {
    const layout = buildSidebarLayout({
      folders: [
        folder(5, { sort_order: 2, group_id: 7 }),
        folder(6, { sort_order: 1, group_id: 7 }),
      ],
      groups: [group(7, 1)],
    })
    expect(layout.membersByGroup.get(7)).toEqual([6, 5])
  })

  it("keeps an empty group visible", () => {
    // A group is empty the instant it is created, and it is the thing you drag
    // folders INTO — dropping it from the layout would make it unreachable.
    const layout = buildSidebarLayout({ folders: [], groups: [group(7, 1)] })
    expect(topOf(layout)).toEqual(["group:7"])
    expect(layout.membersByGroup.get(7)).toEqual([])
  })

  it("falls a folder back to the top level when its group is gone", () => {
    // Another window deleted the group between the two snapshots. Hiding the
    // folder would make it vanish from the sidebar because of a race; showing
    // it in the wrong slot for one frame is far cheaper.
    const layout = buildSidebarLayout({
      folders: [folder(5, { sort_order: 1, group_id: 999 })],
      groups: [],
    })
    expect(topOf(layout)).toEqual(["folder:5"])
    expect(layout.membersByGroup.size).toBe(0)
  })

  it("breaks sort_order ties deterministically (group first, then id)", () => {
    const layout = buildSidebarLayout({
      folders: [folder(2, { sort_order: 1 }), folder(1, { sort_order: 1 })],
      groups: [group(7, 1)],
    })
    expect(topOf(layout)).toEqual(["group:7", "folder:1", "folder:2"])
  })
})

describe("layoutToEntries", () => {
  it("inlines each group's members right after their group", () => {
    const layout = buildSidebarLayout({
      folders: [
        folder(1, { sort_order: 1 }),
        folder(5, { sort_order: 1, group_id: 7 }),
        folder(6, { sort_order: 2, group_id: 7 }),
      ],
      groups: [group(7, 2)],
    })
    expect(layoutToEntries(layout)).toEqual([
      { kind: "folder", id: 1, groupId: null },
      { kind: "group", id: 7, groupId: null },
      { kind: "folder", id: 5, groupId: 7 },
      { kind: "folder", id: 6, groupId: 7 },
    ])
  })

  it("round-trips through buildSidebarLayout unchanged", () => {
    // The backend assigns 1..n per container from exactly this order, so
    // re-reading its own write must produce the same layout — otherwise a drop
    // would drift on every replay.
    const layout = buildSidebarLayout({
      folders: [
        folder(1, { sort_order: 1 }),
        folder(5, { sort_order: 1, group_id: 7 }),
        folder(6, { sort_order: 2, group_id: 7 }),
      ],
      groups: [group(7, 2)],
    })
    const entries = layoutToEntries(layout)
    const perContainer = new Map<number | null, number>()
    const rebuiltFolders: FolderDetail[] = []
    const rebuiltGroups: FolderGroupDetail[] = []
    for (const entry of entries) {
      const container = entry.kind === "group" ? null : entry.groupId
      const next = (perContainer.get(container) ?? 0) + 1
      perContainer.set(container, next)
      if (entry.kind === "group") rebuiltGroups.push(group(entry.id, next))
      else
        rebuiltFolders.push(
          folder(entry.id, { sort_order: next, group_id: entry.groupId })
        )
    }
    const rebuilt = buildSidebarLayout({
      folders: rebuiltFolders,
      groups: rebuiltGroups,
    })
    expect(topOf(rebuilt)).toEqual(topOf(layout))
    expect(rebuilt.membersByGroup.get(7)).toEqual(layout.membersByGroup.get(7))
  })
})

describe("layoutFolderIds / locateEntry", () => {
  const layout = buildSidebarLayout({
    folders: [
      folder(1, { sort_order: 1 }),
      folder(5, { sort_order: 1, group_id: 7 }),
      folder(6, { sort_order: 2, group_id: 7 }),
    ],
    groups: [group(7, 2)],
  })

  it("lists every placed folder, top level and members alike", () => {
    expect(layoutFolderIds(layout)).toEqual([1, 5, 6])
  })

  it("locates entries in whichever container holds them", () => {
    expect(locateEntry(layout, { kind: "folder", id: 1 })).toEqual({
      groupId: null,
      index: 0,
    })
    expect(locateEntry(layout, { kind: "folder", id: 6 })).toEqual({
      groupId: 7,
      index: 1,
    })
    expect(locateEntry(layout, { kind: "group", id: 7 })).toEqual({
      groupId: null,
      index: 1,
    })
    expect(locateEntry(layout, { kind: "folder", id: 404 })).toBeNull()
  })
})

describe("applyLayoutMove", () => {
  const base = buildSidebarLayout({
    folders: [
      folder(1, { sort_order: 1 }),
      folder(9, { sort_order: 3 }),
      folder(5, { sort_order: 1, group_id: 7 }),
      folder(6, { sort_order: 2, group_id: 7 }),
    ],
    groups: [group(7, 2)],
  })
  // top: [folder:1, group:7, folder:9]; group 7: [5, 6]

  it("reorders at the top level", () => {
    const next = applyLayoutMove(base, { kind: "folder", id: 9 }, null, 0)
    expect(topOf(next)).toEqual(["folder:9", "folder:1", "group:7"])
    // Untouched container keeps its identity, so memoized rows can bail out.
    expect(next.membersByGroup).toBe(base.membersByGroup)
  })

  it("reorders within a group without touching the top level", () => {
    const next = applyLayoutMove(base, { kind: "folder", id: 6 }, 7, 0)
    expect(next.membersByGroup.get(7)).toEqual([6, 5])
    expect(next.top).toBe(base.top)
  })

  it("drags a folder INTO a group", () => {
    const next = applyLayoutMove(base, { kind: "folder", id: 1 }, 7, 0)
    expect(topOf(next)).toEqual(["group:7", "folder:9"])
    expect(next.membersByGroup.get(7)).toEqual([1, 5, 6])
  })

  it("drags a folder OUT of a group", () => {
    const next = applyLayoutMove(base, { kind: "folder", id: 5 }, null, 0)
    expect(topOf(next)).toEqual(["folder:5", "folder:1", "group:7", "folder:9"])
    expect(next.membersByGroup.get(7)).toEqual([6])
  })

  it("appends when the target index is past the end", () => {
    const next = applyLayoutMove(base, { kind: "folder", id: 5 }, null, 99)
    expect(topOf(next)).toEqual(["folder:1", "group:7", "folder:9", "folder:5"])
  })

  it("moves a whole group, members riding along", () => {
    const next = applyLayoutMove(base, { kind: "group", id: 7 }, null, 0)
    expect(topOf(next)).toEqual(["group:7", "folder:1", "folder:9"])
    expect(next.membersByGroup.get(7)).toEqual([5, 6])
  })

  it("treats an unknown target group as the top level", () => {
    // A group deleted mid-drag must not strand the folder in a container that
    // no longer renders.
    const next = applyLayoutMove(base, { kind: "folder", id: 5 }, 999, 0)
    expect(topOf(next)).toEqual(["folder:5", "folder:1", "group:7", "folder:9"])
    expect(next.membersByGroup.get(7)).toEqual([6])
  })

  it("returns the input unchanged for an entry it doesn't hold", () => {
    expect(applyLayoutMove(base, { kind: "folder", id: 404 }, null, 0)).toBe(
      base
    )
    expect(applyLayoutMove(base, { kind: "group", id: 404 }, null, 0)).toBe(
      base
    )
  })
})

describe("reconcileLayout", () => {
  it("drops entries the authoritative layout no longer has", () => {
    const candidate = buildSidebarLayout({
      folders: [folder(1), folder(2), folder(5, { group_id: 7 })],
      groups: [group(7, 3)],
    })
    // Folder 2 was closed and group 7 deleted while the drag was in flight.
    const authoritative = buildSidebarLayout({
      folders: [folder(1), folder(5)],
      groups: [],
    })
    const merged = reconcileLayout(candidate, authoritative)
    expect(topOf(merged)).toEqual(["folder:1", "folder:5"])
  })

  it("appends entries that appeared since the drag began", () => {
    const candidate = buildSidebarLayout({
      folders: [folder(2, { sort_order: 1 }), folder(1, { sort_order: 2 })],
      groups: [],
    })
    const authoritative = buildSidebarLayout({
      folders: [folder(1), folder(2), folder(3)],
      groups: [group(7, 9)],
    })
    const merged = reconcileLayout(candidate, authoritative)
    // The candidate's ORDER survives for what it knew about; the newcomers land
    // at the end rather than being lost or reordering the drag.
    expect(topOf(merged)).toEqual([
      "folder:2",
      "folder:1",
      "folder:3",
      "group:7",
    ])
    expect(merged.membersByGroup.get(7)).toEqual([])
  })

  it("adds a folder that joined a group elsewhere", () => {
    const candidate = buildSidebarLayout({
      folders: [folder(5, { group_id: 7 })],
      groups: [group(7, 1)],
    })
    const authoritative = buildSidebarLayout({
      folders: [folder(5, { group_id: 7 }), folder(6, { group_id: 7 })],
      groups: [group(7, 1)],
    })
    const merged = reconcileLayout(candidate, authoritative)
    expect(merged.membersByGroup.get(7)).toEqual([5, 6])
  })

  it("never lists a folder twice when it moved container mid-drag", () => {
    // The candidate has folder 5 at the top level (the user dragged it out);
    // the authoritative snapshot still has it inside group 7. It must appear
    // exactly once, honouring the candidate's placement.
    const candidate: SidebarLayout = {
      top: [
        { kind: "folder", id: 5 },
        { kind: "group", id: 7 },
      ],
      membersByGroup: new Map([[7, []]]),
    }
    const authoritative = buildSidebarLayout({
      folders: [folder(5, { group_id: 7 })],
      groups: [group(7, 1)],
    })
    const merged = reconcileLayout(candidate, authoritative)
    expect(topOf(merged)).toEqual(["folder:5", "group:7"])
    expect(merged.membersByGroup.get(7)).toEqual([])
    expect(layoutFolderIds(merged)).toEqual([5])
  })
})

describe("buildDragSlots", () => {
  const layout = buildSidebarLayout({
    folders: [
      folder(1, { sort_order: 1 }),
      folder(9, { sort_order: 3 }),
      folder(5, { sort_order: 1, group_id: 7 }),
      folder(6, { sort_order: 2, group_id: 7 }),
    ],
    groups: [group(7, 2), group(8, 4)],
  })
  // top: [folder:1, group:7, folder:9, group:8]; 7: [5,6]; 8: []

  it("collapses groups to one row when dragging a group", () => {
    const slots = buildDragSlots(layout, { kind: "group", id: 7 })
    expect(slots.map((s) => s.render)).toEqual([
      { kind: "folder", id: 1, depth: 0 },
      { kind: "group", id: 7 },
      { kind: "folder", id: 9, depth: 0 },
      { kind: "group", id: 8 },
    ])
    // Every drop is a top-level reposition — groups never nest.
    expect(slots.map((s) => s.target)).toEqual([
      { groupId: null, index: 0 },
      { groupId: null, index: 1 },
      { groupId: null, index: 2 },
      { groupId: null, index: 3 },
    ])
  })

  it("expands every group when dragging a folder, even a collapsed one", () => {
    const slots = buildDragSlots(layout, { kind: "folder", id: 1 })
    expect(slots.map((s) => s.render)).toEqual([
      { kind: "folder", id: 1, depth: 0 },
      { kind: "group", id: 7 },
      { kind: "folder", id: 5, depth: 1 },
      { kind: "folder", id: 6, depth: 1 },
      { kind: "folder", id: 9, depth: 0 },
      { kind: "group", id: 8 },
    ])
  })

  it("makes a group's own heading the drop-into-it target", () => {
    // Also the ONLY way into an empty group (8) or a collapsed one.
    const slots = buildDragSlots(layout, { kind: "folder", id: 1 })
    expect(slots[1].target).toEqual({ groupId: 7, index: 0 })
    expect(slots[5].target).toEqual({ groupId: 8, index: 0 })
  })

  it("targets a member slot at its position inside the group", () => {
    const slots = buildDragSlots(layout, { kind: "folder", id: 1 })
    expect(slots[2].target).toEqual({ groupId: 7, index: 0 })
    expect(slots[3].target).toEqual({ groupId: 7, index: 1 })
  })

  it("adds a trailing ungroup zone only for a folder inside a group", () => {
    const grouped = buildDragSlots(layout, { kind: "folder", id: 5 })
    expect(grouped[grouped.length - 1]).toEqual({
      render: { kind: "ungroup" },
      target: { groupId: null, index: layout.top.length },
    })
    // A top-level folder already has plenty of top-level rows to aim at, and a
    // "remove from group" row would be a lie there.
    const loose = buildDragSlots(layout, { kind: "folder", id: 1 })
    expect(loose.some((s) => s.render.kind === "ungroup")).toBe(false)
  })

  it("routes a drop on the ungroup zone to the end of the top level", () => {
    const slots = buildDragSlots(layout, { kind: "folder", id: 5 })
    const ungroup = slots[slots.length - 1]
    const next = applyLayoutMove(
      layout,
      { kind: "folder", id: 5 },
      ungroup.target.groupId,
      ungroup.target.index
    )
    const top = topOf(next)
    expect(top[top.length - 1]).toBe("folder:5")
    expect(next.membersByGroup.get(7)).toEqual([6])
  })
})

describe("buildRows with folder groups", () => {
  const baseArgs = {
    pinned: [],
    pinnedExpanded: true,
    byFolder: new Map<number, DbConversationSummary[]>(),
    folderExpanded: {},
    folderTotalCounts: new Map<number, number>(),
    foldersExpanded: true,
    chatConversations: [],
    chatsExpanded: true,
  }

  const layout = buildSidebarLayout({
    folders: [
      folder(1, { sort_order: 1 }),
      folder(5, { sort_order: 1, group_id: 7 }),
    ],
    groups: [group(7, 2)],
  })

  it("emits a group header followed by its members", () => {
    const rows = buildRows({
      ...baseArgs,
      orderedFolderIds: [1, 5],
      byFolder: new Map([
        [1, [conv(11, 1)]],
        [5, [conv(51, 5)]],
      ]),
      layout,
    })
    expect(rows.map((r) => r.kind)).toEqual([
      "section", // Folders
      "folder", // 1
      "conversation", // 11
      "folder-group", // 7
      "folder", // 5
      "conversation", // 51
      "section", // Chat
      "chats-empty",
    ])
  })

  it("indents a group member's conversations one level", () => {
    const rows = buildRows({
      ...baseArgs,
      orderedFolderIds: [1, 5],
      byFolder: new Map([
        [1, [conv(11, 1)]],
        [5, [conv(51, 5)]],
      ]),
      layout,
    })
    const depths = rows
      .filter((r) => r.kind === "conversation")
      .map((r) => (r.kind === "conversation" ? r.depth : -1))
    // Top-level folder's conversation at 0, the grouped folder's at 1.
    expect(depths).toEqual([0, 1])
  })

  it("emits a group-empty hint for an expanded empty group", () => {
    const rows = buildRows({
      ...baseArgs,
      orderedFolderIds: [],
      layout: buildSidebarLayout({ folders: [], groups: [group(7, 1)] }),
    })
    expect(rows.map((r) => r.kind)).toEqual([
      "section",
      "folder-group",
      "group-empty",
      "section",
      "chats-empty",
    ])
  })

  it("hides a collapsed group's members", () => {
    const rows = buildRows({
      ...baseArgs,
      orderedFolderIds: [1, 5],
      layout,
      groupExpanded: { 7: false },
    })
    expect(rows.map((r) => r.kind)).toEqual([
      "section",
      "folder",
      "empty",
      "folder-group",
      "section",
      "chats-empty",
    ])
    const header = rows.find((r) => r.kind === "folder-group")
    expect(header).toEqual({
      kind: "folder-group",
      groupId: 7,
      expanded: false,
    })
  })

  it("counts FOLDERS, not top-level entries, on the section header", () => {
    const rows = buildRows({
      ...baseArgs,
      orderedFolderIds: [1, 5],
      layout,
    })
    expect(rows[0]).toMatchObject({ section: "folders", count: 2 })
  })

  it("produces the pre-groups row model when no layout is given", () => {
    // The regression guard: every existing caller and test passes only
    // `orderedFolderIds`, and must keep getting byte-identical output.
    const args = {
      ...baseArgs,
      orderedFolderIds: [1, 5],
      byFolder: new Map([
        [1, [conv(11, 1)]],
        [5, [conv(51, 5)]],
      ]),
    }
    expect(buildRows(args)).toEqual(
      buildRows({ ...args, layout: layoutFromOrderedIds([1, 5]) })
    )
  })
})

describe("buildOwnerHeaderIndex with folder groups", () => {
  it("ends the previous folder's span at a group header", () => {
    // Otherwise the folder above a group would keep its sticky header pinned
    // over the group's band, which belongs to no folder at all.
    const rows = buildRows({
      pinned: [],
      pinnedExpanded: true,
      orderedFolderIds: [1, 5],
      byFolder: new Map([[1, [conv(11, 1)]]]),
      folderExpanded: {},
      folderTotalCounts: new Map(),
      foldersExpanded: true,
      chatConversations: [],
      chatsExpanded: true,
      layout: buildSidebarLayout({
        folders: [
          folder(1, { sort_order: 1 }),
          folder(5, { sort_order: 1, group_id: 7 }),
        ],
        groups: [group(7, 2)],
      }),
    })
    const owners = buildOwnerHeaderIndex(rows)
    const groupRowIndex = rows.findIndex((r) => r.kind === "folder-group")
    expect(owners[groupRowIndex]).toBe(-1)
    // The member folder's own header takes over immediately after.
    expect(owners[groupRowIndex + 1]).toBe(groupRowIndex + 1)
  })
})

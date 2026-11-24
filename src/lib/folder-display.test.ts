import { describe, expect, it } from "vitest"
import {
  excludeChatFolders,
  filterTopLevelFolders,
  formatFolderLabelWithAlias,
  resolveFolderDisplayName,
  resolvePickerSelectedFolderId,
} from "@/lib/folder-display"

const folders = [
  { id: 1, name: "myproject" },
  { id: 2, name: "myproject-feature-x" },
]

describe("resolveFolderDisplayName", () => {
  it("returns the folder's own name for a top-level (non-worktree) folder", () => {
    expect(
      resolveFolderDisplayName({ name: "myproject", parent_id: null }, folders)
    ).toBe("myproject")
  })

  it("returns the parent (root repo) name for a worktree folder", () => {
    expect(
      resolveFolderDisplayName(
        { name: "myproject-feature-x", parent_id: 1 },
        folders
      )
    ).toBe("myproject")
  })

  it("falls back to the folder's own name when the parent is absent", () => {
    expect(
      resolveFolderDisplayName(
        { name: "myproject-feature-x", parent_id: 99 },
        folders
      )
    ).toBe("myproject-feature-x")
  })

  it("falls back when the folder list is empty", () => {
    expect(resolveFolderDisplayName({ name: "wt", parent_id: 1 }, [])).toBe(
      "wt"
    )
  })
})

describe("filterTopLevelFolders", () => {
  it("keeps only folders without a parent_id (drops worktrees)", () => {
    const list = [
      { id: 1, parent_id: null },
      { id: 2, parent_id: 1 },
      { id: 3, parent_id: null },
      { id: 4, parent_id: 3 },
    ]
    expect(filterTopLevelFolders(list).map((f) => f.id)).toEqual([1, 3])
  })

  it("returns all folders when none are worktrees", () => {
    const list = [
      { id: 1, parent_id: null },
      { id: 2, parent_id: null },
    ]
    expect(filterTopLevelFolders(list)).toHaveLength(2)
  })
})

describe("excludeChatFolders", () => {
  it("drops hidden chat folders, keeping real ones", () => {
    const list = [
      { id: 1, kind: "regular" as const },
      { id: 2, kind: "chat" as const },
      { id: 3, kind: "regular" as const },
    ]
    expect(excludeChatFolders(list).map((f) => f.id)).toEqual([1, 3])
  })

  it("drops the personal agent's working directory too", () => {
    const list = [
      { id: 1, kind: "regular" as const },
      { id: 2, kind: "personal" as const },
    ]
    expect(excludeChatFolders(list).map((f) => f.id)).toEqual([1])
  })

  it("returns all folders when none are chat folders", () => {
    const list = [
      { id: 1, kind: "regular" as const },
      { id: 2, kind: "regular" as const },
    ]
    expect(excludeChatFolders(list)).toHaveLength(2)
  })
})

describe("resolvePickerSelectedFolderId", () => {
  it("returns the folder's own id for a top-level folder", () => {
    expect(resolvePickerSelectedFolderId({ id: 5, parent_id: null })).toBe(5)
  })

  it("returns the parent id for a worktree folder", () => {
    expect(resolvePickerSelectedFolderId({ id: 7, parent_id: 3 })).toBe(3)
  })
})

describe("formatFolderLabelWithAlias", () => {
  it("renders `alias [ name ]` (spaced) when an alias is set", () => {
    expect(
      formatFolderLabelWithAlias({ name: "codeg", alias: "My Project" })
    ).toBe("My Project [ codeg ]")
  })

  it("falls back to the bare name when alias is null", () => {
    expect(formatFolderLabelWithAlias({ name: "codeg", alias: null })).toBe(
      "codeg"
    )
  })

  it("treats an empty / whitespace-only alias as unset", () => {
    expect(formatFolderLabelWithAlias({ name: "codeg", alias: "   " })).toBe(
      "codeg"
    )
  })

  it("trims surrounding whitespace from the alias", () => {
    expect(
      formatFolderLabelWithAlias({ name: "codeg", alias: "  Work  " })
    ).toBe("Work [ codeg ]")
  })
})

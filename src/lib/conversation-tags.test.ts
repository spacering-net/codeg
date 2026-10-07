import { describe, expect, it } from "vitest"
import {
  EMPTY_TAG_FILTER,
  TAG_COLOR_PRESETS,
  TAG_COLOR_STRONG_COUNT,
  compareTags,
  findTagByName,
  matchesTagFilter,
  normalizeTagColor,
  pickNextTagColor,
  pruneTagFilter,
  resolveTags,
  tagFitsScope,
  tagScopeFolderId,
  toggleTagInFilter,
  type TagFilter,
} from "./conversation-tags"
import type { ConversationTagDetail } from "./types"

function tag(
  id: number,
  overrides: Partial<ConversationTagDetail> = {}
): ConversationTagDetail {
  return {
    id,
    folder_id: null,
    name: `tag-${id}`,
    color: "#cf222e",
    sort_order: id,
    ...overrides,
  }
}

describe("pickNextTagColor", () => {
  it("takes the first strong preset the scope does not use yet", () => {
    expect(pickNextTagColor([])).toBe(TAG_COLOR_PRESETS[0])
    expect(
      pickNextTagColor([
        tag(1, { color: TAG_COLOR_PRESETS[0] }),
        tag(2, { color: TAG_COLOR_PRESETS[1].toUpperCase() }),
      ])
    ).toBe(TAG_COLOR_PRESETS[2])
  })

  it("cycles through the strong row once every one is taken", () => {
    const strong = TAG_COLOR_PRESETS.slice(0, TAG_COLOR_STRONG_COUNT)
    const taken = strong.map((color, i) => tag(i + 1, { color }))
    // Never hands out a soft-row colour by default.
    expect(strong).toContain(pickNextTagColor(taken))
  })
})

describe("normalizeTagColor", () => {
  it("accepts #rgb and #rrggbb in any case, as lowercase #rrggbb", () => {
    expect(normalizeTagColor("#ABC")).toBe("#aabbcc")
    expect(normalizeTagColor(" #D73A4A ")).toBe("#d73a4a")
  })

  it("refuses everything the backend would", () => {
    for (const bad of ["d73a4a", "#d73a4", "#d73a4aff", "red", "", "#ggg"]) {
      expect(normalizeTagColor(bad)).toBeNull()
    }
  })
})

describe("tag scope", () => {
  it("is the root folder for a regular folder and none for chat", () => {
    expect(tagScopeFolderId({ id: 5, parent_id: null, kind: "regular" })).toBe(
      5
    )
    // A worktree child is offered its repo's tags.
    expect(tagScopeFolderId({ id: 9, parent_id: 5, kind: "regular" })).toBe(5)
    expect(tagScopeFolderId({ id: 7, parent_id: null, kind: "chat" })).toBe(
      null
    )
    expect(tagScopeFolderId(undefined)).toBe(null)
  })

  it("lets global tags fit everywhere and folder tags only at home", () => {
    expect(tagFitsScope(tag(1), null)).toBe(true)
    expect(tagFitsScope(tag(1), 5)).toBe(true)
    expect(tagFitsScope(tag(2, { folder_id: 5 }), 5)).toBe(true)
    expect(tagFitsScope(tag(2, { folder_id: 5 }), 6)).toBe(false)
    expect(tagFitsScope(tag(2, { folder_id: 5 }), null)).toBe(false)
  })
})

describe("resolveTags", () => {
  it("drops ids this client does not know and orders global first", () => {
    const byId = new Map(
      [
        tag(1, { folder_id: 3, sort_order: 1 }),
        tag(2, { sort_order: 2 }),
        tag(3, { sort_order: 1 }),
      ].map((t) => [t.id, t])
    )
    expect(resolveTags([1, 2, 3, 99], byId).map((t) => t.id)).toEqual([3, 2, 1])
  })

  it("hands back one shared empty list for nothing to show", () => {
    const byId = new Map([[1, tag(1)]])
    const a = resolveTags(undefined, byId)
    expect(a).toEqual([])
    // Same reference for every empty answer, so a memoized row stays put.
    expect(resolveTags([], byId)).toBe(a)
    expect(resolveTags([42], byId)).toBe(a)
  })
})

describe("compareTags", () => {
  it("breaks sort_order ties on id", () => {
    const list = [tag(4, { sort_order: 1 }), tag(2, { sort_order: 1 })]
    expect(list.sort(compareTags).map((t) => t.id)).toEqual([2, 4])
  })
})

describe("findTagByName", () => {
  it("matches case-insensitively within one scope only", () => {
    const tags = [
      tag(1, { name: "Bug" }),
      tag(2, { name: "Bug", folder_id: 7 }),
    ]
    expect(findTagByName(tags, null, " bug ")?.id).toBe(1)
    expect(findTagByName(tags, 7, "BUG")?.id).toBe(2)
    expect(findTagByName(tags, 8, "bug")).toBeUndefined()
    expect(findTagByName(tags, null, "  ")).toBeUndefined()
  })
})

describe("tag filter", () => {
  const filter = (tagIds: number[], mode: TagFilter["mode"] = "any") => ({
    tagIds,
    mode,
  })

  it("passes everything while empty", () => {
    expect(matchesTagFilter({}, EMPTY_TAG_FILTER)).toBe(true)
    expect(matchesTagFilter({ tag_ids: [1] }, EMPTY_TAG_FILTER)).toBe(true)
  })

  it("matches any or all of the selection", () => {
    const conv = { tag_ids: [1, 2] }
    expect(matchesTagFilter(conv, filter([2, 3]))).toBe(true)
    expect(matchesTagFilter(conv, filter([2, 3], "all"))).toBe(false)
    expect(matchesTagFilter(conv, filter([1, 2], "all"))).toBe(true)
    // An untagged conversation never matches an active filter.
    expect(matchesTagFilter({}, filter([1]))).toBe(false)
  })

  it("prunes ids of deleted tags, and keeps the object when nothing went", () => {
    const byId = new Map([
      [1, tag(1)],
      [2, tag(2)],
    ])
    const kept = filter([1, 2], "all")
    expect(pruneTagFilter(kept, byId)).toBe(kept)
    expect(pruneTagFilter(filter([1, 9], "all"), byId)).toEqual(
      filter([1], "all")
    )
  })

  it("toggles one tag in and out, keeping the pick order", () => {
    const a = toggleTagInFilter(filter([3]), 1)
    expect(a.tagIds).toEqual([3, 1])
    expect(toggleTagInFilter(a, 3).tagIds).toEqual([1])
  })
})

import { beforeEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_SECTION_ORDER,
  SIDEBAR_NAV_ITEM_IDS,
  SIDEBAR_RECENT_FILTERS,
  isNavItemVisible,
  loadNavItemVisibility,
  loadRecentFilter,
  loadSectionCollapsed,
  loadSectionOrder,
  loadShowRecent,
  loadTagFilter,
  moveSectionInOrder,
  normalizeSectionOrder,
  saveNavItemVisibility,
  saveRecentFilter,
  saveSectionOrder,
  saveShowRecent,
  saveTagFilter,
  type SidebarRecentFilter,
} from "./sidebar-view-mode-storage"

const SECTION_ORDER_KEY = "workspace:sidebar-section-order"
const SHOW_RECENT_KEY = "workspace:sidebar-show-recent"
const RECENT_FILTER_KEY = "workspace:sidebar-recent-filter"
const TAG_FILTER_KEY = "workspace:sidebar-tag-filter"
const NAV_ITEMS_KEY = "workspace:sidebar-nav-items"

describe("normalizeSectionOrder", () => {
  it("passes a complete order through unchanged", () => {
    expect(normalizeSectionOrder(["recent", "chats", "folders"])).toEqual([
      "recent",
      "chats",
      "folders",
    ])
  })

  it("appends missing sections in default order", () => {
    // Forward compatibility in reverse: a store written before "Recent" existed
    // gets it at the bottom rather than losing the section entirely.
    expect(normalizeSectionOrder(["chats", "folders"])).toEqual([
      "chats",
      "folders",
      "recent",
    ])
  })

  it("drops unknown entries and repeats", () => {
    expect(
      normalizeSectionOrder(["recent", "bogus", "recent", 7, null, "chats"])
    ).toEqual(["recent", "chats", "folders"])
  })

  it("migrates the legacy two-way strings, preserving the user's choice", () => {
    expect(normalizeSectionOrder("chats-first")).toEqual([
      "chats",
      "folders",
      "recent",
    ])
    expect(normalizeSectionOrder("folders-first")).toEqual(
      DEFAULT_SECTION_ORDER
    )
  })

  it("falls back to the default for anything unusable", () => {
    expect(normalizeSectionOrder(undefined)).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder("nonsense")).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder({ folders: 1 })).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder([])).toEqual(DEFAULT_SECTION_ORDER)
  })
})

describe("moveSectionInOrder", () => {
  const order = ["folders", "chats", "recent"] as const

  it("moves a section one slot in either direction", () => {
    expect(moveSectionInOrder(order, "recent", -1)).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(moveSectionInOrder(order, "folders", 1)).toEqual([
      "chats",
      "folders",
      "recent",
    ])
  })

  it("moves across multiple slots", () => {
    expect(moveSectionInOrder(order, "recent", -2)).toEqual([
      "recent",
      "folders",
      "chats",
    ])
  })

  it("returns the SAME reference for a move that would fall off an end", () => {
    // Identity matters: the sidebar skips the state update and the localStorage
    // write when a clamped nudge changes nothing.
    expect(moveSectionInOrder(order, "folders", -1)).toBe(order)
    expect(moveSectionInOrder(order, "recent", 1)).toBe(order)
    expect(moveSectionInOrder(order, "chats", 0)).toBe(order)
  })
})

describe("section-order persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips through localStorage", () => {
    saveSectionOrder(["recent", "folders", "chats"])
    expect(loadSectionOrder()).toEqual(["recent", "folders", "chats"])
  })

  it("defaults to Folders → Chat → Recent with nothing stored", () => {
    expect(loadSectionOrder()).toEqual(["folders", "chats", "recent"])
  })

  it("migrates a legacy bare string left by an older build", () => {
    // The old format was not JSON, so the loader must survive the parse failure
    // rather than resetting the user's preference.
    localStorage.setItem(SECTION_ORDER_KEY, "chats-first")
    expect(loadSectionOrder()).toEqual(["chats", "folders", "recent"])
  })

  it("falls back to the default for corrupt JSON", () => {
    localStorage.setItem(SECTION_ORDER_KEY, "{oops")
    expect(loadSectionOrder()).toEqual(DEFAULT_SECTION_ORDER)
  })
})

describe("loadShowRecent", () => {
  beforeEach(() => localStorage.clear())

  it("defaults to on", () => {
    expect(loadShowRecent()).toBe(true)
  })

  it("respects an explicitly-stored false", () => {
    saveShowRecent(false)
    expect(localStorage.getItem(SHOW_RECENT_KEY)).toBe("false")
    expect(loadShowRecent()).toBe(false)
    saveShowRecent(true)
    expect(loadShowRecent()).toBe(true)
  })
})

describe("loadRecentFilter", () => {
  beforeEach(() => localStorage.clear())

  it("defaults to all with nothing stored", () => {
    expect(loadRecentFilter()).toBe("all")
  })

  it("round-trips every filter", () => {
    // Spelled out rather than read from SIDEBAR_RECENT_FILTERS, so dropping a
    // filter from that list fails here instead of quietly testing fewer.
    const filters: SidebarRecentFilter[] = ["all", "chats", "folders", "cli"]
    expect([...SIDEBAR_RECENT_FILTERS]).toEqual(filters)
    for (const filter of filters) {
      saveRecentFilter(filter)
      expect(localStorage.getItem(RECENT_FILTER_KEY)).toBe(filter)
      expect(loadRecentFilter()).toBe(filter)
    }
  })

  it("reads anything it does not recognise as all", () => {
    // Garbage, an empty string, a different case, or a value some future build
    // wrote: none may narrow the list to something the menu cannot show.
    for (const raw of ["bogus", "", "Chats", "archived"]) {
      localStorage.setItem(RECENT_FILTER_KEY, raw)
      expect(loadRecentFilter()).toBe("all")
    }
  })
})

describe("loadSectionCollapsed", () => {
  beforeEach(() => localStorage.clear())

  it("reads the recent section's collapsed flag", () => {
    localStorage.setItem(
      "workspace:sidebar-section-collapsed",
      JSON.stringify({ recent: true, chats: false, bogus: 1 })
    )
    expect(loadSectionCollapsed()).toEqual({ recent: true, chats: false })
  })
})

describe("sidebar nav items", () => {
  beforeEach(() => localStorage.clear())

  it("lists the route rows top to bottom, Harness after the canvas", () => {
    expect(SIDEBAR_NAV_ITEM_IDS).toEqual([
      "automations",
      "tasks",
      "forge",
      "canvas",
      "harness",
    ])
  })

  it("names every row from the sidebar's own messages", () => {
    // Each id doubles as its `Folder.sidebar` key: the row, its visibility
    // toggle and the quick-actions entry all read the label through it.
    const labels: Record<string, unknown> = enMessages.Folder.sidebar
    for (const id of SIDEBAR_NAV_ITEM_IDS) {
      expect(typeof labels[id]).toBe("string")
    }
    expect(enMessages.Folder.sidebar.harness).toBe("Harness Engineering")
  })

  it("shows a row unless it was explicitly hidden", () => {
    for (const id of SIDEBAR_NAV_ITEM_IDS) {
      expect(isNavItemVisible({}, id)).toBe(true)
      expect(isNavItemVisible({ [id]: true }, id)).toBe(true)
      expect(isNavItemVisible({ [id]: false }, id)).toBe(false)
    }
  })

  it("shows everything with nothing stored", () => {
    expect(loadNavItemVisibility()).toEqual({})
  })

  it("round-trips a hidden Harness row", () => {
    saveNavItemVisibility({ harness: false })
    expect(JSON.parse(localStorage.getItem(NAV_ITEMS_KEY) ?? "")).toEqual({
      harness: false,
    })
    expect(loadNavItemVisibility()).toEqual({ harness: false })
    expect(isNavItemVisible(loadNavItemVisibility(), "harness")).toBe(false)

    saveNavItemVisibility({ harness: true })
    expect(isNavItemVisible(loadNavItemVisibility(), "harness")).toBe(true)
  })

  it("shows Harness to a store written before the row existed", () => {
    // Only explicit choices are stored, so an older store has no entry for a
    // newer route — and no entry means shown.
    localStorage.setItem(
      NAV_ITEMS_KEY,
      JSON.stringify({ automations: false, canvas: true })
    )
    const stored = loadNavItemVisibility()

    expect(stored).toEqual({ automations: false, canvas: true })
    expect(isNavItemVisible(stored, "harness")).toBe(true)
    expect(isNavItemVisible(stored, "automations")).toBe(false)
  })

  it("drops entries it does not recognise", () => {
    localStorage.setItem(
      NAV_ITEMS_KEY,
      JSON.stringify({ retired: false, harness: false, tasks: "no" })
    )
    expect(loadNavItemVisibility()).toEqual({ harness: false })
  })

  it("reads corrupt storage as nothing hidden", () => {
    for (const raw of ["{not json", "null", '"harness"', "[]"]) {
      localStorage.setItem(NAV_ITEMS_KEY, raw)
      expect(loadNavItemVisibility()).toEqual({})
    }
  })
})

describe("tag filter persistence", () => {
  beforeEach(() => localStorage.clear())

  it("is empty with nothing stored", () => {
    expect(loadTagFilter()).toEqual({ tagIds: [], mode: "any" })
  })

  it("round-trips a selection and its mode", () => {
    saveTagFilter({ tagIds: [3, 1], mode: "all" })
    expect(loadTagFilter()).toEqual({ tagIds: [3, 1], mode: "all" })
  })

  it("clears the entry rather than storing an empty selection", () => {
    saveTagFilter({ tagIds: [3], mode: "all" })
    saveTagFilter({ tagIds: [], mode: "all" })
    expect(localStorage.getItem(TAG_FILTER_KEY)).toBeNull()
    expect(loadTagFilter()).toEqual({ tagIds: [], mode: "any" })
  })

  it("reads anything malformed as no filter, never as a hidden one", () => {
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ tagIds: "1,2" }),
      JSON.stringify({ tagIds: [0, -2, 1.5, "3"] }),
    ]) {
      localStorage.setItem(TAG_FILTER_KEY, raw)
      expect(loadTagFilter()).toEqual({ tagIds: [], mode: "any" })
    }
  })

  it("keeps the valid ids of a partly bad entry, de-duplicated", () => {
    localStorage.setItem(
      TAG_FILTER_KEY,
      JSON.stringify({ tagIds: [4, "x", 4, 9], mode: "weird" })
    )
    expect(loadTagFilter()).toEqual({ tagIds: [4, 9], mode: "any" })
  })
})

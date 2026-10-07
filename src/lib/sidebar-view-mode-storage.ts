"use client"

import { EMPTY_TAG_FILTER, type TagFilter } from "@/lib/conversation-tags"

const FOLDER_EXPANDED_KEY = "workspace:sidebar-folder-expanded"
const FOLDER_GROUP_EXPANDED_KEY = "workspace:sidebar-folder-group-expanded"
const SHOW_COMPLETED_KEY = "workspace:sidebar-show-completed"
const SHOW_WORKTREES_KEY = "workspace:sidebar-show-worktrees"
const SHOW_RECENT_KEY = "workspace:sidebar-show-recent"
const RECENT_FILTER_KEY = "workspace:sidebar-recent-filter"
const NAV_ITEMS_KEY = "workspace:sidebar-nav-items"
const SORT_MODE_KEY = "workspace:sidebar-sort-mode"
const SECTION_ORDER_KEY = "workspace:sidebar-section-order"
const SECTION_COLLAPSED_KEY = "workspace:sidebar-section-collapsed"
const CONVERSATION_EXPANDED_KEY = "workspace:sidebar-conversation-expanded"
const TAG_FILTER_KEY = "workspace:sidebar-tag-filter"

export type SidebarSortMode = "created" | "updated"

/** Which conversations the flat "Recent" section lists: everything it can
 *  reach (the default), only folderless chats, or only folder-bound sessions. */
export const SIDEBAR_RECENT_FILTERS = ["all", "chats", "folders"] as const

export type SidebarRecentFilter = (typeof SIDEBAR_RECENT_FILTERS)[number]

export const DEFAULT_RECENT_FILTER: SidebarRecentFilter = "all"

/** The reorderable top-level sidebar sections. "Pinned" is deliberately absent:
 *  it is a transient override bucket and always stays on top. */
export const SIDEBAR_SECTION_IDS = ["folders", "chats", "recent"] as const

export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number]

/** Every section that can own a header row — the always-on-top "Pinned" bucket
 *  plus the reorderable ones, in render order. The one list every all-sections
 *  operation walks (collapse/expand all, {@link loadSectionCollapsed}), so a
 *  section added to {@link SIDEBAR_SECTION_IDS} is picked up by all of them
 *  rather than silently missed by whichever one forgot to grow a branch. */
export const SIDEBAR_SECTION_KEYS = ["pinned", ...SIDEBAR_SECTION_IDS] as const

export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]

/**
 * Vertical order of the reorderable sidebar sections, top to bottom. Always a
 * full permutation of {@link SIDEBAR_SECTION_IDS} — {@link normalizeSectionOrder}
 * guarantees that on the way in, so no section can ever go missing from the
 * list or the reorder menu. The Pinned section (when present) always stays on
 * top regardless.
 */
export type SidebarSectionOrder = readonly SidebarSectionId[]

/** Folders, then Chat, then Recent — the historical layout with the (newest)
 *  Recent section appended at the bottom. */
export const DEFAULT_SECTION_ORDER: SidebarSectionOrder = SIDEBAR_SECTION_IDS

/** Collapsed state of the top-level sidebar sections. Absent key = expanded
 *  (the default), so a fresh user sees every section open. */
export interface SidebarSectionCollapsed {
  pinned?: boolean
  folders?: boolean
  chats?: boolean
  recent?: boolean
}

/**
 * The optional route rows in the sidebar's fixed nav block, top to bottom.
 * Every id is BOTH a `WorkbenchRouteId` and a `Folder.sidebar` message key, so
 * one list drives the rows, their labels and their visibility toggles.
 *
 * "New chat" is deliberately absent: it is the block's primary action rather
 * than navigation, and it is the one row with no equivalent elsewhere in the
 * chrome. Adding a future route here gives it a toggle for free.
 */
export const SIDEBAR_NAV_ITEM_IDS = [
  "automations",
  "tasks",
  "forge",
  "canvas",
] as const

export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number]

/** Which optional nav rows are switched off. Absent key = shown (the default),
 *  mirroring {@link SidebarSectionCollapsed}: only rows the user explicitly
 *  hid are persisted, so a store written before a route existed still shows
 *  that route. */
export type SidebarNavItemVisibility = Partial<
  Record<SidebarNavItemId, boolean>
>

/** Absent = visible; only an explicitly-stored `false` hides a row. */
export function isNavItemVisible(
  visibility: SidebarNavItemVisibility,
  id: SidebarNavItemId
): boolean {
  return visibility[id] !== false
}

function isSectionId(value: unknown): value is SidebarSectionId {
  return (SIDEBAR_SECTION_IDS as readonly unknown[]).includes(value)
}

/**
 * Coerce an arbitrary stored value into a full, duplicate-free permutation of
 * {@link SIDEBAR_SECTION_IDS}.
 *
 * Accepts three shapes:
 * - an array of section ids (the current format) — unknown entries and repeats
 *   are dropped, and any section the array omits is appended in default order.
 *   That last step is what makes adding a NEW section forward-compatible: an
 *   older store simply gets it at the bottom instead of losing it.
 * - the legacy pre-Recent strings `"folders-first"` / `"chats-first"`, so a
 *   user's existing top/bottom choice survives the upgrade.
 * - anything else (corrupt / absent) → {@link DEFAULT_SECTION_ORDER}.
 */
export function normalizeSectionOrder(value: unknown): SidebarSectionOrder {
  if (value === "chats-first") return ["chats", "folders", "recent"]
  if (value === "folders-first") return DEFAULT_SECTION_ORDER
  if (!Array.isArray(value)) return DEFAULT_SECTION_ORDER
  const seen = new Set<SidebarSectionId>()
  const out: SidebarSectionId[] = []
  for (const entry of value) {
    if (!isSectionId(entry) || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

/**
 * Move `id` by `delta` slots (negative = towards the top), returning a new
 * order. A move that would fall off either end — or that names an id not in the
 * order — returns the SAME array reference, so a no-op never re-renders the
 * sidebar or rewrites localStorage.
 */
export function moveSectionInOrder(
  order: SidebarSectionOrder,
  id: SidebarSectionId,
  delta: number
): SidebarSectionOrder {
  const from = order.indexOf(id)
  if (from < 0) return order
  const to = from + delta
  if (to < 0 || to >= order.length || to === from) return order
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export function loadFolderExpanded(): Record<number, boolean> {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(FOLDER_EXPANDED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const result: Record<number, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k)
      if (!Number.isNaN(id) && typeof v === "boolean") {
        result[id] = v
      }
    }
    return result
  } catch {
    return {}
  }
}

export function saveFolderExpanded(state: Record<number, boolean>): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/** Collapsed state of the sidebar's folder GROUPS, keyed by group id. Absent
 *  key = expanded, mirroring {@link loadFolderExpanded}: a freshly created group
 *  is open, and a group whose row is closed is the only thing persisted. Kept
 *  device-local (localStorage, not the DB) for the same reason folder collapse
 *  is — it is a view preference, not shared workspace state. */
export function loadFolderGroupExpanded(): Record<number, boolean> {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(FOLDER_GROUP_EXPANDED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const result: Record<number, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k)
      if (!Number.isNaN(id) && typeof v === "boolean") {
        result[id] = v
      }
    }
    return result
  } catch {
    return {}
  }
}

export function saveFolderGroupExpanded(state: Record<number, boolean>): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(FOLDER_GROUP_EXPANDED_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/** Ids of conversations whose delegation sub-session subtree is expanded. Stored
 *  as a flat array (not a Record) because the default is COLLAPSED — only the
 *  expanded ids are persisted, keeping storage bounded by what the user actually
 *  opened (unlike folders, which default to expanded). */
export function loadConversationExpanded(): number[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(CONVERSATION_EXPANDED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const result: number[] = []
    for (const v of parsed) {
      if (typeof v === "number" && Number.isFinite(v)) result.push(v)
    }
    return result
  } catch {
    return []
  }
}

export function saveConversationExpanded(ids: number[]): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CONVERSATION_EXPANDED_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

/** Whether completed conversations are shown in the sidebar list. Defaults to
 *  OFF so finished/imported sessions stay out of the way; only an
 *  explicitly-stored "true" (the user turned it on) reveals them. */
export function loadShowCompleted(): boolean {
  if (typeof window === "undefined") return false
  try {
    const raw = localStorage.getItem(SHOW_COMPLETED_KEY)
    if (raw === "true") return true
    if (raw === "false") return false
  } catch {
    /* ignore */
  }
  return false
}

export function saveShowCompleted(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SHOW_COMPLETED_KEY, String(value))
  } catch {
    /* ignore */
  }
}

/** Whether the sidebar splits each repo's worktree child folders into their own
 *  indented sub-groups (instead of merging them flat into the parent group).
 *  Defaults to ON; only an explicitly-stored "false" (the user unchecked it)
 *  falls back to the flattened layout. */
export function loadShowWorktrees(): boolean {
  if (typeof window === "undefined") return true
  try {
    const raw = localStorage.getItem(SHOW_WORKTREES_KEY)
    if (raw === "false") return false
    if (raw === "true") return true
  } catch {
    /* ignore */
  }
  return true
}

export function saveShowWorktrees(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SHOW_WORKTREES_KEY, String(value))
  } catch {
    /* ignore */
  }
}

/** Whether the flat "Recent" section — every conversation, folder-bound or
 *  chat, newest first — is shown. Defaults to ON; only an explicitly-stored
 *  "false" (the user unchecked it) hides the section. Its POSITION is a
 *  separate preference ({@link loadSectionOrder}), so hiding and re-showing it
 *  keeps the slot the user chose. */
export function loadShowRecent(): boolean {
  if (typeof window === "undefined") return true
  try {
    const raw = localStorage.getItem(SHOW_RECENT_KEY)
    if (raw === "false") return false
    if (raw === "true") return true
  } catch {
    /* ignore */
  }
  return true
}

export function saveShowRecent(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SHOW_RECENT_KEY, String(value))
  } catch {
    /* ignore */
  }
}

/** The Recent section's kind filter. Anything but a known value — absent,
 *  garbage, a value from a future version — reads as "all". */
export function loadRecentFilter(): SidebarRecentFilter {
  if (typeof window === "undefined") return DEFAULT_RECENT_FILTER
  try {
    const raw = localStorage.getItem(RECENT_FILTER_KEY)
    if ((SIDEBAR_RECENT_FILTERS as readonly string[]).includes(raw ?? "")) {
      return raw as SidebarRecentFilter
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_RECENT_FILTER
}

export function saveRecentFilter(value: SidebarRecentFilter): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(RECENT_FILTER_KEY, value)
  } catch {
    /* ignore */
  }
}

export function loadNavItemVisibility(): SidebarNavItemVisibility {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(NAV_ITEMS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const obj = parsed as Record<string, unknown>
    const result: SidebarNavItemVisibility = {}
    // Read through the known ids rather than copying the object: a stale entry
    // for a route that no longer exists is dropped instead of lingering.
    for (const id of SIDEBAR_NAV_ITEM_IDS) {
      if (typeof obj[id] === "boolean") result[id] = obj[id]
    }
    return result
  } catch {
    return {}
  }
}

export function saveNavItemVisibility(state: SidebarNavItemVisibility): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(NAV_ITEMS_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

export function loadSortMode(): SidebarSortMode {
  if (typeof window === "undefined") return "created"
  try {
    const raw = localStorage.getItem(SORT_MODE_KEY)
    if (raw === "updated" || raw === "created") return raw
  } catch {
    /* ignore */
  }
  return "created"
}

export function saveSortMode(value: SidebarSortMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SORT_MODE_KEY, value)
  } catch {
    /* ignore */
  }
}

export function loadSectionOrder(): SidebarSectionOrder {
  if (typeof window === "undefined") return DEFAULT_SECTION_ORDER
  try {
    const raw = localStorage.getItem(SECTION_ORDER_KEY)
    if (!raw) return DEFAULT_SECTION_ORDER
    // Current format is a JSON array; the legacy pre-Recent format was a bare
    // `folders-first` / `chats-first` string, which is not valid JSON — fall
    // back to the raw string so `normalizeSectionOrder` can migrate it.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
    return normalizeSectionOrder(parsed)
  } catch {
    /* ignore */
  }
  return DEFAULT_SECTION_ORDER
}

export function saveSectionOrder(value: SidebarSectionOrder): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

export function loadSectionCollapsed(): SidebarSectionCollapsed {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const obj = parsed as Record<string, unknown>
    const result: SidebarSectionCollapsed = {}
    for (const key of SIDEBAR_SECTION_KEYS) {
      if (typeof obj[key] === "boolean") result[key] = obj[key]
    }
    return result
  } catch {
    return {}
  }
}

export function saveSectionCollapsed(state: SidebarSectionCollapsed): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SECTION_COLLAPSED_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/**
 * The sidebar's tag filter. Persisted like the other view preferences, and
 * read defensively: anything malformed — a value from a future version, a
 * hand-edited entry — reads as "no filter" rather than hiding conversations
 * for a reason nobody can see. Ids naming tags that no longer exist are kept
 * here and dropped by the caller once the tag list is known (`pruneTagFilter`).
 */
export function loadTagFilter(): TagFilter {
  if (typeof window === "undefined") return EMPTY_TAG_FILTER
  try {
    const raw = localStorage.getItem(TAG_FILTER_KEY)
    if (!raw) return EMPTY_TAG_FILTER
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return EMPTY_TAG_FILTER
    const obj = parsed as Record<string, unknown>
    const ids = Array.isArray(obj.tagIds)
      ? obj.tagIds.filter(
          (id): id is number => Number.isInteger(id) && (id as number) > 0
        )
      : []
    const tagIds = [...new Set(ids)]
    if (tagIds.length === 0) return EMPTY_TAG_FILTER
    return { tagIds, mode: obj.mode === "all" ? "all" : "any" }
  } catch {
    return EMPTY_TAG_FILTER
  }
}

export function saveTagFilter(filter: TagFilter): void {
  if (typeof window === "undefined") return
  try {
    if (filter.tagIds.length === 0) {
      // Nothing selected IS the default; don't leave a stale mode behind.
      localStorage.removeItem(TAG_FILTER_KEY)
      return
    }
    localStorage.setItem(
      TAG_FILTER_KEY,
      JSON.stringify({ tagIds: filter.tagIds, mode: filter.mode })
    )
  } catch {
    /* ignore */
  }
}

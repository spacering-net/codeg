/**
 * The Discover section's state, and the loads that fill it.
 *
 * All of it lives in slots (`harness-slots.ts`), so it outlives the page:
 * the search text, the filters, the results loaded so far, how far the list
 * was scrolled and the item that is open are all still there after a trip to
 * a conversation and back.
 *
 * The loads are plain functions over the slot store rather than hooks, for
 * the same reason: a request started just before the page is left still has
 * somewhere to land, and the page comes back to its answer instead of to a
 * spinner nobody is driving.
 *
 * Every load carries the number of the request it was started as, and writes
 * nothing if the slot has moved on to a newer one — the catalog answers a
 * fast typist's queries in whatever order it likes, and only the last one
 * asked may be shown.
 */
import {
  defineHarnessSlot,
  type HarnessSlot,
  type HarnessSlotStore,
} from "@/lib/harness-slots"
import {
  harnessConfig,
  harnessItem,
  harnessList,
  harnessPrompt,
  harnessReadme,
  harnessVersions,
} from "./api"
import { harnessFailureOf, type HarnessFailure } from "./errors"
import { parseItemRef } from "./item-ref"
import { promptTextOf } from "./prompt"
import { refreshHarnessStatus } from "./status"
import {
  HARNESS_LIST_KINDS,
  type HarnessConfig,
  type HarnessItemDetail,
  type HarnessItemSummary,
  type HarnessListKind,
  type HarnessListQuery,
  type HarnessSort,
  type HarnessVersionSummary,
} from "./types"

// ─── Filters ──────────────────────────────────────────────────────────

/**
 * The kind switch: every kind, or one. "All" is what makes an address pasted
 * into the search box find its item whatever kind it is.
 */
export const DISCOVER_KIND_FILTERS = ["all", ...HARNESS_LIST_KINDS] as const

export type DiscoverKindFilter = "all" | HarnessListKind

/** What the controls above the list hold. */
export interface DiscoverFilters {
  /** The search box, as typed — applied to the list a moment later. */
  text: string
  kind: DiscoverKindFilter
  /** A tag id from the catalog's configuration, or `null` for any. */
  tag: string | null
  /** A runtime id, or `null` for any. */
  runtime: string | null
  sort: HarnessSort
}

export const DEFAULT_DISCOVER_FILTERS: DiscoverFilters = {
  text: "",
  kind: "all",
  tag: null,
  runtime: null,
  sort: "popular",
}

/** What a list was asked for: the filters, with the text as it was sent. */
export interface DiscoverQuery {
  q: string
  kind: DiscoverKindFilter
  tag: string | null
  runtime: string | null
  sort: HarnessSort
}

export function discoverQueryOf(filters: DiscoverFilters): DiscoverQuery {
  return {
    q: filters.text.trim(),
    kind: filters.kind,
    tag: filters.tag,
    runtime: filters.runtime,
    sort: filters.sort,
  }
}

export function sameDiscoverQuery(a: DiscoverQuery, b: DiscoverQuery): boolean {
  return (
    a.q === b.q &&
    a.kind === b.kind &&
    a.tag === b.tag &&
    a.runtime === b.runtime &&
    // Matches come best first whatever the sort says, so while there is text
    // the sort is not part of the question.
    (a.q !== "" || a.sort === b.sort)
  )
}

function listArgs(query: DiscoverQuery, cursor?: string): HarnessListQuery {
  return {
    q: query.q || undefined,
    kind: query.kind === "all" ? undefined : query.kind,
    tag: query.tag ?? undefined,
    runtime: query.runtime ?? undefined,
    sort: query.q ? undefined : query.sort,
    cursor,
  }
}

// ─── Slots ────────────────────────────────────────────────────────────

/** Something fetched on its own, with its own failure: the versions and the
 *  description of an item, the catalog's configuration. */
export interface Loadable<T> {
  phase: "idle" | "loading" | "ready" | "error"
  value: T | null
  error: HarnessFailure | null
  request: number
}

function idle<T>(): Loadable<T> {
  return { phase: "idle", value: null, error: null, request: 0 }
}

export interface DiscoverListState {
  /** The question these results answer; `null` before the first load. */
  query: DiscoverQuery | null
  phase: "idle" | "loading" | "ready" | "error"
  /** While a new first page loads, still the previous answer's items. */
  items: HarnessItemSummary[]
  /** The cursor of the next page; `null` on the last one. */
  next: string | null
  approxTotal: number | null
  error: HarnessFailure | null
  /** The next page's load, which fails without taking the list with it. */
  more: { phase: "idle" | "loading" | "error"; error: HarnessFailure | null }
  /** How many items the last page added — what gets announced. */
  lastAdded: number
  /** The first-page request these results belong to. */
  request: number
}

const IDLE_MORE: DiscoverListState["more"] = { phase: "idle", error: null }

export interface DiscoverDetailState {
  /** The address that was asked for. Shown as given when it is not one. */
  ref: string
  phase: "loading" | "ready" | "error"
  /** What the list already knew of the item: its heading can be drawn while
   *  the rest is on its way. */
  preview: HarnessItemSummary | null
  item: HarnessItemDetail | null
  error: HarnessFailure | null
  versions: Loadable<HarnessVersionSummary[]>
  /** The description's HTML fragment, as text; `null` for none. */
  readme: Loadable<string>
  /**
   * A prompt's text, asked for on its own (`harness_prompt`) only when the
   * item did not carry it — a catalog older or newer than this build. Idle
   * for every other item.
   */
  prompt: Loadable<string>
  request: number
}

/** The parts of the open item that are fetched on their own after it. */
export type DiscoverDetailLoadPart = "versions" | "readme" | "prompt"

export const DISCOVER_FILTERS = defineHarnessSlot<DiscoverFilters>(
  "discover",
  () => DEFAULT_DISCOVER_FILTERS
)

export const DISCOVER_LIST = defineHarnessSlot<DiscoverListState>(
  "discover",
  () => ({
    query: null,
    phase: "idle",
    items: [],
    next: null,
    approxTotal: null,
    error: null,
    more: IDLE_MORE,
    lastAdded: 0,
    request: 0,
  })
)

/** How far the list is scrolled, in pixels. Written on scroll and read once,
 *  on the way back in: nothing renders from it. */
export const DISCOVER_LIST_SCROLL = defineHarnessSlot<number>(
  "discover",
  () => 0
)

/** The open item, or `null` while the list is on show. */
export const DISCOVER_DETAIL = defineHarnessSlot<DiscoverDetailState | null>(
  "discover",
  () => null
)

/** The open item's scroll offset — as for the list. */
export const DISCOVER_DETAIL_SCROLL = defineHarnessSlot<number>(
  "discover",
  () => 0
)

/**
 * The parts of the open item the user has expanded: a description (or an
 * assistant's instructions) past its fold, the file and version lists past
 * their first rows, a prompt's text past its fold, a prompt's results past
 * the first twelve, and an example's commentary, by the example's place.
 */
export type DiscoverDetailPart =
  | "readme"
  | "files"
  | "versions"
  | "prompt"
  | "showcases"
  | `why-${number}`

/**
 * Which of the open item's long parts are shown in full: a description past
 * its fold, a file or version list past its first rows. Kept here rather than
 * in the components because it decides how tall the detail is, and the
 * offset the detail is put back at is only right for that height.
 */
export const DISCOVER_DETAIL_EXPANDED = defineHarnessSlot<
  readonly DiscoverDetailPart[]
>("discover", () => [])

/** The address of the item whose detail was just closed: the list gives its
 *  card the focus back, once, and clears this — or, when the way back led to
 *  another detail, that detail gives it to its link to the item. */
export const DISCOVER_RETURN_FOCUS = defineHarnessSlot<string | null>(
  "discover",
  () => null
)

/** A detail the open one was reached from, kept as it was left. */
export interface DiscoverTrailStep {
  detail: DiscoverDetailState
  scroll: number
  expanded: readonly DiscoverDetailPart[]
}

/**
 * The way back through details opened from other details — an assistant, then
 * a skill it loads — nearest last. Back from such a detail returns to the one
 * it was opened from, scrolled and unfolded as it was, rather than to the
 * list; opening an item any other way starts the way back afresh.
 */
export const DISCOVER_DETAIL_TRAIL = defineHarnessSlot<
  readonly DiscoverTrailStep[]
>("discover", () => [])

/** How far back the way back reaches. Only an assistant links to other
 *  items, and none of them links on, so one step is all it takes today. */
const TRAIL_LIMIT = 8

/**
 * "Save as quick message" on the open prompt: where it got to. Kept here
 * rather than in the button so that a save started just before the page was
 * left still lands, and its outcome is still said when the page comes back —
 * a line that vanished would also move the detail under a restored offset.
 */
export interface DiscoverQuickMessageState {
  /** The item it was saved from. */
  ref: string
  /**
   * Which save this is. An answer is written only over its own save: the
   * same item can be opened afresh and saved again while an earlier save is
   * still on its way, and that one's answer must not speak for this one.
   */
  op: number
  /** `tooLong`: more than a quick message takes; nothing was sent. */
  phase: "saving" | "saved" | "error" | "tooLong"
  /** `error`: what went wrong, in the backend's own words. */
  detail: string
}

export const DISCOVER_QUICK_MESSAGE =
  defineHarnessSlot<DiscoverQuickMessageState | null>("discover", () => null)

/** The catalog's configuration: where the tag and runtime filters come from. */
export const DISCOVER_CONFIG = defineHarnessSlot<Loadable<HarnessConfig>>(
  "discover",
  idle
)

/** How many items the catalog holds of each kind — and in all — whatever the
 *  search and the filters say. Shown on the kind switch and in the heading. */
export type DiscoverKindTotals = Partial<Record<DiscoverKindFilter, number>>

export const DISCOVER_KIND_TOTALS = defineHarnessSlot<
  Loadable<DiscoverKindTotals>
>("discover", idle)

/** How the results are laid out: cards in a grid, or rows in a list. */
export type DiscoverLayout = "grid" | "list"

const LAYOUT_KEY = "workspace:harness-discover-layout"

function loadDiscoverLayout(): DiscoverLayout {
  if (typeof window === "undefined") return "grid"
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"
  } catch {
    return "grid"
  }
}

/** Remembered on this device, like the section the page was left on. */
export const DISCOVER_LAYOUT = defineHarnessSlot<DiscoverLayout>(
  "discover",
  loadDiscoverLayout
)

export function setDiscoverLayout(
  slots: HarnessSlotStore,
  layout: DiscoverLayout
): void {
  slots.set(DISCOVER_LAYOUT, layout)
  try {
    localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    /* ignore */
  }
}

// ─── Requests ─────────────────────────────────────────────────────────

// One counter for every load and every store. Kept outside the slots on
// purpose: resetting the section puts a slot's `request` back to 0, and a
// number handed out again would let an answer from before the reset pass for
// the one asked after it.
let lastRequest = 0
const newRequest = () => ++lastRequest

/**
 * A failure that says something about the host rather than about one request:
 * the catalog was switched off, or the backend turns out to be too old. The
 * status is asked again, which is what takes the section away or puts the
 * "update Codeg" message in its place.
 */
function noteFailure(failure: HarnessFailure): void {
  if (failure.kind === "disabled" || failure.kind === "unsupported") {
    void refreshHarnessStatus()
  }
}

// ─── The list ─────────────────────────────────────────────────────────

/** Connectors are in the catalog but not offered by this version, and a list
 *  of every kind would include them. */
function shown(items: HarnessItemSummary[]): HarnessItemSummary[] {
  return items.filter((item) => item.kind !== "connector")
}

/** Load the first page for `query`, replacing whatever the list holds. */
export async function loadDiscoverList(
  slots: HarnessSlotStore,
  query: DiscoverQuery
): Promise<void> {
  const request = newRequest()
  slots.set(
    DISCOVER_LIST,
    (prev): DiscoverListState => ({
      ...prev,
      query,
      phase: "loading",
      // The previous answer stays on screen (dimmed) until this one lands,
      // rather than the list emptying on every keystroke. No further page is
      // fetched for it meanwhile.
      items: prev.phase === "error" ? [] : prev.items,
      next: null,
      error: null,
      more: IDLE_MORE,
      lastAdded: 0,
      request,
    })
  )
  slots.set(DISCOVER_LIST_SCROLL, 0)
  const current = () => slots.get(DISCOVER_LIST).request === request
  try {
    const page = await harnessList(listArgs(query))
    if (!current()) return
    slots.set(
      DISCOVER_LIST,
      (prev): DiscoverListState => ({
        ...prev,
        phase: "ready",
        items: shown(page.items),
        next: page.next,
        approxTotal: page.approxTotal,
      })
    )
  } catch (error) {
    if (!current()) return
    const failure = harnessFailureOf(error)
    slots.set(
      DISCOVER_LIST,
      (prev): DiscoverListState => ({
        ...prev,
        phase: "error",
        items: [],
        next: null,
        approxTotal: null,
        error: failure,
      })
    )
    noteFailure(failure)
  }
}

/**
 * Bring the list in line with the filters: load when nothing was loaded yet
 * or the filters ask a different question; otherwise leave it as it is. With
 * `retry`, a list that failed is asked for again too — on the way back into
 * the page, where the connection may have returned since.
 */
export function ensureDiscoverList(
  slots: HarnessSlotStore,
  options: { retry?: boolean } = {}
): void {
  const query = discoverQueryOf(slots.get(DISCOVER_FILTERS))
  const list = slots.get(DISCOVER_LIST)
  const upToDate =
    list.query !== null &&
    sameDiscoverQuery(list.query, query) &&
    list.phase !== "idle" &&
    !(options.retry && list.phase === "error")
  if (!upToDate) void loadDiscoverList(slots, query)
}

/** Ask for the current question again, whatever state the list is in. */
export function reloadDiscoverList(slots: HarnessSlotStore): void {
  void loadDiscoverList(slots, discoverQueryOf(slots.get(DISCOVER_FILTERS)))
}

/** Change filters and apply them at once. The search text has its own path
 *  ({@link setDiscoverText}) because it is applied after a pause. */
export function applyDiscoverFilters(
  slots: HarnessSlotStore,
  patch: Partial<DiscoverFilters>
): void {
  slots.set(DISCOVER_FILTERS, (prev) => ({ ...prev, ...patch }))
  ensureDiscoverList(slots)
}

/** The search box's text. Only remembered: the caller decides when it is
 *  applied (`ensureDiscoverList`). */
export function setDiscoverText(slots: HarnessSlotStore, text: string): void {
  slots.set(DISCOVER_FILTERS, (prev) =>
    prev.text === text ? prev : { ...prev, text }
  )
}

/** Load the page after the last one, if there is one and none is loading. */
export async function loadMoreDiscover(slots: HarnessSlotStore): Promise<void> {
  const list = slots.get(DISCOVER_LIST)
  if (
    list.phase !== "ready" ||
    list.query === null ||
    list.next === null ||
    list.more.phase === "loading"
  ) {
    return
  }
  const { request, next: cursor, query } = list
  slots.set(
    DISCOVER_LIST,
    (prev): DiscoverListState => ({
      ...prev,
      more: { phase: "loading", error: null },
    })
  )
  // Still the same first page, and still waiting for this very cursor.
  const current = () => {
    const now = slots.get(DISCOVER_LIST)
    return now.request === request && now.next === cursor
  }
  try {
    const page = await harnessList(listArgs(query, cursor))
    if (!current()) return
    slots.set(DISCOVER_LIST, (prev): DiscoverListState => {
      const seen = new Set(prev.items.map((item) => item.id))
      // A ranking that shifted between two pages can repeat an item.
      const added = shown(page.items).filter((item) => !seen.has(item.id))
      return {
        ...prev,
        items: [...prev.items, ...added],
        // A cursor that leads back to itself would be asked for forever.
        next: page.next === cursor ? null : page.next,
        approxTotal: page.approxTotal ?? prev.approxTotal,
        more: IDLE_MORE,
        lastAdded: added.length,
      }
    })
  } catch (error) {
    if (!current()) return
    const failure = harnessFailureOf(error)
    slots.set(
      DISCOVER_LIST,
      (prev): DiscoverListState => ({
        ...prev,
        more: { phase: "error", error: failure },
      })
    )
    noteFailure(failure)
  }
}

// ─── The open item ────────────────────────────────────────────────────

/** One of the open item's `Loadable` parts, loaded with the stale-answer
 *  check built in: it writes nothing once another item is open, or once a
 *  newer load of the same part has begun. */
async function loadDetailPart<T>(
  slots: HarnessSlotStore,
  detailRequest: number,
  key: DiscoverDetailLoadPart,
  fetch: () => Promise<T | null>
): Promise<void> {
  const request = newRequest()
  const write = (part: Omit<Loadable<T>, "request">, starting = false) => {
    slots.set(DISCOVER_DETAIL, (prev) => {
      if (!prev || prev.request !== detailRequest) return prev
      if (!starting && prev[key].request !== request) return prev
      // `key` and `T` are paired by the two callers below, which is more
      // than the type of a computed key can say.
      return { ...prev, [key]: { ...part, request } } as DiscoverDetailState
    })
  }
  write({ phase: "loading", value: null, error: null }, true)
  try {
    const value = await fetch()
    write({ phase: "ready", value, error: null })
  } catch (error) {
    const failure = harnessFailureOf(error)
    write({ phase: "error", value: null, error: failure })
    noteFailure(failure)
  }
}

function loadVersions(
  slots: HarnessSlotStore,
  detailRequest: number,
  ref: string
): Promise<void> {
  return loadDetailPart(slots, detailRequest, "versions", () =>
    harnessVersions(ref)
  )
}

function loadReadme(
  slots: HarnessSlotStore,
  detailRequest: number,
  ref: string
): Promise<void> {
  return loadDetailPart(slots, detailRequest, "readme", () =>
    harnessReadme(ref)
  )
}

function loadPromptText(
  slots: HarnessSlotStore,
  detailRequest: number,
  ref: string
): Promise<void> {
  return loadDetailPart(slots, detailRequest, "prompt", () =>
    harnessPrompt(ref)
  )
}

const PART_LOADS: Record<
  DiscoverDetailLoadPart,
  (slots: HarnessSlotStore, detailRequest: number, ref: string) => Promise<void>
> = { versions: loadVersions, readme: loadReadme, prompt: loadPromptText }

export interface OpenDiscoverItemOptions {
  /**
   * What becomes of the way back (`DISCOVER_DETAIL_TRAIL`). `push`: the item
   * is opened from the detail on show, which is kept to come back to — a
   * skill an assistant loads. `keep`: the same item is asked for again. By
   * default the way back starts afresh: the item came from the list, or from
   * outside.
   */
  trail?: "push" | "keep"
}

/**
 * Open an item's detail. `input` is an address from anywhere — a card, a
 * link, `openHarness` — so one that is not an address is not asked for: the
 * detail opens on the message that says so.
 */
export async function openDiscoverItem(
  slots: HarnessSlotStore,
  input: string,
  preview: HarnessItemSummary | null = null,
  options: OpenDiscoverItemOptions = {}
): Promise<void> {
  const request = newRequest()
  const parsed = parseItemRef(input)
  const base: DiscoverDetailState = {
    // What was asked for, cut to what a heading can hold.
    ref: parsed?.ref ?? String(input).trim().slice(0, 120),
    phase: "loading",
    preview,
    item: null,
    error: null,
    versions: idle(),
    readme: idle(),
    prompt: idle(),
    request,
  }
  // Before the offset and the unfolded parts are reset: they are part of
  // what the detail is kept as.
  const from = slots.get(DISCOVER_DETAIL)
  if (options.trail === "push" && from) {
    const step: DiscoverTrailStep = {
      detail: from,
      scroll: slots.get(DISCOVER_DETAIL_SCROLL),
      expanded: slots.get(DISCOVER_DETAIL_EXPANDED),
    }
    slots.set(DISCOVER_DETAIL_TRAIL, (prev) =>
      [...prev, step].slice(-TRAIL_LIMIT)
    )
  } else if (options.trail !== "keep") {
    slots.set(DISCOVER_DETAIL_TRAIL, (prev) => (prev.length ? [] : prev))
  }
  slots.set(DISCOVER_DETAIL_SCROLL, 0)
  slots.set(DISCOVER_DETAIL_EXPANDED, [])
  slots.set(DISCOVER_QUICK_MESSAGE, null)
  if (!parsed) {
    slots.set(DISCOVER_DETAIL, {
      ...base,
      phase: "error",
      error: { kind: "invalidRef", detail: "" },
    })
    return
  }
  slots.set(DISCOVER_DETAIL, base)
  const current = () => slots.get(DISCOVER_DETAIL)?.request === request
  try {
    const item = await harnessItem(parsed.ref)
    if (!current()) return
    slots.set(DISCOVER_DETAIL, (prev): DiscoverDetailState | null =>
      prev ? { ...prev, phase: "ready", item, error: null } : prev
    )
    // Each fails on its own: an item whose versions cannot be listed still
    // shows everything else.
    void loadVersions(slots, request, item.ref)
    // The item says whether it has a description; none is not asked for.
    if (item.readme !== null) void loadReadme(slots, request, item.ref)
    // A prompt's text normally comes with the item; it is asked for on its
    // own only from a catalog that left it out.
    if (item.kind === "prompt" && promptTextOf(item) === null) {
      void loadPromptText(slots, request, item.ref)
    }
  } catch (error) {
    if (!current()) return
    const failure = harnessFailureOf(error)
    slots.set(DISCOVER_DETAIL, (prev): DiscoverDetailState | null =>
      prev ? { ...prev, phase: "error", error: failure } : prev
    )
    noteFailure(failure)
  }
}

/** Ask for the open item again, after it failed to load. The way back it
 *  was opened with stays. */
export function retryDiscoverItem(slots: HarnessSlotStore): void {
  const detail = slots.get(DISCOVER_DETAIL)
  if (detail) {
    void openDiscoverItem(slots, detail.ref, detail.preview, { trail: "keep" })
  }
}

/** Ask again for one part of the open item that failed on its own. */
export function retryDiscoverPart(
  slots: HarnessSlotStore,
  part: DiscoverDetailLoadPart
): void {
  const detail = slots.get(DISCOVER_DETAIL)
  if (!detail?.item) return
  void PART_LOADS[part](slots, detail.request, detail.item.ref)
}

/**
 * A detail put back from the way back. Whatever was still loading when it
 * was left had its answer dropped — another item was open when it came — so
 * that is asked for again.
 */
function resumeDetail(
  slots: HarnessSlotStore,
  detail: DiscoverDetailState
): void {
  if (detail.phase === "loading") {
    void openDiscoverItem(slots, detail.ref, detail.preview, { trail: "keep" })
    return
  }
  if (!detail.item) return
  for (const part of ["versions", "readme", "prompt"] as const) {
    if (detail[part].phase === "loading") retryDiscoverPart(slots, part)
  }
}

/**
 * Back: to the detail this one was opened from, as it was left, if it was
 * opened from one; otherwise to the list. Either way the link or the card the
 * item was opened from gets the focus.
 */
export function closeDiscoverItem(slots: HarnessSlotStore): void {
  const detail = slots.get(DISCOVER_DETAIL)
  if (!detail) return
  slots.set(DISCOVER_RETURN_FOCUS, detail.item?.ref ?? detail.ref)
  const trail = slots.get(DISCOVER_DETAIL_TRAIL)
  const back = trail[trail.length - 1]
  if (!back) {
    slots.set(DISCOVER_DETAIL, null)
    return
  }
  slots.set(DISCOVER_DETAIL_TRAIL, trail.slice(0, -1))
  slots.set(DISCOVER_DETAIL_SCROLL, back.scroll)
  slots.set(DISCOVER_DETAIL_EXPANDED, back.expanded)
  slots.set(DISCOVER_DETAIL, back.detail)
  resumeDetail(slots, back.detail)
}

// ─── Totals ───────────────────────────────────────────────────────────

/**
 * Ask the catalog how much it holds of each kind: the first page of each, as
 * the list itself asks for it — so the backend's cache answers the list when
 * the user then picks that kind. Read once per window; one that failed is
 * tried again on the next visit. Nothing is said when it fails: the counts
 * are simply not shown.
 */
export function ensureDiscoverKindTotals(
  slots: HarnessSlotStore,
  options: { force?: boolean } = {}
): void {
  const { phase } = slots.get(DISCOVER_KIND_TOTALS)
  if (!options.force && phase !== "idle" && phase !== "error") return
  const request = newRequest()
  slots.set(
    DISCOVER_KIND_TOTALS,
    (prev): Loadable<DiscoverKindTotals> => ({
      ...prev,
      phase: "loading",
      request,
    })
  )
  void (async () => {
    const results = await Promise.allSettled(
      DISCOVER_KIND_FILTERS.map((kind) =>
        harnessList(
          listArgs(discoverQueryOf({ ...DEFAULT_DISCOVER_FILTERS, kind }))
        )
      )
    )
    if (slots.get(DISCOVER_KIND_TOTALS).request !== request) return
    const value: DiscoverKindTotals = {}
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.approxTotal !== null) {
        value[DISCOVER_KIND_FILTERS[index]] = result.value.approxTotal
      }
    })
    const any = Object.keys(value).length > 0
    slots.set(DISCOVER_KIND_TOTALS, {
      phase: any ? "ready" : "error",
      value: any ? value : null,
      error: null,
      request,
    })
  })()
}

/**
 * Straight back to the list, from however deep in the details the user is
 * (an assistant's skill, opened from the assistant): the card the first of
 * them was opened from gets the focus.
 */
export function closeDiscoverToList(slots: HarnessSlotStore): void {
  const detail = slots.get(DISCOVER_DETAIL)
  if (!detail) return
  const first = slots.get(DISCOVER_DETAIL_TRAIL)[0]?.detail ?? detail
  slots.set(DISCOVER_RETURN_FOCUS, first.item?.ref ?? first.ref)
  slots.set(DISCOVER_DETAIL_TRAIL, [])
  slots.set(DISCOVER_DETAIL, null)
}

// ─── Configuration ────────────────────────────────────────────────────

async function loadConfig(
  slots: HarnessSlotStore,
  slot: HarnessSlot<Loadable<HarnessConfig>>
): Promise<void> {
  const request = newRequest()
  slots.set(slot, { phase: "loading", value: null, error: null, request })
  const current = () => slots.get(slot).request === request
  try {
    const value = await harnessConfig()
    if (current())
      slots.set(slot, { phase: "ready", value, error: null, request })
  } catch (error) {
    if (!current()) return
    const failure = harnessFailureOf(error)
    slots.set(slot, { phase: "error", value: null, error: failure, request })
    noteFailure(failure)
  }
}

/**
 * Load the catalog's configuration unless it is loaded or loading. One that
 * failed is tried again: the list has its own error and Retry, and the
 * filters simply are not there until this succeeds.
 */
export function ensureDiscoverConfig(slots: HarnessSlotStore): void {
  const { phase } = slots.get(DISCOVER_CONFIG)
  if (phase === "idle" || phase === "error") {
    void loadConfig(slots, DISCOVER_CONFIG)
  }
}

/**
 * Refresh, from the page's chrome: what the user is looking at is asked for
 * again — the open item, or the list with the counts above it — and a
 * configuration that failed is tried again.
 */
export function refreshDiscover(slots: HarnessSlotStore): void {
  ensureDiscoverConfig(slots)
  if (slots.get(DISCOVER_DETAIL)) {
    retryDiscoverItem(slots)
    return
  }
  ensureDiscoverKindTotals(slots, { force: true })
  reloadDiscoverList(slots)
}

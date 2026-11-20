/**
 * The update check of what the workspace's host installed from Harness
 * (plan §7.7): what it last said, "check now", and the event that says it
 * changed.
 *
 * The host's Codeg asks SpaceRing (`POST /resolve`) once a day in the
 * background and keeps the answer; these commands only read it, or ask the
 * host to check — never this window. It only tells: nothing here installs,
 * updates or disables anything; "Update" opens the install dialog, where the
 * user confirms as for any install.
 *
 * Kept in a slot (`harness-slots.ts`), read by the sidebar's badge (always
 * mounted) and by the MCP, Skills and Discover sections. Requests to the
 * host run one after another, so an answer always lands after every answer
 * to an earlier request — a read that started before a check finished can
 * never land over that check's answer.
 */
import { defineHarnessSlot, type HarnessSlotStore } from "@/lib/harness-slots"
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import {
  HarnessClientError,
  harnessFailureOf,
  type HarnessFailure,
} from "./errors"

export const HARNESS_UPDATES_CHANGED_EVENT = "harness://updates-changed"

/** What the check says of one installed item, as the backend spells it. */
export const HARNESS_UPDATE_STATES = [
  "latest",
  "update_available",
  "yanked",
  "disabled_by_author",
  "removed_by_harness",
  "unknown",
] as const

export type HarnessUpdateState = (typeof HARNESS_UPDATE_STATES)[number]

/** The section seams' spelling of the states there is a mark for. */
export type HarnessRemoteState =
  | "latest"
  | "updateAvailable"
  | "yanked"
  | "disabledByAuthor"
  | "removedByHarness"

export interface HarnessUpdateItem {
  id: string
  /** The lowest revision installed: where an update starts. */
  revision: number
  state: HarnessUpdateState
  /** A newer revision is out — also beside "yanked" or "removed by Harness"
   *  when there is one to move to. */
  update_available: boolean
  latest: { revision: number; version: string | null } | null
  /** The item's address now, as the catalog last told it. */
  ref: string | null
  /** Why the state is unknown: not asked yet, or asked and not told. */
  unknown: "not_checked" | "unavailable" | null
}

export interface HarnessCheckError {
  /** `network`, `rate_limited`, `server`, `too_large`, `invalid_response`,
   *  `not_found`, … — anything else reads as a failure without a reason. */
  code: string
  seconds: number | null
  status: number | null
}

export interface HarnessUpdates {
  /** False where the operator switched the catalog off: nothing is checked. */
  enabled: boolean
  /** The host is checking right now. */
  checking: boolean
  /** When the answers the states come from were asked; `null` before any. */
  checked_at: string | null
  /** When a check was last tried, whatever came of it. */
  attempted_at: string | null
  /** The last try got no answer; the states are still `checked_at`'s. */
  error: HarnessCheckError | null
  items: HarnessUpdateItem[]
  /** Items with an update available — counted here from `items`. */
  count: number
}

export interface HarnessUpdatesChanged {
  count: number
  item_ids: string[]
}

// ─── Reading the answers ──────────────────────────────────────────────

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function wholeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null
}

function stateOf(value: unknown): HarnessUpdateState {
  return (HARNESS_UPDATE_STATES as readonly unknown[]).includes(value)
    ? (value as HarnessUpdateState)
    : "unknown"
}

function item(source: Json): HarnessUpdateItem | null {
  const id = textOrNull(source.id)
  const revision = wholeOrNull(source.revision)
  if (!id || revision === null) return null
  const latest = record(source.latest)
  const latestRevision = latest ? wholeOrNull(latest.revision) : null
  const state = stateOf(source.state)
  return {
    id,
    revision,
    state,
    // Only a newer revision the answer names is an update to offer.
    update_available:
      source.update_available === true &&
      latestRevision !== null &&
      latestRevision > revision,
    latest:
      latest && latestRevision !== null
        ? { revision: latestRevision, version: textOrNull(latest.version) }
        : null,
    ref: textOrNull(source.ref),
    unknown:
      state !== "unknown"
        ? null
        : source.unknown === "unavailable"
          ? "unavailable"
          : "not_checked",
  }
}

/** The answer of either command, read defensively: a newer or older Codeg
 *  may be on the other end. Only an answer that is not the shape at all is
 *  refused, as `invalidResponse`. */
export function normalizeHarnessUpdates(value: unknown): HarnessUpdates {
  const source = record(value)
  if (!source || !Array.isArray(source.items)) {
    throw new HarnessClientError(
      "invalidResponse",
      "Not an update check answer"
    )
  }
  const items: HarnessUpdateItem[] = []
  const seen = new Set<string>()
  for (const entry of source.items) {
    const parsed = record(entry) ? item(entry as Json) : null
    if (!parsed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    items.push(parsed)
  }
  const error = record(source.error)
  return {
    enabled: source.enabled !== false,
    checking: source.checking === true,
    checked_at: textOrNull(source.checked_at),
    attempted_at: textOrNull(source.attempted_at),
    error: error
      ? {
          code: textOrNull(error.code) ?? "unknown",
          seconds: wholeOrNull(error.seconds),
          status: wholeOrNull(error.status),
        }
      : null,
    items,
    count: items.filter((entry) => entry.update_available).length,
  }
}

export function normalizeUpdatesChanged(value: unknown): HarnessUpdatesChanged {
  const source = record(value)
  const ids = Array.isArray(source?.item_ids) ? source.item_ids : []
  return {
    count: wholeOrNull(source?.count) ?? 0,
    item_ids: ids.filter((id): id is string => typeof id === "string"),
  }
}

// ─── The commands ─────────────────────────────────────────────────────

/** What the host's last check says of what it has installed now. Asks
 *  SpaceRing nothing. */
export async function harnessUpdates(): Promise<HarnessUpdates> {
  return normalizeHarnessUpdates(await getTransport().call("harness_updates"))
}

/**
 * Ask the host to check. Without `explicit` (a section opening) the host
 * checks only if it has not tried in the last hour; `explicit` (the user
 * pressed "Check now") checks whatever the time. Answers as
 * {@link harnessUpdates}, after the check.
 */
export async function harnessCheckUpdates(
  explicit = false
): Promise<HarnessUpdates> {
  return normalizeHarnessUpdates(
    await getTransport().call("harness_check_updates", { explicit })
  )
}

export async function onHarnessUpdatesChanged(
  handler: (payload: HarnessUpdatesChanged) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe<unknown>(
    HARNESS_UPDATES_CHANGED_EVENT,
    (payload) => handler(normalizeUpdatesChanged(payload))
  )
}

// ─── The slot ─────────────────────────────────────────────────────────

export interface HarnessUpdatesState {
  phase: "idle" | "loading" | "ready" | "error"
  /** The last answer — kept while a new one is read, and when that fails. */
  value: HarnessUpdates | null
  failure: HarnessFailure | null
  /** An explicit check this window asked for is under way. */
  checking: boolean
}

export const HARNESS_UPDATES = defineHarnessSlot<HarnessUpdatesState>(
  "mcp",
  () => ({ phase: "idle", value: null, failure: null, checking: false })
)

// One queue per store: each request starts after the one before it has
// landed. A read asked for while another is still waiting to start is that
// one (a burst of events reads once).
const queues = new WeakMap<HarnessSlotStore, Promise<void>>()
const waitingReads = new WeakMap<HarnessSlotStore, Promise<void>>()

function enqueue(
  slots: HarnessSlotStore,
  work: () => Promise<void>
): Promise<void> {
  const before = queues.get(slots) ?? Promise.resolve()
  const next = before.then(work, work)
  queues.set(
    slots,
    next.catch(() => undefined)
  )
  return next
}

/** While the host says a check of its own is running, read again this
 *  often: a check that ends without changing anything announces nothing,
 *  and "Checking…" must not outlive it. */
export const CHECKING_REREAD_MS = 3000
/** At most this many such reads in a row (two minutes' worth; a check's
 *  requests time out well within that). */
const MAX_CHECKING_REREADS = 40
const checkingRereads = new WeakMap<HarnessSlotStore, number>()

function followRunningCheck(slots: HarnessSlotStore, value: HarnessUpdates) {
  if (!value.checking) {
    checkingRereads.delete(slots)
    return
  }
  const reads = (checkingRereads.get(slots) ?? 0) + 1
  checkingRereads.set(slots, reads)
  if (reads > MAX_CHECKING_REREADS) return
  setTimeout(() => void reloadHarnessUpdates(slots), CHECKING_REREAD_MS)
}

async function land(
  slots: HarnessSlotStore,
  ask: () => Promise<HarnessUpdates>
): Promise<void> {
  slots.set(
    HARNESS_UPDATES,
    (prev): HarnessUpdatesState => ({ ...prev, phase: "loading" })
  )
  try {
    const value = await ask()
    slots.set(
      HARNESS_UPDATES,
      (prev): HarnessUpdatesState => ({
        ...prev,
        phase: "ready",
        value,
        failure: null,
      })
    )
    followRunningCheck(slots, value)
  } catch (error) {
    slots.set(
      HARNESS_UPDATES,
      (prev): HarnessUpdatesState => ({
        ...prev,
        phase: "error",
        failure: harnessFailureOf(error),
      })
    )
  }
}

/** Read again what the host's check says. No request to SpaceRing. */
export function reloadHarnessUpdates(slots: HarnessSlotStore): Promise<void> {
  const waiting = waitingReads.get(slots)
  if (waiting) return waiting
  const read = enqueue(slots, async () => {
    waitingReads.delete(slots)
    await land(slots, harnessUpdates)
  })
  waitingReads.set(slots, read)
  return read
}

/** Ask the host to check (see {@link harnessCheckUpdates}). */
export function checkHarnessUpdates(
  slots: HarnessSlotStore,
  explicit: boolean
): Promise<void> {
  if (explicit) {
    slots.set(
      HARNESS_UPDATES,
      (prev): HarnessUpdatesState => ({ ...prev, checking: true })
    )
  }
  return enqueue(slots, async () => {
    await land(slots, () => harnessCheckUpdates(explicit))
    if (explicit) {
      slots.set(
        HARNESS_UPDATES,
        (prev): HarnessUpdatesState => ({ ...prev, checking: false })
      )
    }
  })
}

// ─── What the sections make of it ─────────────────────────────────────

/** How long a check counts as current when a section opens. */
export const CHECK_FRESH_MS = 60 * 60 * 1000

/** Whether a section opening should ask the host to check: the catalog is
 *  on there, and its last answer is over an hour old (or there is none). */
export function checkIsStale(value: HarnessUpdates, now: number): boolean {
  if (!value.enabled) return false
  if (!value.checked_at) return true
  const at = Date.parse(value.checked_at)
  return !Number.isFinite(at) || now - at >= CHECK_FRESH_MS
}

/** The items of an answer by id. */
export function updatesById(
  value: HarnessUpdates | null | undefined
): ReadonlyMap<string, HarnessUpdateItem> {
  const byId = new Map<string, HarnessUpdateItem>()
  if (!value?.enabled) return byId
  for (const entry of value.items) byId.set(entry.id, entry)
  return byId
}

/** The mark the sections show for an item's state; `null` for "unknown"
 *  (nothing to say). */
export function remoteStateOf(
  entry: HarnessUpdateItem | null | undefined
): HarnessRemoteState | null {
  switch (entry?.state) {
    case "latest":
      return "latest"
    case "update_available":
      return "updateAvailable"
    case "yanked":
      return "yanked"
    case "disabled_by_author":
      return "disabledByAuthor"
    case "removed_by_harness":
      return "removedByHarness"
    default:
      return null
  }
}

export interface HarnessRemote {
  /** The state mark, `null` when there is nothing to say. */
  remote: HarnessRemoteState | null
  /** A newer revision than the one installed is out. */
  updateAvailable: boolean
  /** The newest revision, as the catalog last told it. */
  latest: { revision: number; version: string | null } | null
  /** The item's address now, when the catalog told it. */
  ref: string | null
}

/**
 * What the check says of an item the listing has at `revision`. The two are
 * read apart, so the answer can be about another revision — the one before
 * an update the listing already shows. Then only what still holds is said:
 * an update, if the newest revision is past the one installed now; no state
 * mark until the check's answer catches up.
 */
export function remoteFor(
  entry: HarnessUpdateItem | null | undefined,
  revision: number
): HarnessRemote {
  if (!entry) {
    return { remote: null, updateAvailable: false, latest: null, ref: null }
  }
  const updateAvailable =
    entry.update_available &&
    entry.latest !== null &&
    entry.latest.revision > revision
  const remote =
    entry.revision === revision
      ? remoteStateOf(entry)
      : updateAvailable
        ? "updateAvailable"
        : null
  return { remote, updateAvailable, latest: entry.latest, ref: entry.ref }
}

/** A subscription that cannot be had (a transport without events) is no
 *  subscription; the answer is still read on every mount. */
export function subscribeSafely(
  subscribe: () => Promise<UnsubscribeFn>
): Promise<UnsubscribeFn | null> {
  try {
    return subscribe().catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

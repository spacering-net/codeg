// The frontend's half of the agent grant: which addresses can be shared at
// all, and the standing answer (`defaultAgentGrant`) that decides what every
// site a tab arrives at is shared at before anybody presses anything.
//
// The backend remains the only party that grants — this reads a preference and
// asks, exactly as the share menu does.

import { isRemoteDesktopMode } from "@/lib/transport"

import { browserAgentGrant } from "./browser-api"
import { getBrowserPrefs } from "./browser-prefs"
import type { BrowserTabState, GrantLevel } from "./types"
import { getCurrentWindowLabel } from "./window-label"

/**
 * The origin a grant could bind to, or null when this page has none.
 *
 * Both halves of the backend's rule (`agent::grantable_origin`), so this says
 * the same thing it does. Duplicated only to decide whether to offer or apply
 * a share at all — the backend still decides whether it happens, and says why
 * when it refuses.
 *
 * A document guest cannot be shared, and its address does not say so: under
 * WebView2 it is served from `http://codeg-doc.doc-<token>/…`, a perfectly
 * ordinary-looking http origin. No surface renders the share control for one
 * today (they show a local file, and have a toolbar of their own), but a rule
 * that agrees with the backend on only one of its two clauses is a trap for
 * whoever mounts it somewhere new.
 */
export function shareableOrigin(state: BrowserTabState | null): string | null {
  if (!state || state.kind === "document") return null
  const origin = state.origin
  if (!origin) return null
  return origin.startsWith("http://") || origin.startsWith("https://")
    ? origin
    : null
}

/** What one tab has answered, and what it was left at where it has been. */
interface TabMemory {
  /** The origin it is on and has already been answered for. Re-answering
   *  within one stay is what would make "stop sharing" unpressable: a page
   *  emits a stream of states, and one of them is the state right after that
   *  press. */
  current: string | null
  /**
   * Per origin this tab has visited, the level its grant was last seen at —
   * and `null` once a grant that WAS there ended. That null is the whole
   * reason this is a map and not a single origin: it has to survive the tab
   * going elsewhere and coming back, or a page could take a grant the person
   * revoked by bouncing the tab through `about:blank` and back.
   *
   * Recorded only from what the backend reports, never from what was asked
   * for, so the window between asking and the grant arriving is not read as a
   * refusal.
   */
  levels: Map<string, GrantLevel | null>
}

/** How many sites one tab remembers a LEVEL for. Oldest dropped first — a tab
 *  that has browsed all day should not carry every origin it has ever
 *  touched. Forgetting one of these costs nothing: the site is answered with
 *  the standing default again, which is what it was answered with before. */
const ORIGIN_MEMORY_LIMIT = 64

/**
 * …and how many REVOCATIONS, which are counted apart from the levels above
 * rather than sharing one budget with them.
 *
 * Forgetting a revocation is not free: it hands the site back to agents on
 * the next visit, which is the one thing this whole map exists to prevent.
 * Under a single budget the page decided who was forgotten — it walks its own
 * tab through 65 origins it controls, each of them recorded as it is
 * auto-shared, and the revocation the person made is off the front of the map
 * by the time the tab comes back. Any one budget a page can fill is a budget
 * a page can empty of what it does not like.
 *
 * A revocation is only written when a grant that was there ends: the person
 * pressing "stop sharing", or the backend taking a loopback grant back
 * because the port changed hands. Neither is something a page can drive, so
 * this budget is generous — reaching it would take hundreds of presses in one
 * tab — and it is still a bound.
 */
const REVOKED_MEMORY_LIMIT = 256

const memories = new Map<string, TabMemory>()

function remember(
  memory: TabMemory,
  origin: string,
  level: GrantLevel | null
): void {
  // Delete first, so re-recording moves an origin back to the young end: a
  // `Map` iterates in insertion order, and the eviction below takes the front.
  memory.levels.delete(origin)
  memory.levels.set(origin, level)
  evict(memory, (entry) => entry !== null, ORIGIN_MEMORY_LIMIT)
  evict(memory, (entry) => entry === null, REVOKED_MEMORY_LIMIT)
}

/** Drop the oldest entries of one class until it is within `limit`. Deleting
 *  from a `Map` while iterating it is defined: an entry removed before the
 *  walk reaches it is simply not visited. */
function evict(
  memory: TabMemory,
  matches: (level: GrantLevel | null) => boolean,
  limit: number
): void {
  let over = -limit
  for (const level of memory.levels.values()) if (matches(level)) over++
  if (over <= 0) return
  for (const [origin, level] of memory.levels) {
    if (!matches(level)) continue
    memory.levels.delete(origin)
    if (--over === 0) return
  }
}

/**
 * Apply the standing default to a tab that has just committed a page — unless
 * this tab has been to this site before, in which case it gets back whatever
 * it was left at there, including nothing at all.
 *
 * Called for every `browser://state`, which is the only event that carries the
 * committed origin — and the one that arrives however the tab got there: a
 * link, an agent's own `browser_open`, a redirect the page performed on its
 * own.
 */
export function applyDefaultAgentGrant(state: BrowserTabState): void {
  // Every window hears every tab's state; only the one the tab lives in acts,
  // so a second workspace window does not ask for the same grant again.
  if (state.ownerWindow !== getCurrentWindowLabel()) return
  // A remote workspace's agents run on its host and cannot reach a browser of
  // this computer: a standing share here would only ever reach the agents of
  // some other window.
  if (isRemoteDesktopMode()) return
  const origin = shareableOrigin(state)
  if (!origin) {
    // A tab between documents, or on an address no grant can bind to. Its
    // stay is over, so coming back to the site it was on is an arrival like
    // any other — but WHAT it was left at there stays written down, or a page
    // could take back a share the person ended by bouncing the tab through
    // `about:blank` and returning.
    const seen = memories.get(state.tabId)
    if (seen) seen.current = null
    return
  }
  const fallback = getBrowserPrefs().defaultAgentGrant
  // Nothing to apply, and nothing to write down either: leaving tabs
  // unanswered is what lets turning the default ON reach the pages that are
  // already open, instead of only the next site they go to.
  if (fallback === "none") return
  let memory = memories.get(state.tabId)
  if (!memory) {
    memory = { current: null, levels: new Map() }
    memories.set(state.tabId, memory)
  }
  // The grant the state carries, and only if it is this page's: the backend
  // revokes and re-points in the same update that moves `state.origin`, so
  // the two never disagree — but a grant read as belonging to a page it was
  // not made for would be the one mistake with no upper bound on its cost.
  const held =
    state.agentGrant && state.agentGrant.origin === origin
      ? state.agentGrant.level
      : null
  if (memory.current === origin) {
    // Still the same stay, so there is nothing to decide — only to watch. A
    // level that was there and is gone is the person pressing "stop sharing",
    // or the backend taking a loopback grant back because the port changed
    // hands. Either way this tab does not get it back on its own.
    if (held) remember(memory, origin, held)
    else if (memory.levels.get(origin)) remember(memory, origin, null)
    return
  }
  memory.current = origin
  // Already shared — by the person, or by this on an earlier visit. Either
  // way the site is answered, and a level somebody chose is never widened
  // from here.
  if (held) {
    remember(memory, origin, held)
    return
  }
  const remembered = memory.levels.get(origin)
  const level = remembered === undefined ? fallback : remembered
  if (!level || level === "none") return
  void browserAgentGrant(state.tabId, level).catch(() => {
    // The tab went away, or the backend refused the origin this side thought
    // was grantable. Nothing is said: this share is not something the person
    // asked for, so its failure is not something to interrupt them about —
    // the control in the toolbar keeps showing the page as unshared, which is
    // what it is, and one press still shares it. Nothing is recorded either,
    // so the next arrival tries once more; there is no retry within a stay.
  })
}

/**
 * Forget everything about a tab, because the TAB is gone — not merely its
 * surface. A suspended tab is released and built again under the id it had,
 * on the page it was on: it is the same tab, and the sites it has been to are
 * still its own answers, so `releaseBrowserTab` keeps them across that one
 * (`keepSharingMemory`). Only a close comes here.
 */
export function forgetDefaultAgentGrant(backendTabId: string): void {
  memories.delete(backendTabId)
}

/** Forget every tab (tests only). */
export function resetDefaultAgentGrantForTests(): void {
  memories.clear()
}

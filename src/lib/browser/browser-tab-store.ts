// Live state of built-in browser tabs, keyed by the WORKSPACE tab id
// (`browser:<backend id>`). Fed by `BrowserEventsBridge` from the
// `browser://state` stream and by the surface host after `browser_open_tab`;
// read through `useSyncExternalStore` so only components looking at one tab
// re-render when that tab changes. Kept out of the workspace tab record on
// purpose: loading progress and URL changes are frequent and must not churn
// the whole `fileTabs` slice.

import { useSyncExternalStore } from "react"

import { forgetDefaultAgentGrant } from "./browser-agent-grant"
import { browserClose } from "./browser-api"
import type {
  AgentAction,
  AgentActivityPayload,
  AgentOutcome,
  BrowserTabState,
  DocGuestState,
  NavigationBlockReason,
} from "./types"
import { buildFileTabId } from "@/lib/file-tab-id"
import { isDesktop } from "@/lib/transport"
import { randomUUID } from "@/lib/utils"

type Listener = () => void

const states = new Map<string, BrowserTabState>()
const listeners = new Set<Listener>()

// Backend ids whose surface this document has asked the backend to create,
// each with the token of the claim that asked. The surface host consults it
// so a StrictMode double effect or a re-mount of the same tab never asks
// twice: the webview lives as long as the tab record, not as long as the host
// component. Released together with the state, which is what lets a suspended
// tab be brought back through the same host.
//
// The token exists because `browser_open_tab` is a round trip: by the time it
// answers, the tab may have been closed (claim released) or shown again
// (claim re-taken). A holder whose token is no longer the current one owns a
// surface nobody is going to use, and must close it — otherwise the native
// webview stays painted over the workspace with no tab behind it.
const createdSurfaces = new Map<string, number>()
let nextClaimToken = 0

/** Claim the right to create a surface; null when someone already holds it. */
export function claimSurfaceCreation(backendTabId: string): number | null {
  if (createdSurfaces.has(backendTabId)) return null
  nextClaimToken += 1
  createdSurfaces.set(backendTabId, nextClaimToken)
  return nextClaimToken
}

/** Whether `token` is still the live claim for this tab. */
export function surfaceClaimIsCurrent(
  backendTabId: string,
  token: number
): boolean {
  return createdSurfaces.get(backendTabId) === token
}

/** Whether anyone currently holds the claim for this tab. */
export function hasSurfaceClaim(backendTabId: string): boolean {
  return createdSurfaces.has(backendTabId)
}

export function forgetSurfaceCreation(backendTabId: string): void {
  createdSurfaces.delete(backendTabId)
}

// How each tab's latest `browser_open_tab` stands, keyed like the tab state:
// on its way, or refused. Kept here rather than in the host that asked,
// because the host on screen when the answer arrives need not be that one —
// the person can switch away and back while a remote tab's tunnel is still
// being opened, and a refusal heard only by the host that went away would
// leave the one now showing the tab with nothing to say. A refusal stays
// until the tab asks again.
export type BrowserCreateOutcome =
  | { kind: "pending" }
  | { kind: "failed"; error: unknown }

const createOutcomes = new Map<string, BrowserCreateOutcome>()

const CREATE_PENDING: BrowserCreateOutcome = { kind: "pending" }

export function markBrowserCreatePending(key: string): void {
  if (createOutcomes.get(key) === CREATE_PENDING) return
  createOutcomes.set(key, CREATE_PENDING)
  notify()
}

/** The create answered: with the error it was refused with, or none. */
export function settleBrowserCreate(
  key: string,
  refusal?: { error: unknown }
): void {
  if (refusal) createOutcomes.set(key, { kind: "failed", error: refusal.error })
  else if (!createOutcomes.delete(key)) return
  notify()
}

/** Forget a refusal, so the tab's next host asks again. */
export function clearBrowserCreateFailure(key: string): void {
  if (createOutcomes.get(key)?.kind !== "failed") return
  createOutcomes.delete(key)
  notify()
}

export function getBrowserCreateOutcome(
  key: string
): BrowserCreateOutcome | null {
  return createOutcomes.get(key) ?? null
}

export function useBrowserCreateOutcome(
  key: string | null
): BrowserCreateOutcome | null {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (key ? (createOutcomes.get(key) ?? null) : null),
    getServerSnapshot
  )
}

// One promise chain per backend tab id, so the create and destroy calls for
// an id happen in the order they were issued.
//
// A backend tab id is reused across generations: a suspended tab is released
// and, when the user comes back to it, created again under the SAME id. Both
// commands are round trips, and without this the backend could run them in
// either order — a close issued for generation 1 arriving after generation 2
// had registered would destroy the live surface and leave a tab that believes
// it is loaded showing nothing.
const surfaceOps = new Map<string, Promise<unknown>>()

export function runSurfaceOp<T>(
  backendTabId: string,
  op: () => Promise<T>
): Promise<T> {
  const previous = surfaceOps.get(backendTabId)
  // With nothing in flight the call goes out now — a decision to close a
  // surface should not wait for a microtask. Otherwise it queues, and runs
  // whether the previous op resolved or rejected: a failed close must not
  // stall every later operation on this tab.
  const next = previous ? previous.then(op, op) : op()
  const settled = next.then(
    () => {},
    () => {}
  )
  surfaceOps.set(backendTabId, settled)
  // Drop the chain once it drains, so a long session does not keep an entry
  // for every tab id it has ever seen.
  void settled.then(() => {
    if (surfaceOps.get(backendTabId) === settled) {
      surfaceOps.delete(backendTabId)
    }
  })
  return next
}

// When each tab's surface host last went away (`null` while one is mounted).
// A host is mounted exactly while the tab is on screen — the active tab of a
// pane or the viewer drawer — so this is "how long has this page been in the
// background", which the optional background unload is based on. Counted:
// the drawer and a pane can show the same tab at once, and the one going
// away does not take the tab off screen while the other is still there.
const hiddenAt = new Map<string, number | null>()
const mountedHosts = new Map<string, number>()

export function markBrowserTabShown(workspaceTabId: string): void {
  mountedHosts.set(workspaceTabId, (mountedHosts.get(workspaceTabId) ?? 0) + 1)
  hiddenAt.set(workspaceTabId, null)
}

export function markBrowserTabHidden(workspaceTabId: string): void {
  const left = (mountedHosts.get(workspaceTabId) ?? 1) - 1
  if (left > 0) {
    mountedHosts.set(workspaceTabId, left)
    return
  }
  mountedHosts.delete(workspaceTabId)
  hiddenAt.set(workspaceTabId, Date.now())
}

// How many of each tab's hosts are SHOWING its surface right now — told the
// backend "visible" and not taken it back. Not the same as mounted: the file
// column keeps its host mounted but CSS-hidden under a full-page route, while
// the transcript's side panel over that route shows the same tab. Whether a
// host may hide the page, or must leave it to the one showing it, is this.
const showingHosts = new Map<string, number>()

export function markBrowserHostShowing(key: string, showing: boolean): void {
  const count = (showingHosts.get(key) ?? 0) + (showing ? 1 : -1)
  if (count > 0) showingHosts.set(key, count)
  else showingHosts.delete(key)
}

export function browserHostsShowing(key: string): number {
  return showingHosts.get(key) ?? 0
}

/** Milliseconds-since-epoch the tab left the screen; `null` while it is on
 *  screen; `undefined` for a tab that was never shown in this document. */
export function browserTabHiddenAt(
  workspaceTabId: string
): number | null | undefined {
  return hiddenAt.get(workspaceTabId)
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Workspace tab id for a backend tab id. */
export function browserWorkspaceTabId(backendTabId: string): string {
  return buildFileTabId({ kind: "browser", id: backendTabId })
}

export function getBrowserTabState(
  workspaceTabId: string
): BrowserTabState | null {
  return states.get(workspaceTabId) ?? null
}

/** Replace a tab's state (identity changes only when the payload does). */
export function setBrowserTabState(state: BrowserTabState): void {
  const key = browserWorkspaceTabId(state.tabId)
  const previous = states.get(key)
  if (previous && shallowEqualState(previous, state)) return
  states.set(key, state)
  notify()
}

// Tabs whose CURRENT document has printed at least one error. Written only
// from `browser://console-errors`, which the backend emits from the two places
// that move a tab's console ring — the new document that clears it, and the
// first error that lands in it. Deliberately NOT derived from the tab state:
// `loading` is set by more than a commit, and a second one arriving after the
// page's first error would take the mark off while the error was still there.
//
// A set rather than a count: the backend says "the first one happened" once,
// which is all the mark needs, and the exact number is read from the tab when
// the person asks for the lines.
const consoleErrors = new Set<string>()

export function setBrowserConsoleErrors(
  workspaceTabId: string,
  errors: boolean
): void {
  if (errors) {
    if (consoleErrors.has(workspaceTabId)) return
    consoleErrors.add(workspaceTabId)
  } else if (!consoleErrors.delete(workspaceTabId)) {
    return
  }
  notify()
}

/** Whether this tab's document has printed an error. */
export function useBrowserConsoleErrors(
  workspaceTabId: string | null
): boolean {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? consoleErrors.has(workspaceTabId) : false),
    getServerFalse
  )
}

function getServerFalse(): boolean {
  return false
}

export function removeBrowserTabState(workspaceTabId: string): void {
  const hadNotice = notices.delete(workspaceTabId)
  const hadDoc = docStates.delete(workspaceTabId)
  hiddenAt.delete(workspaceTabId)
  mountedHosts.delete(workspaceTabId)
  showingHosts.delete(workspaceTabId)
  findRequests.delete(workspaceTabId)
  boundsResyncs.delete(workspaceTabId)
  // Counted among the reasons to notify: a strip still mounted over a tab
  // whose state had already gone would otherwise keep showing the lines of
  // the page that left. `hiddenAt` and `findRequests` are not — nothing
  // renders them on their own.
  const hadActivity = agentActivity.delete(workspaceTabId)
  const hadErrors = consoleErrors.delete(workspaceTabId)
  const hadCreate = createOutcomes.delete(workspaceTabId)
  if (
    states.delete(workspaceTabId) ||
    hadNotice ||
    hadDoc ||
    hadActivity ||
    hadErrors ||
    hadCreate
  ) {
    notify()
  }
}

// Mode and status of document guests (`browser://doc-state`), keyed like the
// tab state. Separate from it because it changes on its own schedule — the
// user's mode choice, a fall-back to safe mode — and carries no page state.
const docStates = new Map<string, DocGuestState>()

export function setDocGuestState(doc: DocGuestState): void {
  const key = browserWorkspaceTabId(doc.tabId)
  const previous = docStates.get(key)
  if (previous && JSON.stringify(previous) === JSON.stringify(doc)) return
  docStates.set(key, doc)
  notify()
}

export function getDocGuestState(workspaceTabId: string): DocGuestState | null {
  return docStates.get(workspaceTabId) ?? null
}

/** Live document-guest state for one tab, or null for a tab that is not a
 *  document (or before its first `browser://doc-state`). */
export function useDocGuestState(
  workspaceTabId: string | null
): DocGuestState | null {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? (docStates.get(workspaceTabId) ?? null) : null),
    getServerSnapshot
  )
}

export function subscribeBrowserTabs(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getServerSnapshot(): null {
  return null
}

/** Live state for one tab, or null before its first `browser://state`. */
export function useBrowserTabState(
  workspaceTabId: string | null
): BrowserTabState | null {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? (states.get(workspaceTabId) ?? null) : null),
    getServerSnapshot
  )
}

/**
 * Ids of the `browser_close` calls made to SUSPEND a tab — to let its surface
 * go while keeping the tab. The `browser://closed` that carries one back is
 * about the surface and must not be read as the tab ending.
 *
 * The backend emits that event from `close_core` for every close, ours
 * included, so a suspend arrives at the events bridge looking exactly like a
 * page closing its own popup. Acted on, it takes the tab off the strip and
 * forgets what its sites were shared at — the whole of what a suspend must
 * not do.
 *
 * Keyed by the REQUEST, not by the tab: exactly one close event is emitted per
 * tab (whoever wins the registry removal emits it), so "the next close of this
 * tab" may well be somebody else's. If the user closes an owned browser window
 * in the moment between a suspend arming and its command arriving, the window
 * teardown wins that removal, its event is the only one there will be, and
 * swallowing it would leave the tab on the strip after a real close.
 */
const suspendCloseRequests = new Set<string>()

/** Whether this `browser://closed` is a suspend of ours — and spends the id. */
export function takeSuspendCloseRequest(requestId: string | null): boolean {
  return requestId !== null && suspendCloseRequests.delete(requestId)
}

/**
 * Tear down a tab's native surface and forget its state. Idempotent on the
 * backend side, so calling it for a tab that never got a surface is fine.
 * Afterwards the tab record is back to "not loaded": a surface host mounting
 * for it creates a fresh surface (that is how a suspended tab resumes).
 *
 * `suspending` separates the two things this is called for. Closing a tab
 * ends it: the sites it visited are nobody's answers afterwards, and the
 * `browser://closed` that follows is the backend agreeing. SUSPENDING it
 * releases the surface and KEEPS the tab — same id, same page, back on screen
 * when the user switches to it — so what they answered for those sites is
 * still theirs (dropping it would re-share, on the standing default, a site
 * they had taken the share back on), and the close event that comes back
 * under this request's id is about the surface, not the tab.
 */
export function releaseBrowserTab(
  workspaceTabId: string,
  { suspending = false }: { suspending?: boolean } = {}
): void {
  removeBrowserTabState(workspaceTabId)
  const backendId = workspaceTabId.startsWith("browser:")
    ? decodeURIComponent(workspaceTabId.slice("browser:".length))
    : null
  if (!backendId) return
  forgetSurfaceCreation(backendId)
  if (!suspending) forgetDefaultAgentGrant(backendId)
  if (isDesktop()) {
    const requestId = suspending ? randomUUID() : undefined
    if (requestId) suspendCloseRequests.add(requestId)
    void runSurfaceOp(backendId, () =>
      browserClose(backendId, requestId)
    ).catch(() => {
      // The call never landed, so no event is coming under this id.
      if (requestId) suspendCloseRequests.delete(requestId)
    })
  }
}

/** A transient, dismissible message shown between the toolbar and the page. */
export type BrowserTabNotice =
  | { kind: "popup-denied"; url: string; reason: string | null }
  /** A top-level navigation the tab attempted was refused by policy. */
  | { kind: "navigation-blocked"; url: string; reason: NavigationBlockReason }
  /** The page left the origin its grant was bound to, so agents lost access
   *  to this tab without the user doing anything. The one grant transition
   *  worth interrupting for — the other two the user just performed. */
  | { kind: "agent-grant-lost"; origin: string }
  /** The tab never moved and the grant ended anyway: a different program is
   *  serving the loopback address it was shared for. Its own kind rather than
   *  a reason on the one above, because the sentence is the opposite one —
   *  the address in the toolbar is still exactly what the user shared, which
   *  is why nothing else on screen would have told them. */
  | { kind: "agent-grant-replaced"; origin: string }

const notices = new Map<string, BrowserTabNotice>()

export function setBrowserTabNotice(
  workspaceTabId: string,
  notice: BrowserTabNotice | null
): void {
  if (notice) notices.set(workspaceTabId, notice)
  else if (!notices.delete(workspaceTabId)) return
  notify()
}

export function useBrowserTabNotice(
  workspaceTabId: string | null
): BrowserTabNotice | null {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? (notices.get(workspaceTabId) ?? null) : null),
    getServerSnapshot
  )
}

/** A run of identical attempts an agent made on one tab. */
export interface BrowserAgentActivity {
  action: AgentAction
  outcome: AgentOutcome
  /** Unix milliseconds of the most recent one. */
  at: number
  /** How many identical attempts this line stands for. */
  count: number
}

// What agents have done to each tab, newest first. Lives here rather than in
// the tab state because the backend does not keep it: it announces each
// attempt once and forgets, which is the right division — a record with no
// reader is a leak, and the reader is a pane that exists for as long as the
// tab does.
//
// Runs of the same (action, outcome) collapse into one line with a count. An
// agent working through a page reads it dozens of times; forty lines saying
// "read the page" hide the one that says something else, which is the only
// line worth having a strip for.
const AGENT_ACTIVITY_LIMIT = 50
const NO_ACTIVITY: readonly BrowserAgentActivity[] = []
const agentActivity = new Map<string, readonly BrowserAgentActivity[]>()

export function recordBrowserAgentActivity(
  payload: AgentActivityPayload
): void {
  const key = browserWorkspaceTabId(payload.tabId)
  const previous = agentActivity.get(key) ?? NO_ACTIVITY
  const head = previous[0]
  const next =
    head && head.action === payload.action && head.outcome === payload.outcome
      ? [
          { ...head, at: payload.at, count: head.count + 1 },
          ...previous.slice(1),
        ]
      : [
          {
            action: payload.action,
            outcome: payload.outcome,
            at: payload.at,
            count: 1,
          },
          ...previous.slice(0, AGENT_ACTIVITY_LIMIT - 1),
        ]
  agentActivity.set(key, next)
  notify()
}

/**
 * Forget what agents did to this tab up to `recordedBefore`. Called when the
 * person asks for the page again — a reload, or an address entered in the bar
 * — because those lines describe attempts on a document that is being
 * replaced, and a record that outlives its page turns into a pile nobody
 * reads.
 *
 * The cut-off is the moment the request went out, not the moment the answer
 * came back, and it is what keeps this from deleting more than it means to:
 * the callers wait for the backend to accept before clearing (a request it
 * refuses leaves the page, and so its record, alone), and over a remote
 * workspace that wait is a network round trip — long enough for the new
 * document to commit and for an agent to be recorded against it.
 *
 * The grant is deliberately NOT touched: it is bound to an origin and survives
 * a reload of it (that is the whole point of binding it to the site rather
 * than to the document), so taking it away here would revoke access the person
 * never took back. Clearing what was recorded is not the same as changing what
 * is allowed.
 */
export function clearBrowserAgentActivity(
  workspaceTabId: string,
  recordedBefore: number
): void {
  const previous = agentActivity.get(workspaceTabId)
  if (!previous) return
  // A run whose most recent attempt lands after the cut-off is still going,
  // so it stays whole — including the attempts of it that came before.
  const kept = previous.filter((entry) => entry.at > recordedBefore)
  if (kept.length === previous.length) return
  if (kept.length === 0) agentActivity.delete(workspaceTabId)
  else agentActivity.set(workspaceTabId, kept)
  notify()
}

/** What agents have done to this tab, newest first. Empty until something
 *  has. Not a log: nothing persists it, and it dies with the tab. */
export function useBrowserAgentActivity(
  workspaceTabId: string | null
): readonly BrowserAgentActivity[] {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () =>
      workspaceTabId
        ? (agentActivity.get(workspaceTabId) ?? NO_ACTIVITY)
        : NO_ACTIVITY,
    getNoActivity
  )
}

function getNoActivity(): readonly BrowserAgentActivity[] {
  return NO_ACTIVITY
}

// Per-tab counter of "open the find bar" requests. The page owns ⌘F while it
// has keyboard focus (the app's DOM never sees that keystroke), so the host
// forwards it as `browser://shortcut` and it arrives here; the tab view
// watches the counter rather than a boolean, so a second ⌘F on an already
// open bar still re-focuses it.
const findRequests = new Map<string, number>()

export function requestBrowserFind(workspaceTabId: string): void {
  findRequests.set(workspaceTabId, (findRequests.get(workspaceTabId) ?? 0) + 1)
  notify()
}

export function useBrowserFindRequest(workspaceTabId: string | null): number {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? (findRequests.get(workspaceTabId) ?? 0) : 0),
    getServerZero
  )
}

// Per-tab counter of "send this surface its bounds again, whether or not they
// look changed" requests.
//
// The host only pushes bounds it has not already pushed, which is right while
// the host is the only thing that moves a surface — and wrong the moment
// something else does. A web inspector docked into the window (which is not
// how they open, but is what WebKit gives whoever asks it for that) resizes
// the page to fill it and leaves it there after it closes; the placeholder
// never moved, so nothing the host measures differs and the page would stay
// full-window until the next real layout change. Counted, not a flag, so two
// closes in a row are two resyncs.
const boundsResyncs = new Map<string, number>()

export function requestBrowserBoundsResync(backendTabId: string): void {
  const key = browserWorkspaceTabId(backendTabId)
  boundsResyncs.set(key, (boundsResyncs.get(key) ?? 0) + 1)
  notify()
}

export function useBrowserBoundsResync(workspaceTabId: string | null): number {
  return useSyncExternalStore(
    subscribeBrowserTabs,
    () => (workspaceTabId ? (boundsResyncs.get(workspaceTabId) ?? 0) : 0),
    getServerZero
  )
}

function getServerZero(): number {
  return 0
}

export function resetBrowserTabStoreForTests(): void {
  states.clear()
  notices.clear()
  docStates.clear()
  listeners.clear()
  createdSurfaces.clear()
  surfaceOps.clear()
  hiddenAt.clear()
  mountedHosts.clear()
  showingHosts.clear()
  findRequests.clear()
  boundsResyncs.clear()
  agentActivity.clear()
  consoleErrors.clear()
  createOutcomes.clear()
  suspendCloseRequests.clear()
}

function shallowEqualState(a: BrowserTabState, b: BrowserTabState): boolean {
  const keys = Object.keys(a) as (keyof BrowserTabState)[]
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (x === y) continue
    // Nested fields (`error`, `agentGrant`) are rebuilt by the deserializer
    // on every event, so identity says nothing about them; compare them
    // structurally. Deliberately by shape rather than by naming the fields:
    // the third one to be added would otherwise make every `browser://state`
    // look like a change, and a loading page emits a lot of them.
    if (x && y && typeof x === "object" && typeof y === "object") {
      if (JSON.stringify(x) === JSON.stringify(y)) continue
    }
    return false
  }
  return true
}

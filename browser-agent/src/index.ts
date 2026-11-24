/**
 * The agent-facing half of a browser tab, running in the isolated world.
 *
 * `channel.ts`'s primitive carries page state back to Rust. This bundle is the
 * other direction: Rust evaluates `__codegAgent.<fn>(...)` in the same world
 * and reads the JSON it returns. Nothing here is reachable from the page — the
 * world is separate, and the page never sees `__codegAgent`.
 *
 * Two halves: reading the page into a tree of refs (`snapshot`), and acting on
 * an element by ref (`act`, and `locate` for a host that delivers its own
 * pointer; `rectOf` for a host cropping a screenshot to one). The rules for
 * when a ref stops meaning anything live here with the snapshot that issued
 * it; `act.ts` only ever receives an element.
 *
 * The tree itself is Playwright's, vendored under `../vendor/playwright`
 * (see VENDOR.md). We call it in `ai` mode, which is the mode Playwright MCP
 * uses, so the shape an agent reads here is the shape it already knows.
 */

import {
  generateAriaTree,
  renderAriaTreeAsJSON,
} from "../vendor/playwright/injected/ariaSnapshot"
import {
  renderAriaSnapshotAsYaml,
  type AriaSnapshotYamlOptions,
} from "../vendor/playwright/isomorphic/ariaSnapshotRenderer"

import {
  clickAt,
  describe,
  hoverAt,
  isDisabledControl,
  pointAt,
  pointerReach,
  pressOn,
  selectIn,
  typeInto,
  type ActionFailure,
  type ActionRequest,
  type ScrollReport,
} from "./act"

/**
 * Identifies the world this script is running in, and with it the document.
 *
 * Playwright hands out `e1`, `e2`, … from a counter that lives in the module,
 * so a fresh document starts over at `e1`. Two pages therefore use the same
 * names for different elements, and a ref an agent read before a navigation
 * would land on whatever happens to be first in the new page — silently, and
 * on an element the agent never saw. The generation makes that answerable:
 * every snapshot reports the one it was taken in, and a request carrying an
 * older one is refused instead of resolved.
 *
 * A page cannot influence it: the script is evaluated at document start in a
 * world the page cannot reach, before any page script runs.
 */
const GENERATION = generationToken()

function generationToken(): string {
  const buf = new Uint32Array(2)
  // `getRandomValues` is available on insecure origins too — it is
  // `crypto.subtle` that is not — so a plain-http dev server takes this path
  // like anything else. The fallback is there for the engine that surprises
  // us: a predictable generation still separates one document from the next,
  // which is all this value has to do, and the page cannot read it either way.
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf)
  else
    for (let i = 0; i < buf.length; i++)
      buf[i] = (Math.random() * 2 ** 32) >>> 0
  return `${buf[0].toString(36)}${buf[1].toString(36)}`
}

/**
 * The elements the last snapshot named, by ref.
 *
 * Replaced wholesale on every snapshot rather than accumulated: a ref only
 * means anything against the tree it was read from, and keeping older ones
 * around would let a stale name resolve to an element still in the document.
 *
 * The elements are held strongly, which is bounded — one tree's worth, dropped
 * at the next snapshot, and the whole world dies with the document. What a
 * WeakRef would buy is not the memory but the answer for an element that has
 * since been removed from the page, and `isConnected` answers that exactly,
 * without asking for a `WeakRef` the oldest WebKit we support may not have.
 */
let refs = new Map<string, Element>()

/**
 * The names the snapshot *before* the last one handed out, and the token it
 * handed them out under — names only, no elements, so nothing here can
 * resolve to anything.
 *
 * Kept for one reason: to tell a caller that a ref it holds was unmade by its
 * own next snapshot rather than by the page moving on. See [`stale`]. Holding
 * the strings cannot make a dead ref live again, which is why it is safe to
 * keep them at all.
 */
let superseded = new Set<string>()
let supersededToken = ""

/**
 * The names the last snapshot *would* have handed out and the cap took away.
 *
 * The one thing that tells a name the caller's own `maxChars` dropped from a
 * name the page dropped, and [`stale`] cannot say the first without it: both
 * leave a name the current table does not hold, so the table alone answers
 * neither.
 *
 * Names, not elements — like [`superseded`], nothing here can resolve to
 * anything — and disjoint from `refs` by construction, since these are
 * exactly the entries deleted from it. A page-wide "was this snapshot cut"
 * flag would not do: the host caps *every* snapshot by default, so on any
 * page past the cap that flag is permanently true and says nothing about
 * this ref. A ref the page removed is never in the tree the cap cut, so it
 * can never be in here.
 */
let cutAway = new Set<string>()

/**
 * The address the last snapshot was taken at.
 *
 * The generation answers for a *new document*, which is the only kind of
 * navigation that destroys this world. It is not the only kind of navigation:
 * `pushState`, `replaceState` and a hash change all leave the document, the
 * world and this module exactly where they were while the page becomes a
 * different page. That is the ordinary case for the dev servers these tabs
 * exist to show — a route change in a single-page app — and the elements a
 * framework keeps across one, a header's buttons and its nav, are precisely
 * the ones still `isConnected` afterwards. Without this an agent could act on
 * `e8` from the page it read while looking at the page it did not.
 *
 * Compared rather than subscribed to, because there is nothing here to
 * subscribe to. See `epoch` on `SnapshotOptions`: this world structurally
 * cannot observe a page-initiated history call, so a *floor* it can check by
 * looking is worth more than a hook it cannot install.
 *
 * The direction of the error matters: this refuses some refs that would still
 * be sound, because a caller told to take a new snapshot loses a round trip,
 * while a caller handed the wrong element loses the user's page.
 */
let refsTakenAt = ""

/**
 * Two things this world *can* see move under a same-document navigation,
 * which together catch the case the address alone cannot: a route that goes
 * A → B → A.
 *
 * `history.length` grows on every `pushState`, so a page that left and came
 * back by pushing has a longer history than the snapshot saw (until the
 * engine's cap — fifty entries in Chromium — after which it stops growing;
 * a session that deep is rare and still has the address floor). `popstate`
 * and `hashchange` fire in this world like any other event, so a back and a
 * forward that land on the same address are counted even though neither the
 * address nor the length moved. What is left uncaught is a `replaceState`
 * away and back, which changes nothing observable and is its own kind of
 * rare.
 *
 * Together with the host's epoch this is what makes acting on a ref safe
 * enough to do: the cost of a stale one here is a click on the wrong thing,
 * not a confusing tree.
 */
let refsHistoryLength = 0
let refsNavTicks = 0
let navTicks = 0
addEventListener("popstate", () => void navTicks++)
addEventListener("hashchange", () => void navTicks++)

/**
 * The Navigation API's id for the current history entry, where the engine
 * has one (Chromium, and WebKit from Safari 26). It is minted anew for every
 * same-document navigation — `pushState`, `replaceState`, back, forward —
 * regardless of where the history length or the address end up, which closes
 * the two cases the floors above leave open: a length pinned at the engine's
 * cap, and a `replaceState` away and back. `null` where the API is absent,
 * and then those two stay as documented.
 */
function navigationEntryId(): string | null {
  const nav = (
    globalThis as { navigation?: { currentEntry?: { id?: string } } }
  ).navigation
  return nav?.currentEntry?.id ?? null
}
let refsEntryId: string | null = null

/**
 * Which snapshot of this document a token is for. Two snapshots of the same
 * document under the same host epoch would otherwise hand out the same token,
 * and a caller holding the earlier one could resolve refs against the later
 * one's map — names it never read, on elements it never saw.
 */
let snapshotSeq = 0

/**
 * The token the last snapshot handed out, and the one a ref must quote.
 *
 * The world's own generation plus whatever the host attached to that snapshot
 * (`SnapshotOptions.epoch`), so a caller echoes one opaque string back and
 * neither side has to agree on what it is made of.
 */
let refsToken = ""

export type SnapshotOptions = {
  /** Cap on the rendered tree. Omitted or non-positive means no cap. */
  maxChars?: number
  /**
   * An opaque token from the host, mixed into the generation this snapshot
   * hands out and required back on every `elementForRef`.
   *
   * What it buys is enforcement *by the host*: the epoch rides inside the one
   * string the caller echoes, so the host can refuse a ref the moment it knows
   * the page moved on, by comparing against the epoch it is issuing now —
   * without a side table mapping snapshots to navigations. This world refuses
   * an older token only from the next snapshot onwards, because until then it
   * has no way to learn that anything happened.
   *
   * It exists because there is a class of staleness this world cannot see. The
   * page's own `history.pushState` is not observable from here: patching
   * `History.prototype` in an isolated world patches *this world's* prototype,
   * and the page calls a different function object — the same isolation that
   * keeps `__codegAgent` out of the page's reach keeps the page's navigations
   * out of ours. Comparing `location.href` catches the settled result of most
   * of them, but an address is not an identity: a route that goes A → B → A
   * arrives back at a string that matches, on a page whose framework may have
   * kept the DOM node and given it new meaning.
   *
   * The host is the only party that can see those transitions, through the
   * navigation it already tracks for the tab. So the decision of *when* refs
   * die is the host's, and enforcing it is this world's. What is checked here
   * without a host token — a new document, a moved address, a departed
   * element — is a floor, not the contract.
   */
  epoch?: string
}

export type SnapshotResult = {
  generation: string
  url: string
  title: string
  viewport: { width: number; height: number; dpr: number }
  tree: string
  refsCount: number
  truncated: boolean
}

/** Reads the page into the tree an agent operates on. */
export function snapshot(options: SnapshotOptions = {}): SnapshotResult {
  const root = document.body ?? document.documentElement
  const next = new Map<string, Element>()
  let rendered = ""

  // Which line each node was rendered on, from the renderer itself — so
  // that a cap on the text can be applied to the refs structurally, without
  // reading the text back for markers a page could imitate.
  const lineToNode: NonNullable<AriaSnapshotYamlOptions["lineToNode"]> =
    new Map()
  if (root) {
    const aria = generateAriaTree(root, { mode: "ai" })
    for (const [ref, info] of aria.info) next.set(ref, info.element)
    const { json } = renderAriaTreeAsJSON(aria, { mode: "ai" })
    rendered = renderAriaSnapshotAsYaml(json, { lineToNode })
  }
  const { text, truncated } = truncate(rendered, options.maxChars)
  const cut = new Set<string>()
  if (truncated) {
    // A ref the agent was not shown is not a ref it holds. Whatever the cap
    // cut from the text is cut from the map too, so a name guessed from the
    // pattern cannot act on an element that was never in the answer.
    const shown = shownRefs(lineToNode, rendered, text)
    for (const ref of Array.from(next.keys()))
      if (!shown.has(ref)) {
        next.delete(ref)
        cut.add(ref)
      }
  }
  superseded = new Set(refs.keys())
  supersededToken = refsToken
  refs = next
  cutAway = cut
  refsTakenAt = location.href
  refsHistoryLength = history.length
  refsNavTicks = navTicks
  refsEntryId = navigationEntryId()
  // `!== undefined`, not truthiness: an empty epoch is a value the host chose
  // and must stay distinguishable from one it never sent, or a host that
  // happens to render an epoch as "" would silently get the untagged token and
  // a ref issued under it would outlive the epoch change it was meant to die
  // with. The host reads its half back from the right, so the sequence
  // number sits with the world's half.
  const own = `${GENERATION}.${++snapshotSeq}`
  refsToken = options.epoch !== undefined ? `${own}.${options.epoch}` : own

  return {
    generation: refsToken,
    url: refsTakenAt,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    tree: text,
    refsCount: next.size,
    truncated,
  }
}

/**
 * The refs whose node lines survived a cut, from the renderer's own line map
 * rather than from the text: page content can contain the characters
 * `[ref=e42]`, and a marker read back out of the text could not tell the
 * page's from the renderer's. A cut that fell inside the first line left no
 * whole line, and so no ref, in the answer.
 */
export function shownRefs(
  lineToNode: Map<number, { ref?: string }>,
  rendered: string,
  kept: string
): Set<string> {
  const shown = new Set<string>()
  const wholeLines =
    kept.length === rendered.length || rendered.startsWith(`${kept}\n`)
  if (!wholeLines) return shown
  const lines = kept.length === 0 ? 0 : kept.split("\n").length
  for (const [line, node] of lineToNode)
    if (line < lines && node.ref) shown.add(node.ref)
  return shown
}

/**
 * The element a ref names, or `null` if the ref cannot be honoured.
 *
 * Four ways it cannot: the token it quotes is not the one the last snapshot
 * handed out — another document, or a host that has since declared the page
 * moved on — the address has changed since that snapshot, the last snapshot
 * did not name this ref, or the element it named has left the page. All four
 * are one answer to the caller, take a new snapshot, so they are one return
 * value here.
 */
export function elementForRef(generation: string, ref: string): Element | null {
  if (!refsAreCurrent(generation)) return null
  const element = refs.get(ref)
  if (!element?.isConnected) return null
  return element
}

/** Whether the last snapshot still describes the page: same token, same
 *  address, same history. Everything but the element itself. */
function refsAreCurrent(generation: string): boolean {
  // Against the last snapshot's token, not the world's: a host that bumps its
  // epoch between two snapshots means the earlier one's refs are no longer
  // answerable, even though the document never changed.
  if (!refsToken || generation !== refsToken) return false
  if (location.href !== refsTakenAt) return false
  if (history.length !== refsHistoryLength) return false
  if (navTicks !== refsNavTicks) return false
  if (navigationEntryId() !== refsEntryId) return false
  return true
}

export type ActionResult =
  | {
      ok: true
      url: string
      /** What a scroll key moved, when the action was one. Absent for every
       *  other action, and for a key that scrolled nothing. */
      scrolled?: ScrollReport
    }
  | ({ ok: false; url: string } & ActionFailure)

export type LocateResult =
  | { ok: true; url: string; x: number; y: number }
  | ({ ok: false; url: string } & ActionFailure)

export type RectResult =
  | {
      ok: true
      url: string
      /** The element's visible box, viewport CSS pixels. */
      x: number
      y: number
      width: number
      height: number
      /** Whether bringing it into view moved the page, and so a frame is
       *  owed before the pixels match. */
      scrolled: boolean
      viewport: { width: number; height: number; dpr: number }
    }
  | ({ ok: false; url: string } & ActionFailure)

/**
 * Why a ref did not resolve, in the caller's terms.
 *
 * `elementForRef` collapses four causes into one answer on purpose, because
 * the fix for all four is the same: snapshot again. One of them deserves its
 * own sentence anyway, because the plain answer is actively misleading there.
 * A caller that snapshots a second time with a smaller `maxChars` — to glance
 * at one part of a page it has already read — silently unmakes every ref
 * outside the cut, since a snapshot replaces the ref table and a cut takes
 * the refs with it. Acting on a ref it was handed a moment ago then says "not
 * an element on the page as it is now" about a page that has not changed at
 * all, and the caller has no way to see that it did this to itself.
 *
 * Both halves of that are covered, because a caller can arrive quoting either
 * snapshot: the newer one (the ref is simply not in its table) or the older
 * one the ref came from (the token itself is a generation behind).
 *
 * What decides it is [`cutAway`], and nothing weaker would do. The ref table
 * cannot tell this apart from the ordinary case on its own: `ai` mode caches
 * a ref on the element and reuses it while the role and the name hold, so two
 * snapshots of an unchanged page name the same elements by the same refs —
 * and a name missing from the second means either the cap took it *or the
 * page did*. A page that re-renders between two snapshots, which is most of
 * why a ref goes stale at all, leaves exactly the table this would otherwise
 * read as the caller's own doing, and would be answered with "the page has
 * not changed, take a bigger snapshot" — the same kind of lie this is here to
 * remove, pointing the other way.
 *
 * Nor would "was the last snapshot cut", which is the tempting shorthand and
 * is not the same question. The host caps every snapshot it takes, so on any
 * page past that cap the answer is permanently yes and the lie comes back
 * word for word. `cutAway` names the refs *this* cut took, which is the
 * question actually being asked.
 */
function stale(ref: string | null, generation?: string): ActionFailure {
  const cut =
    ref !== null &&
    generation !== undefined &&
    // Disjoint from `refs`: these are the names deleted from it.
    cutAway.has(ref) &&
    superseded.has(ref) &&
    // Either the caller is on the current snapshot and this ref is not in it,
    // or it is quoting the very snapshot the ref came from. Anything older
    // than that, or a page that has moved since, is not this case and gets
    // the plain answer.
    (refsAreCurrent(generation) ||
      (generation === supersededToken && location.href === refsTakenAt))
  if (cut)
    return {
      error: "stale",
      detail:
        `${ref} was named by an earlier snapshot of this page, and the snapshot you took ` +
        `after it did not name it — a smaller \`maxChars\` names fewer refs, and each ` +
        `snapshot replaces the last one's. The page itself has not changed. Take a ` +
        `snapshot large enough to include what you want and use a ref from that one.`,
    }
  return {
    error: "stale",
    detail: ref
      ? `${ref} does not name an element on the page as it is now; take a new snapshot`
      : "the page has changed since that snapshot; take a new one",
  }
}

function clamp(
  n: unknown,
  low: number,
  high: number,
  fallback: number
): number {
  const value =
    typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(high, Math.max(low, value))
}

/**
 * Do `request` to the element `ref` named in the snapshot `generation`, with
 * events this world dispatches (`synthetic`).
 *
 * The ref is resolved and the action taken in one evaluation, so nothing can
 * happen to the page between deciding the element is still the one and
 * touching it. `ref` may be `null` for `press` alone — a key goes to whatever
 * has focus — and the snapshot still has to be current for that, so a key
 * cannot be sent into a page the agent has not seen.
 *
 * `url` is where the page was when the action was done, for the host to hold
 * against the grant; a click that navigates has not navigated yet by the
 * time this returns.
 */
export function act(
  generation: string,
  ref: string | null,
  request: ActionRequest
): ActionResult {
  const url = location.href
  const failed = (failure: ActionFailure): ActionResult => ({
    ok: false,
    url,
    ...failure,
  })
  let element: Element | null = null
  if (ref !== null) {
    element = elementForRef(generation, ref)
    if (!element) return failed(stale(ref, generation))
  } else if (!refsAreCurrent(generation)) {
    return failed(stale(null))
  } else if (request.kind !== "press") {
    return failed({
      error: "unsupported",
      detail: `${request.kind} needs a ref`,
    })
  }
  switch (request.kind) {
    case "click":
    case "hover": {
      const target = element!
      if (isDisabledControl(target))
        return failed({
          error: "disabled",
          detail: `${describe(target)} is disabled`,
        })
      const point = pointAt(target)
      if ("error" in point) return failed(point)
      const blocked = pointerReach(target, point)
      if (blocked) return failed(blocked)
      if (request.kind === "click") {
        const count = clamp(request.count, 1, 3, 1)
        const delivered = clickAt(
          target,
          point,
          request.button === "right" ? "right" : "left",
          count,
          () => refsAreCurrent(generation) && target.isConnected
        )
        if (delivered < count)
          return failed({
            error: "stale",
            detail: `the page changed after click ${delivered} of ${count}; take a new snapshot`,
          })
      } else hoverAt(target, point)
      return { ok: true, url: location.href }
    }
    case "type": {
      const failure = typeInto(element!, String(request.text ?? ""))
      if (failure) return failed(failure)
      if (request.submit) {
        const after = pressOn(null, "Enter")
        if ("error" in after) return failed(after)
      }
      return { ok: true, url: location.href }
    }
    case "press": {
      const done = pressOn(element, String(request.key ?? ""))
      if ("error" in done) return failed(done)
      return {
        ok: true,
        url: location.href,
        // Omitted rather than null for a key that is not a scroll key: the
        // field's presence is what says the question was asked at all.
        ...(done.scrolled ? { scrolled: done.scrolled } : {}),
      }
    }
    case "select": {
      const values = Array.isArray(request.values)
        ? request.values.map(String)
        : [String(request.values ?? "")]
      const failure = selectIn(element!, values)
      return failure ? failed(failure) : { ok: true, url: location.href }
    }
    default:
      return failed({
        error: "unsupported",
        detail: `"${String((request as { kind?: unknown }).kind)}" is not an action`,
      })
  }
}

/**
 * Where a pointer would have to land to touch the element `ref` names — for
 * a host that can deliver a real one there. Scrolls the element into view
 * and refuses on the same grounds `act` would: a stale ref, no visible box,
 * something on top.
 */
export function locate(generation: string, ref: string): LocateResult {
  const url = location.href
  const element = elementForRef(generation, ref)
  if (!element) return { ok: false, url, ...stale(ref, generation) }
  if (isDisabledControl(element))
    return {
      ok: false,
      url,
      error: "disabled",
      detail: `${describe(element)} is disabled`,
    }
  const point = pointAt(element)
  if ("error" in point) return { ok: false, url, ...point }
  const blocked = pointerReach(element, point)
  if (blocked) return { ok: false, url, ...blocked }
  return { ok: true, url: location.href, x: point.x, y: point.y }
}

/**
 * The visible box of the element `ref` names, for a host cropping a
 * screenshot to it. Brings it into view first, the way `locate` does, and
 * refuses on the same grounds: a stale ref, or nothing of it on screen. An
 * element half under the fold is reported as the half that shows, since that
 * is what the pixels will hold.
 */
export function rectOf(generation: string, ref: string): RectResult {
  const url = location.href
  const element = elementForRef(generation, ref)
  if (!element) return { ok: false, url, ...stale(ref, generation) }
  // Whether bringing it into view moved anything is read off the element's
  // own box, not the window's scroll offsets: an `overflow: auto` ancestor
  // scrolls without moving the window at all.
  const before = element.getBoundingClientRect()
  const point = pointAt(element)
  if ("error" in point) return { ok: false, url, ...point }
  const box = visibleBoxOf(element)
  if (!box)
    return {
      ok: false,
      url,
      error: "not-visible",
      detail: `${describe(element)} has no visible box on screen to crop to`,
    }
  const after = element.getBoundingClientRect()
  return {
    ok: true,
    url: location.href,
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height,
    scrolled:
      Math.abs(after.top - before.top) > 0.5 ||
      Math.abs(after.left - before.left) > 0.5,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
  }
}

/** The element's bounding box clipped to the viewport, or `null` when none
 *  of it is on screen. The bounding box rather than the largest fragment,
 *  unlike a pointer's target: a screenshot of a wrapped link wants both of
 *  its lines. */
function visibleBoxOf(el: Element): DOMRect | null {
  const box = el.getBoundingClientRect()
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  if (right - left < 1 || bottom - top < 1) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Cuts the tree to `maxChars` on a line boundary.
 *
 * Mid-line would hand the agent a half-written node — a ref with no role, or a
 * role with half its name — which reads as a real entry rather than as a cut.
 *
 * There is one case with no line boundary to use: a cap that lands inside the
 * very first line. The cap wins there and the line is cut where it falls,
 * because the cap is the caller's own bound and returning nothing would read
 * as an empty page rather than as a tree that was too long. `truncated` says
 * which of the two happened either way.
 */
export function truncate(
  text: string,
  maxChars: number | undefined
): { text: string; truncated: boolean } {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars)
    return { text, truncated: false }
  const cut = text.lastIndexOf("\n", maxChars)
  return {
    text: cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars),
    truncated: true,
  }
}

declare global {
  var __codegAgent: {
    snapshot: typeof snapshot
    elementForRef: typeof elementForRef
    act: typeof act
    locate: typeof locate
    rectOf: typeof rectOf
  }
}

globalThis.__codegAgent = { snapshot, elementForRef, act, locate, rectOf }

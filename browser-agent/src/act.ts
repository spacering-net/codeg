/**
 * Acting on an element an agent named in a snapshot — the other half of
 * `__codegAgent`, and the reason refs exist at all.
 *
 * Everything here is JavaScript dispatching events at the element, which the
 * host reports as `synthetic` fidelity. A page cannot tell these apart from a
 * script of its own doing the same thing (`isTrusted` is false on all of
 * them), and there are things a synthetic event does not do that a real one
 * would: open a popup, enter fullscreen, apply `:hover`, move focus on
 * mousedown, submit a form on Enter. Where the engine's default action is the
 * whole point of the key — Enter in a form, Space on a button, Tab — this
 * emulates it, because an agent that pressed Enter meant the form to go.
 * Where it is not emulable (a popup needs user activation) the fidelity field
 * on the result is how the agent finds out.
 *
 * On a platform with a trusted-input channel the host does the pointing
 * itself: `pointAt` and `obstructionAt` still decide *where*, and the
 * platform delivers a real mouse there.
 *
 * Nothing here resolves a ref. `index.ts` does that, under the staleness
 * rules that live with the snapshot, and hands an element in.
 */

export type PointerButton = "left" | "right"

/** What an agent may do to an element. `press` alone may go without a ref
 *  (to whatever has focus); the rest name one. */
export type ActionRequest =
  | { kind: "click"; button?: PointerButton; count?: number }
  | { kind: "hover" }
  /** Replaces the field's value — the predictable meaning, and the one that
   *  does not depend on what was there. */
  | { kind: "type"; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "select"; values: string[] }

export type ActionError =
  /** The ref no longer names anything: another document, a moved page, a
   *  removed element. Take a new snapshot. */
  | "stale"
  /** Nothing of the element is on screen to point at. Four shapes, told apart
   *  by the detail rather than by a code of their own, because the fix for
   *  two of them is to stop rather than to do something else. Those two are
   *  the screen-reader-only node the accessibility tree names and a pointer
   *  can never reach, which describes itself as *painting nothing* when its
   *  style erases it and as *parked outside the page* when a coordinate puts
   *  it past any scroll, and which says *no snapshot will change that* either
   *  way. The other two are the page as it happens to be: *not being rendered
   *  at the moment* wants whatever hides it opened and a fresh snapshot, and
   *  merely *outside the viewport* is a page that could not be scrolled to it
   *  this time. */
  | "not-visible"
  /** Another element is on top at the point a pointer would land. A user
   *  could not click this either; a dialog's backdrop is the common case.
   *  Something about the page has to change first, and can. */
  | "obscured"
  /** `type` on something that takes no text, `select` on no `<select>`. */
  | "not-editable"
  /** `select`: a value matched no option. The detail lists them. */
  | "no-option"
  /** The control is disabled: a person could not operate it either, and a
   *  dispatched event would reach its handlers anyway. */
  | "disabled"
  /** Not a request this world understands. */
  | "unsupported"

export type ActionFailure = { error: ActionError; detail: string }

/**
 * What a scroll key moved, in CSS pixels, so a caller can tell a scroll that
 * happened from one that had nowhere to go.
 *
 * An agent cannot see the page. The accessibility tree it reads back is the
 * whole document rather than the part on screen, so it looks the same before
 * and after a scroll — which makes "did that do anything?" unanswerable from
 * the outside, and is how a model ends up pressing PageDown thirty times at
 * the bottom of a page. `by` answers it, and `top` against `max` says whether
 * there is anywhere left to go.
 */
export type ScrollReport = {
  /** How far it actually moved. Negative upwards, `0` when it did not. */
  by: number
  /** Where the box is now. */
  top: number
  /** The furthest it can go: `top === max` is the end of it. */
  max: number
}

/** What a press did, when it did not fail. */
export type Pressed = { scrolled: ScrollReport | null }

/** A point in viewport CSS pixels, which is what both a dispatched event and
 *  CDP's `Input.dispatchMouseEvent` take. */
export type Point = { x: number; y: number }

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

/**
 * Bring the element into view and find the point a pointer would touch it.
 *
 * The centre of its largest visible box. Largest rather than bounding: an
 * inline element that wraps has a bounding box whose centre can be empty
 * space between its two lines. Clipped to the viewport before taking the
 * centre, so an element half under the fold is hit in the half that shows.
 */
export function pointAt(el: Element): Point | ActionFailure {
  // `center` rather than `nearest`: `nearest` leaves an element that is just
  // below the fold flush against the bottom edge, under whatever fixed
  // footer the page keeps there. `instant` so the rect read next is the one
  // the page will be at, not a frame of a smooth scroll.
  el.scrollIntoView?.({
    block: "center",
    inline: "center",
    behavior: "instant" as ScrollBehavior,
  })
  const box = visibleBox(el)
  if (box) return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  // Several ways to have no box worth pointing at, and they do not ask the
  // same thing of the caller — which is the whole reason this is not one
  // sentence. Two of them are the element's own doing and will still be true
  // next time; the rest are the page as it happens to be right now.
  //
  // Not being laid out at all is the second kind, and it arrives here looking
  // like the first: an element under a `display: none` has no boxes, so its
  // measurements are the same zeroes a one-pixel recipe leaves. The accordion
  // shut since the snapshot, the panel a route change collapsed — open what
  // hides it, snapshot again, and the ref works. Asked first, because the
  // size tests below cannot tell the two apart.
  //
  // "Snapshot again" is not a loop even when nothing opens it: `ai` mode
  // names only what is visible, so the next snapshot does not hand this ref
  // out again and there is nothing left to retry. The probe pins that.
  if (!isRendered(el))
    return {
      error: "not-visible",
      detail:
        `${describe(el)} is not being rendered at the moment — it, or something above it, is ` +
        `hidden (\`display: none\`, \`visibility: hidden\`). Whatever hides it has to be ` +
        `opened first; then take a new snapshot and use a ref from that one.`,
    }
  const own = largestBox(el)
  // A box a pixel across is the element's own doing and will be a pixel
  // across for ever.
  if (own.width <= 1 || own.height <= 1) return unreachable(el)
  // So is a full-sized box parked where no scroll can reach it, which is the
  // same intent written a third way. See [`isParkedOutsideTheDocument`].
  if (isParkedOutsideTheDocument(el, own)) return unreachable(el, "parked")
  // And what is left really is a state: a real box that nothing of lands in
  // the viewport is a place the page could not scroll to *this time*.
  return {
    error: "not-visible",
    detail:
      `${describe(el)} is laid out but none of it is inside the viewport, even after ` +
      `scrolling to it — something between it and the page is holding it off screen.`,
  }
}

/**
 * Whether the box is parked so far outside the document that nothing brings
 * it back.
 *
 * The third spelling of the screen-reader-only recipe, `position: absolute;
 * left: -9999px`, which no computed-style test sees: nothing about the style
 * is unusual, it is *where* the box is that puts it out of the world. Read
 * after [`pointAt`] has already had `scrollIntoView` try.
 *
 * Distance is the whole test, and the reason is that "outside the document"
 * alone is not permanent at all. Scroll offsets clamp at zero, so no scroll
 * reaches a negative coordinate — but CSS does, and the two commonest things
 * parked out there are things a page puts back:
 *
 *   - the off-canvas drawer, `left: -320px; width: 320px`, which a hamburger
 *     slides in;
 *   - the skip link, `top: -40px`, which `:focus` drops into view.
 *
 * Both are parked *flush*: an off-canvas panel is offset by exactly its own
 * size, because that is what putting it off the edge means, so its far edge
 * lands on the origin or a few pixels past it. The recipe is parked nine
 * thousand pixels away, which is nobody's animation. So the line is drawn a
 * whole viewport out: past that there is no design that means to bring it
 * back, and every flush-parked thing is comfortably inside it.
 *
 * Only where the element's frame of reference is the document's, which is
 * what the walk checks — a box that scrolls or transforms anywhere between
 * here and the page makes the arithmetic mean something else, and both of
 * those change in a moment.
 *
 * The page's own two boxes are read like any other and not walked past: `body
 * { transform: translateX(-300px) }` is how the *other* drawer pattern works
 * and it pushes everything aside at once, and a transform on `html` does the
 * same for a root-level page transition. The walk simply ends at `html`,
 * whose parent is not an element.
 *
 * What the page's boxes are excused is the *overflow* test, and only for the
 * reason that they are the page: the scroll that belongs to the viewport is
 * already in the arithmetic as `window.scrollX` / `scrollY`, and refusing on
 * `overflow` alone would switch this whole test off for every application
 * that writes `body { overflow: hidden }`, which is most of them. What is not
 * excused is a page box that is *itself* scrolled — `html { overflow: hidden
 * } / body { overflow: auto }` puts the offset in `body.scrollTop` where the
 * window knows nothing of it.
 *
 * The element's *own* overflow is not asked about at all, only its
 * ancestors': overflow clips an element's descendants and says nothing about
 * where its own border box sits, and `overflow: hidden` is part of the recipe
 * — it is there so the parked box raises no scrollbars. Testing it would
 * refuse to recognise the very thing this is for. Its own transform is
 * another matter, since that moves the box being measured.
 *
 * The error runs towards recoverability on purpose: a missed one costs a
 * retry, a wrong one tells an agent to give up on an element that is there.
 */
function isParkedOutsideTheDocument(el: Element, box: DOMRect): boolean {
  const viewport = document.scrollingElement ?? document.documentElement
  for (let node: Element | null = el; node; node = parentElementOf(node)) {
    const page = node === document.body || node === document.documentElement
    const style = getComputedStyle(node)
    if (page) {
      if (node !== viewport && (node.scrollTop !== 0 || node.scrollLeft !== 0))
        return false
    } else if (
      node !== el &&
      (style.overflowX !== "visible" || style.overflowY !== "visible")
    ) {
      return false
    }
    if (style.transform !== "none") return false
  }
  return (
    (box.right + window.scrollX < -window.innerWidth &&
      box.right < -window.innerWidth) ||
    (box.bottom + window.scrollY < -window.innerHeight &&
      box.bottom < -window.innerHeight)
  )
}

/**
 * The one refusal a caller must not retry, in words that say so.
 *
 * Every other failure here describes a page that could be different in a
 * moment — a ref gone stale, a dialog in the way, a control disabled. This
 * one describes an element the accessibility tree names and a pointer can
 * never reach, which is a fixed property of the page's markup: the
 * screen-reader-only heading a framework puts inside every article. An agent
 * that reads "no visible box" as bad luck will snapshot and try the next ref
 * like it, and a page that has one of these has a row of them.
 *
 * `shape` picks the description, because that heading is written two ways and
 * only one of them is invisible. A box a pixel across, or a full-sized one
 * clipped away to nothing, paints nowhere. A box parked off-canvas paints
 * perfectly well, at a coordinate no scroll reaches — telling that one it
 * "paints nothing on screen" asserts something the caller can go and check,
 * and its own box disagrees. A refusal a caller can catch out being wrong is
 * one it has a reason to retry past, which is the single thing this message
 * exists to prevent.
 *
 * What both shapes say identically is the verdict — "no snapshot will change
 * that" — because that sentence, not either description, is what
 * `browser_click`'s tool description tells a model to read the permanence
 * off. Change one and change the other.
 *
 * Told only where the element itself is the evidence — see
 * [`isVisuallyErased`] for why nothing infers it from what a pointer happened
 * to hit.
 *
 * (An element under `pointer-events: none` never gets this far: `ai` mode
 * refuses it a ref in the first place, so there is nothing to act on.)
 */
function unreachable(
  el: Element,
  shape: "erased" | "parked" = "erased",
  touched?: Element
): ActionFailure {
  const instead = touched
    ? `; ${describe(touched)} is what a pointer there would touch`
    : ""
  const wrong =
    shape === "parked"
      ? `is parked outside the page, further out than any scroll reaches`
      : `is in the accessibility tree but paints nothing on screen`
  const act =
    shape === "parked"
      ? `act on a ref a pointer can land on.`
      : `act on a ref that is actually drawn on the page.`
  return {
    error: "not-visible",
    detail:
      `${describe(el)} ${wrong}${instead}. ` +
      `A person could not reach it either, and no snapshot will change that — ` +
      act,
  }
}

/**
 * Whether the element has been *erased* rather than merely covered: the CSS
 * that puts a node in the accessibility tree and nowhere else.
 *
 * This is the positive evidence [`unreachable`] insists on. The tempting
 * shortcut is to infer it — if a pointer at the element's own centre lands on
 * one of its *ancestors*, surely the element draws nothing there — and that
 * inference is wrong often enough to be dangerous, because the verdict it
 * feeds is the one an agent must not retry. An ancestor is what a pointer
 * finds whenever the ancestor paints over its own descendant: a card with
 * `::after { position: absolute; inset: 0 }` over a perfectly visible link
 * (the stretched-link pattern; a pseudo-element hit is attributed to its
 * host), the content of a `height: 0; overflow: hidden` accordion whose refs
 * the tree hands out all the same. Those are recoverable — click the card,
 * open the accordion — and telling an agent to give up on them is worse than
 * the confusing `obscured` this was meant to replace.
 *
 * So: only the element's own computed style decides. A box a pixel across is
 * already gone by [`visibleBox`]; what is left is the full-sized box clipped
 * away to nothing, in the two spellings the recipe has had.
 */
function isVisuallyErased(el: Element): boolean {
  const style = getComputedStyle(el)
  // The legacy `clip`, which every engine reports in `rect(a, b, c, d)` form.
  // Any collapsed rectangle counts, not just the all-zero one `clip: rect(0 0
  // 0 0)` reports — `rect(1px, 1px, 1px, 1px)` is the same nothing. The
  // property only *applies* to an absolutely positioned box while the
  // computed value is reported whatever the position is, so the position is
  // what decides whether the value means anything: a `.sr-only` whose focus
  // state puts it back in flow without resetting `clip` is visible, and
  // calling it erased would refuse a control a person can see.
  const positioned = style.position === "absolute" || style.position === "fixed"
  const rect = style.clip.match(
    /^rect\((-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px\)$/
  )
  if (positioned && rect) {
    const [top, right, bottom, left] = rect.slice(1).map(Number)
    if (bottom - top <= 1 || right - left <= 1) return true
  }
  // And its replacement. `inset(50%)` is the one the accessibility guides
  // print; the test is per axis, since the shorthand's sides pair up
  // (`inset(60% 0 0 0)` insets the top alone and leaves four tenths of the
  // box).
  const path = style.clipPath.match(/^inset\(([^)]*?)(?:\s+round\s.*)?\)$/)
  if (path) {
    const sides = insetSides(path[1].trim().split(/\s+/))
    if (
      sides &&
      (sides.top + sides.bottom >= 100 || sides.left + sides.right >= 100)
    )
      return true
  }
  return false
}

/**
 * The four sides of an `inset()`, as percentages, from however many the
 * shorthand was written with.
 *
 * `null` for anything that cannot be summed as one: a side given as a length
 * would need the border box to resolve against, and an inset written in
 * pixels that happens to close a box is not a recipe anyone follows. Zero is
 * the exception, because zero is zero in any unit and an engine serializing
 * `inset(50% 0 50% 0)` hands back `inset(50% 0px)` — a mix on paper, and the
 * commonest way the real thing is written.
 */
function insetSides(
  parts: string[]
): { top: number; right: number; bottom: number; left: number } | null {
  if (parts.length < 1 || parts.length > 4) return null
  const percents = parts.map((part) =>
    Number.parseFloat(part) === 0
      ? 0
      : part.endsWith("%")
        ? Number.parseFloat(part)
        : NaN
  )
  if (percents.some(Number.isNaN)) return null
  const [a, b = a, c = a, d = b] = percents
  return { top: a, right: b, bottom: c, left: d }
}

/** The element's own largest box, before the viewport has any say. Largest
 *  rather than bounding, for the reason [`pointAt`] gives. */
function largestBox(el: Element): DOMRect {
  const rects = Array.from(el.getClientRects())
  return rects.length
    ? rects.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
    : el.getBoundingClientRect()
}

function visibleBox(el: Element): DOMRect | null {
  const box = largestBox(el)
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  // `<= 1`, not `< 1`: the screen-reader-only recipe every framework shares is
  // `width: 1px; height: 1px; clip: rect(0 0 0 0)`, which is a box by the
  // geometry and nothing at all to a person. Below this is a target no one
  // could hit on purpose, so refusing it costs nothing and catching the 1px
  // case buys the whole class.
  if (right - left <= 1 || bottom - top <= 1) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Whatever is on top of `target` at `(x, y)`, or `null` when the target
 * itself (or something inside it) is what a pointer there would touch.
 *
 * Looks *through* shadow roots on the way down and *up* through shadow hosts
 * on the way back: a button rendered by a web component is inside the
 * component's shadow tree, and the element the agent named may be either.
 */
function obstructionAt(x: number, y: number, target: Element): Element | null {
  // An engine with no hit testing at all cannot answer this, and refusing
  // every click on the strength of a missing method would be worse than
  // letting them through: the element has a visible box — [`pointAt`] found
  // the point inside it — and the refusal would be `obscured`, the kind a
  // caller retries, naming an obstruction that does not exist. Told apart
  // from a point that genuinely hit nothing, which every engine answers with
  // `null` and which stays the conservative refusal it has always been.
  //
  // A property read rather than a platform fact, but not one a page can
  // arrange: the prototype this resolves against is *this world's*, and a
  // page defining its own reaches only its own — the isolation that keeps
  // `__codegAgent` out of the page's reach, read from the other side.
  if (typeof document.elementFromPoint !== "function") return null
  const hit = deepElementFromPoint(x, y)
  if (!hit) return document.documentElement
  for (let node: Node | null = hit; node; node = parentOf(node)) {
    if (node === target) return null
  }
  return hit
}

/**
 * Whether a pointer at `point` would reach `target`, and — when it would not
 * — which kind of "no" that is.
 *
 * The two kinds want opposite things from the caller, which is why they are
 * told apart here rather than reported as one refusal. `not-visible` means
 * the element has been erased — it is in the tree and on no one's screen, and
 * no amount of trying will change that. Everything else is `obscured`: the
 * page is in a state where a pointer cannot get to this element, and the way
 * forward is to deal with what is in the way. Only the element's own style
 * decides which ([`isVisuallyErased`]), never what the pointer happened to
 * hit, because an ancestor painting over its own descendant is ordinary and
 * recoverable.
 *
 * An `obscured` names what is in the way, which is the thing to act on: the
 * card that carries the overlay, the dialog to dismiss. That the obstruction
 * is sometimes the target's own ancestor does not change the advice, but it
 * does change the words — see [`obscuredBy`].
 *
 * Both callers — the dispatched path and the trusted one — go through here,
 * so an agent cannot get two different answers for the same page depending on
 * which platform it is running on.
 */
export function pointerReach(
  target: Element,
  point: Point
): ActionFailure | null {
  const cover = obstructionAt(point.x, point.y, target)
  if (!cover) return null
  if (isVisuallyErased(target)) return unreachable(target, "erased", cover)
  return { error: "obscured", detail: obscuredBy(cover, target) }
}

/**
 * What is in the way, said so that the caller can tell it from the thing it
 * is in the way of.
 *
 * [`describe`] names an element by its own text, and a container's text is
 * whatever its contents say. In the pattern this message meets most often —
 * a card whose `::after` covers the link inside it — the card's only text
 * *is* the link's, so the plain wording comes out as "X is on top of X".
 * Which names nothing to act on, and naming the thing to act on is the only
 * job this message has.
 *
 * So when the obstruction is the target's own ancestor, say that, and let the
 * tag and the id carry it rather than repeating the words twice.
 *
 * Except for the page itself. [`obstructionAt`] answers `document.
 * documentElement` when the hit test finds nothing at all, and every element
 * is a descendant of that, so the ancestor sentence would end in "act on the
 * ancestor" about `<html>` — advice with nothing behind it. The page is
 * nobody's card; those keep the plain wording, which is merely odd rather
 * than an instruction to do something pointless.
 */
function obscuredBy(cover: Element, target: Element): string {
  const named = describe(target)
  const actionable =
    cover !== document.documentElement && cover !== document.body
  if (!actionable || !isAncestorOf(cover, target))
    return `${describe(cover)} is on top of ${named} where a pointer would land`
  const shared = textOf(cover) === textOf(target)
  return (
    `${describeNode(cover, !shared)} is an ancestor of ${named} and paints over it where a ` +
    `pointer would land — act on the ancestor, the way a person clicking the card would.`
  )
}

/** Whether `maybe` is above `node` in the tree, shadow boundaries included. */
function isAncestorOf(maybe: Element, node: Node): boolean {
  for (let up = parentOf(node); up; up = parentOf(up))
    if (up === maybe) return true
  return false
}

/** `null` rather than a throw where the engine has no hit testing at all —
 *  one rule for both callers, and a throw from here would come back as a
 *  broken evaluation rather than as one of this file's refusals. */
function deepElementFromPoint(x: number, y: number): Element | null {
  if (typeof document.elementFromPoint !== "function") return null
  let el = document.elementFromPoint(x, y)
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

function parentOf(node: Node): Node | null {
  const parent = node.parentNode
  return parent instanceof ShadowRoot ? parent.host : parent
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

// jsdom has no `PointerEvent`; the tests that run there exercise the mouse
// half of the sequence and a real engine gets both.
const PointerCtor: typeof MouseEvent =
  typeof PointerEvent === "function" ? PointerEvent : MouseEvent

/**
 * The event sequence a click is made of, delivered to the element.
 *
 * Pointer events as well as mouse events: a component library that opens on
 * `pointerdown` (Radix, Headless UI) never sees a bare `click`. Focus is
 * moved by hand after `mousedown`, since that is the engine's default action
 * for a real one and a dispatched one has no default action at all — but only
 * when nobody cancelled it, which is the same rule the engine applies.
 */
export function clickAt(
  el: Element,
  point: Point,
  button: PointerButton,
  count: number,
  stillCurrent: () => boolean = () => true
): number {
  const buttonCode = button === "right" ? 2 : 0
  const held = button === "right" ? 2 : 1
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: buttonCode,
  }
  const pointer = (type: string, init: PointerEventInit = {}) =>
    el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init,
      } as PointerEventInit)
    )
  const mouse = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent(type, { ...base, ...init }))

  enter(el, point)
  let delivered = 0
  for (let i = 1; i <= count; i++) {
    // The first click may have changed the page — a link to a fragment, a
    // button that re-renders — and the second is owed to the element as it
    // was named, not to whatever it is now.
    if (i > 1 && !stillCurrent()) break
    const downOk = pointer("pointerdown", { detail: i, buttons: held })
    // Cancelling `pointerdown` suppresses the compatibility mouse events
    // (`mousedown`, `mouseup`) and with them the focus change, and leaves
    // `click`: that is the Pointer Events rule, and a handler that cancels
    // pointerdown to keep focus where it is relies on it.
    if (downOk) {
      const mouseDownOk = mouse("mousedown", { detail: i, buttons: held })
      if (mouseDownOk) focusFrom(el)
    }
    pointer("pointerup", { detail: i, buttons: 0 })
    if (downOk) mouse("mouseup", { detail: i, buttons: 0 })
    // A dispatched `click` still runs the element's activation behaviour —
    // a link follows its href, a submit button submits, a checkbox toggles —
    // which is what makes this a click and not a notification of one.
    if (button === "right") mouse("contextmenu", { detail: i })
    else mouse("click", { detail: i })
    delivered = i
  }
  // Only for a run that completed: a run stopped short because the page
  // moved has no business sending one more event to the element as it was.
  if (button === "left" && count >= 2 && delivered === count)
    mouse("dblclick", { detail: delivered })
  return delivered
}

/** A form control a person could not operate: `disabled` on itself or
 *  through a disabled `<fieldset>`. */
export function isDisabledControl(el: Element): boolean {
  try {
    return el.matches(":disabled")
  } catch {
    return (el as HTMLButtonElement).disabled === true
  }
}

/** Laid out and not hidden — what a retarget from a label or a wrapper may
 *  land on. A person cannot type into a control that is not on the page.
 *
 *  `checkVisibility` where the engine has it (it answers for the ancestors
 *  too); otherwise the ancestors are walked, because a control under a
 *  `display: none` parent reports its own display as whatever it was set
 *  to, not as none. */
function isRendered(el: Element): boolean {
  const check = (
    el as Element & {
      checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean
    }
  ).checkVisibility
  if (typeof check === "function")
    return check.call(el, { visibilityProperty: true })
  if (getComputedStyle(el).visibility === "hidden") return false
  for (let node: Element | null = el; node; node = parentElementOf(node)) {
    const style = getComputedStyle(node) as CSSStyleDeclaration & {
      contentVisibility?: string
    }
    if (style.display === "none" || style.contentVisibility === "hidden")
      return false
  }
  return true
}

/** Just the arrival: what a pointer does when it comes to rest over `el`. */
export function hoverAt(el: Element, point: Point): void {
  enter(el, point)
}

function enter(el: Element, point: Point): void {
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
  }
  const pointer = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init,
      } as PointerEventInit)
    )
  const mouse = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent(type, { ...base, ...init }))
  pointer("pointerover")
  pointer("pointerenter", { bubbles: false })
  mouse("mouseover")
  mouse("mouseenter", { bubbles: false })
  pointer("pointermove")
  mouse("mousemove")
}

/** Focus the nearest focusable ancestor-or-self, or blur whatever has focus
 *  when there is none — both being what a real mousedown does. */
function focusFrom(el: Element): void {
  for (let node: Element | null = el; node; node = parentElementOf(node)) {
    if (node instanceof HTMLElement && isFocusable(node)) {
      node.focus({ preventScroll: true })
      return
    }
  }
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

function parentElementOf(el: Element): Element | null {
  const parent = el.parentNode
  if (parent instanceof ShadowRoot) return parent.host
  return parent instanceof Element ? parent : null
}

function isFocusable(el: HTMLElement): boolean {
  // `tabIndex` is 0 for form controls and links with an href and -1 for the
  // rest, except that an explicit `tabindex="-1"` still takes focus from a
  // click — it only leaves the tab order.
  return el.tabIndex >= 0 || el.hasAttribute("tabindex") || el.isContentEditable
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TextControl = HTMLInputElement | HTMLTextAreaElement

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "file",
  "image",
  "hidden",
])

function isTextControl(el: Element): el is TextControl {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)
}

/** The thing that takes text, starting from what the agent named: the field
 *  itself, the control a label is for, the editing host around a
 *  contenteditable node, or a field inside a wrapper the tree named instead. */
function editableFrom(el: Element): TextControl | HTMLElement | null {
  if (isTextControl(el)) return el
  // Leaving the named element for another is allowed only towards a control
  // a person could reach from it: one that is on the page.
  const reachable = (candidate: Element | null | undefined) =>
    candidate && isTextControl(candidate) && isRendered(candidate)
      ? candidate
      : null
  if (el instanceof HTMLLabelElement) return reachable(el.control)
  if (el instanceof HTMLElement && el.isContentEditable) {
    let host: HTMLElement = el
    while (
      host.parentElement instanceof HTMLElement &&
      host.parentElement.isContentEditable
    )
      host = host.parentElement
    return host
  }
  return reachable(el.querySelector("input:not([type=hidden]), textarea"))
}

/**
 * Replace the field's value with `text`, the way a person selecting all and
 * typing would.
 *
 * `execCommand("insertText")` first: it goes through the engine's own editing
 * path, so the `beforeinput` / `input` events it fires are the ones the page
 * would get from a keyboard. It is not implemented for every input type (a
 * `number` field has no selection to replace), so when it declines, or the
 * value did not end up as asked, the value is set directly through the
 * prototype's setter and an `input` event is dispatched by hand. A framework
 * that tracks the value on the instance (React) sees the change either way:
 * this world's prototype setter is the native one, and an expando the page
 * put on the node is not visible from here.
 */
export function typeInto(el: Element, text: string): ActionFailure | null {
  const target = editableFrom(el)
  if (!target)
    return { error: "not-editable", detail: `${describe(el)} takes no text` }
  if (isTextControl(target)) {
    // `:disabled`, not the own flag: a disabled `<fieldset>` disables the
    // fields in it without setting anything on them.
    if (isDisabledControl(target))
      return {
        error: "disabled",
        detail: `${describe(target)} is disabled`,
      }
    if (target.readOnly)
      return {
        error: "not-editable",
        detail: `${describe(target)} is read-only`,
      }
    target.focus({ preventScroll: true })
    replaceValue(target, text)
    return null
  }
  target.focus({ preventScroll: true })
  replaceContents(target, text)
  return null
}

function replaceValue(input: TextControl, text: string): void {
  let done = false
  try {
    input.select()
    done =
      text === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, text)
  } catch {
    done = false
  }
  if (!done || input.value !== text) {
    setNativeValue(input, text)
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      })
    )
  }
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

function setNativeValue(el: TextControl, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

function replaceContents(host: HTMLElement, text: string): void {
  const selection = window.getSelection()
  if (selection) {
    const range = document.createRange()
    range.selectNodeContents(host)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  let done = false
  try {
    done =
      text === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, text)
  } catch {
    done = false
  }
  if (!done) {
    host.textContent = text
    host.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      })
    )
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type KeyDescription = {
  key: string
  code: string
  keyCode: number
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** A single character, which a keypress would insert. */
  printable: boolean
}

const NAMED_KEYS: Record<
  string,
  { code: string; keyCode: number; key?: string }
> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, key: " " },
}
for (let n = 1; n <= 12; n++)
  NAMED_KEYS[`F${n}`] = { code: `F${n}`, keyCode: 111 + n }

const KEY_ALIASES: Record<string, string> = {
  Return: "Enter",
  Esc: "Escape",
  Del: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  " ": "Space",
  Spacebar: "Space",
}

const MODIFIER_ALIASES: Record<
  string,
  keyof Pick<KeyDescription, "ctrl" | "shift" | "alt" | "meta">
> = {
  Control: "ctrl",
  Ctrl: "ctrl",
  Shift: "shift",
  Alt: "alt",
  Option: "alt",
  Meta: "meta",
  Cmd: "meta",
  Command: "meta",
  Super: "meta",
}

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
}

/**
 * `"Enter"`, `"a"`, `"Control+Shift+k"`, `"Meta+Enter"` → what to put on the
 * `KeyboardEvent`. `null` for a name this table does not know: an agent
 * asking for `"Foo"` should hear so, not have a key called Foo dispatched.
 *
 * `code` and `keyCode` are best effort from a US layout — handlers overwhelmingly
 * read `key`, and those two are filled in for the ones that read the others.
 */
export function keyDescription(spec: string): KeyDescription | null {
  const parts = spec.split("+")
  // A literal "+" ("Shift++") splits into empty parts; put one back.
  const last = parts.pop() ?? ""
  let name = last === "" && spec.endsWith("+") ? "+" : last
  const mods = { ctrl: false, shift: false, alt: false, meta: false }
  for (const part of parts) {
    if (part === "") continue
    const mod = MODIFIER_ALIASES[part]
    if (!mod) return null
    mods[mod] = true
  }
  name = KEY_ALIASES[name] ?? name
  if (name.length === 1) {
    const upper = name.toUpperCase()
    let code = ""
    let keyCode = 0
    if (/[A-Z]/.test(upper)) {
      code = `Key${upper}`
      keyCode = upper.charCodeAt(0)
    } else if (/[0-9]/.test(name)) {
      code = `Digit${name}`
      keyCode = name.charCodeAt(0)
    } else if (PUNCTUATION[name]) {
      ;({ code, keyCode } = PUNCTUATION[name])
    }
    return { key: name, code, keyCode, ...mods, printable: true }
  }
  const named = NAMED_KEYS[name]
  if (!named) return null
  return {
    key: named.key ?? name,
    code: named.code,
    keyCode: named.keyCode,
    ...mods,
    printable: false,
  }
}

/**
 * Press `key` on `el`, or on whatever has focus when `el` is `null`.
 *
 * `keydown`, then — unless a handler cancelled it — what the engine would do
 * with the key, then `keyup`. The default actions emulated are the ones an
 * agent presses a key *for*: Enter submits the form a text field is in (via
 * its default button, so the button's own handler runs) or activates a button
 * or link; Space activates a button; Tab moves focus; Backspace and Delete
 * edit; PageUp, PageDown, Home and End scroll; a printable key types. Arrow
 * keys and Escape dispatch and do nothing further, which is what they do on
 * most pages, whose handlers act on `keydown` — and what they do inside a
 * `<select>` or a text field is move a selection, not a viewport, so a guess
 * here would be wrong as often as right.
 *
 * Answers with what the key did rather than with "nothing went wrong", so a
 * scroll that had nowhere left to go is distinguishable from one that moved
 * the page. `"error" in` it says which kind of answer it is, the way
 * [`pointAt`]'s does.
 */
export function pressOn(
  el: Element | null,
  spec: string
): ActionFailure | Pressed {
  const desc = keyDescription(spec)
  if (!desc)
    return {
      error: "unsupported",
      detail: `"${spec}" is not a key this browser knows`,
    }
  if (el && isDisabledControl(el))
    return { error: "disabled", detail: `${describe(el)} is disabled` }
  if (el instanceof HTMLElement && deepActiveElement() !== el)
    el.focus({ preventScroll: true })
  const target = el ?? deepActiveElement() ?? document.body
  if (!target)
    return { error: "not-visible", detail: "the page has no body yet" }
  const init: KeyboardEventInit = {
    key: desc.key,
    code: desc.code,
    keyCode: desc.keyCode,
    which: desc.keyCode,
    ctrlKey: desc.ctrl,
    shiftKey: desc.shift,
    altKey: desc.alt,
    metaKey: desc.meta,
    bubbles: true,
    cancelable: true,
    composed: true,
  } as KeyboardEventInit
  let scrolled: ScrollReport | null = null
  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init))
  if (proceed) {
    const plain = !desc.ctrl && !desc.alt && !desc.meta
    if (desc.printable && plain) {
      if (
        target.dispatchEvent(
          new KeyboardEvent("keypress", {
            ...init,
            charCode: desc.key.charCodeAt(0),
          } as KeyboardEventInit)
        )
      )
        insertTyped(target, desc.key)
    } else {
      scrolled = defaultActionFor(target, desc, el !== null) ?? null
    }
  }
  target.dispatchEvent(
    new KeyboardEvent("keyup", { ...init, cancelable: false })
  )
  return { scrolled }
}

function deepActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement
  return active
}

function insertTyped(target: Element, char: string): void {
  const editable = editableFrom(target)
  if (!editable) return
  if (
    isTextControl(editable) &&
    (isDisabledControl(editable) || editable.readOnly)
  )
    return
  let done = false
  try {
    done = document.execCommand("insertText", false, char)
  } catch {
    done = false
  }
  if (done) return
  if (isTextControl(editable)) {
    const start = editable.selectionStart ?? editable.value.length
    const end = editable.selectionEnd ?? editable.value.length
    setNativeValue(
      editable,
      editable.value.slice(0, start) + char + editable.value.slice(end)
    )
    try {
      editable.setSelectionRange(start + char.length, start + char.length)
    } catch {
      /* not every input type has a selection */
    }
  } else {
    editable.textContent = (editable.textContent ?? "") + char
  }
  editable.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: char,
    })
  )
}

/** What the engine would do with the key. A [`ScrollReport`] when that was to
 *  scroll something; nothing for every other key, which is why the branches
 *  that do other work return bare.
 *
 *  `named` is whether the caller pointed at an element or left the key to
 *  whatever has focus — which only the scroll keys care about, and only for
 *  [`scrollerFor`]'s last resort. */
function defaultActionFor(
  target: Element,
  desc: KeyDescription,
  named: boolean
): ScrollReport | undefined {
  const plain = !desc.ctrl && !desc.alt && !desc.meta
  switch (desc.key) {
    case "Enter": {
      // Alt+Enter is not a submission anywhere; Ctrl/Meta+Enter is the usual
      // "send" chord and is treated like a plain Enter on a field.
      if (desc.alt) return
      if (target instanceof HTMLTextAreaElement && plain) {
        insertTyped(target, "\n")
        return
      }
      if (target instanceof HTMLElement && target.isContentEditable && plain) {
        try {
          document.execCommand("insertParagraph")
        } catch {
          /* leave it */
        }
        return
      }
      if (target instanceof HTMLInputElement && isTextControl(target)) {
        submitImplicitly(target)
        return
      }
      if (isActivatable(target)) (target as HTMLElement).click()
      return
    }
    case " ": {
      if (!plain) return
      if (target instanceof HTMLButtonElement || isCheckable(target)) {
        target.click()
        return
      }
      insertTyped(target, " ")
      return
    }
    case "Tab": {
      if (desc.ctrl || desc.alt || desc.meta) return
      moveFocus(target, desc.shift ? -1 : 1)
      return
    }
    case "Backspace":
    case "Delete": {
      if (!plain) return
      const editable = editableFrom(target)
      if (!editable) return
      try {
        document.execCommand(
          desc.key === "Backspace" ? "delete" : "forwardDelete"
        )
      } catch {
        /* leave it */
      }
      return
    }
    case "PageDown":
    case "PageUp":
    case "Home":
    case "End": {
      const ends = desc.key === "Home" || desc.key === "End"
      // Alt never scrolls anywhere (it is back/forward on some platforms).
      // Ctrl and Meta do, but only with Home and End, where "jump to the very
      // top" is the chord people reach for — Ctrl+Home on Windows and Linux,
      // Cmd+Up... and Cmd+Home where a keyboard has the key. A modified page
      // key is not a scroll anywhere, so those stay plain.
      if (desc.alt) return
      if (!ends && !plain) return
      // In a listbox every one of these changes the selection rather than
      // scrolling anything, and emulating that is not what an agent presses
      // PageDown for. Neither, then.
      if (target instanceof HTMLSelectElement) return
      // Home and End put the caret at the ends of a line — and with Ctrl, at
      // the ends of the text — while the engine scrolls only as far as
      // following the caret needs. Scrolling the document out from under a
      // field someone is in would be plainly wrong. PageUp and PageDown are
      // not caret keys in the same way: a single-line field has no pages to
      // move through and the engine pages the document instead, which is also
      // what walking to the nearest scroller does — and a textarea with its
      // own overflow is that scroller, so it pages itself. Which is why only
      // the caret pair is held back here, and a press that arrives with a
      // field focused — the ordinary state after typing into one — still
      // scrolls.
      const caret =
        isTextControl(target) ||
        (target instanceof HTMLElement && target.isContentEditable)
      if (caret && ends) return
      return scrollByKey(target, desc.key, named)
    }
    default:
      return
  }
}

/** How much of the scroller a page key moves, matching what the engines
 *  themselves do: not a whole viewport, so the line at the fold stays on
 *  screen and a reader keeps their place. */
const PAGE_FRACTION = 0.875

/**
 * Do what the engine would do with a scroll key, to the box the key belongs
 * to.
 *
 * Synthetic key events carry no default action at all — `isTrusted` is false,
 * and scrolling is the engine's, not the page's. Without this a PageDown
 * dispatches, no handler objects, and `pressOn` reports it done while the
 * page has not moved: a *false success*, which is worse for an agent than a
 * refusal, because the next snapshot looks like a page that refused to scroll
 * rather than a key that never landed.
 *
 * Measured rather than assumed, and the measurement is the answer: the same
 * false success comes back in a quieter form once the box is at its end, and
 * the report is what lets a caller stop instead of pressing on into the
 * bottom of the page.
 *
 * Vertical only, including Home and End, which is not the guess their names
 * invite. An engine's own Home leaves `scrollLeft` exactly where it was —
 * in a box scrolled both down and across, in the document's scroller, and
 * even in a box that can *only* scroll across, where the axis it moves has
 * nowhere to go and it still declines the other one. Measured with trusted
 * keys in the probe rather than reasoned about, and pinned there, because
 * "Home means go to the start" is the kind of guess that gets acted on.
 */
function scrollByKey(from: Element, key: string, named: boolean): ScrollReport {
  const scroller = scrollerFor(from, named)
  const before = scroller.scrollTop
  const page = Math.max(1, scroller.clientHeight * PAGE_FRACTION)
  switch (key) {
    case "PageDown":
      scrollTopTo(scroller, before + page)
      break
    case "PageUp":
      scrollTopTo(scroller, before - page)
      break
    case "Home":
      scrollTopTo(scroller, 0)
      break
    case "End":
      scrollTopTo(scroller, scroller.scrollHeight)
      break
  }
  // Read back rather than computed from what was asked for: the engine
  // clamps at both ends, a page can cancel its own smooth scroll, and what
  // matters to the caller is where the box actually is.
  const after = scroller.scrollTop
  return {
    by: Math.round(after - before),
    top: Math.round(after),
    max: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
  }
}

/**
 * Put the scroller at `top`, past either end if that is what was asked — the
 * engine clamps, and clamping here as well would only disagree with it.
 *
 * `scrollTo` with `instant` rather than the `scrollTop` setter, because both
 * honour the page's `scroll-behavior` and a page that asked for `smooth`
 * would still be gliding when the agent reads the page back in its next call.
 * The setter is the fallback for an engine without CSSOM-View's methods:
 * every engine codeg ships on has them, and a throw from in here would come
 * back as a broken evaluation rather than as one of this file's refusals,
 * which is a bad trade for one line.
 */
function scrollTopTo(el: Element, top: number): void {
  if (typeof el.scrollTo === "function")
    el.scrollTo({ top, behavior: "instant" as ScrollBehavior })
  else el.scrollTop = top
}

/**
 * The box a scroll key pressed on `from` would move: the nearest ancestor
 * that scrolls vertically, else the document's own scroller — and, for a
 * press that named no element, the box the page keeps its scrolling in.
 *
 * Nearest-ancestor rather than always-the-window because that is the rule a
 * person sees — a key pressed inside a scrollable panel scrolls the panel.
 * It also falls out right for the two shapes that matter here: a press with
 * no ref lands on whatever has focus, which on a page nobody has clicked is
 * `document.body` and leaves the document's own scroller as the only
 * candidate, and a press on a ref inside an overflow pane scrolls the pane.
 *
 * There is always an answer, so a caller never has to have a story for there
 * being none: the walk ends at the document's scroller, which every document
 * with a body has.
 */
export function scrollerFor(from: Element, named = true): Element {
  const own = scrollableAncestorOf(from)
  if (own) return own
  const page = document.scrollingElement ?? document.documentElement
  if (named || page.scrollHeight - page.clientHeight > 1) return page
  // The page's own scroller has nothing to move — which would be the end of
  // it, were it not the layout most applications ship: `html, body {
  // overflow: hidden }` with a full-height box inside doing the scrolling. A
  // ref-less key lands on `document.body`, whose walk ends right here, so the
  // press would answer "no more content than fits" about a page with
  // thousands of pixels left in it. That is the false success this file
  // exists to remove, moved one step along rather than removed.
  //
  // So ask the same question of whatever is under the middle of the screen,
  // which is the box a wheel resting there would turn, and the box a person
  // would have clicked into before pressing the key. Where the middle of the
  // screen is a small box rather than the shell — a dashboard tile, a middle
  // column — this answers about that box, and the report carries no name for
  // what it moved, so `top === max` reads as the end of the page rather than
  // the end of the tile. Accepted: the answer before this existed was
  // `max: 0` on the first press, which stops a caller sooner and for a reason
  // that is not true either.
  //
  // Only for a press that named nothing, and only when the page itself cannot
  // move. A caller that gave a `ref` pointed at a box and is owed an answer
  // about *that* box: moving a different one and reporting the pixels would
  // read as the named box having scrolled, which is a new false success for
  // the one this removes. And the gate on the page keeps a key that a
  // document wanted from ever being taken from it.
  const middle = deepElementFromPoint(
    Math.floor(window.innerWidth / 2),
    Math.floor(window.innerHeight / 2)
  )
  return (middle && scrollableAncestorOf(middle)) ?? page
}

function scrollableAncestorOf(from: Element): Element | null {
  for (let node: Element | null = from; node; node = parentElementOf(node)) {
    // The document's scroller answers for these two whatever the quirks mode
    // and whichever of them the engine picked, so let it.
    if (node === document.body || node === document.documentElement) break
    if (scrollsVertically(node)) return node
  }
  return null
}

function scrollsVertically(el: Element): boolean {
  // A box with no height of its own is a collapsed one — `height: 0;
  // overflow: auto` is how an accordion is animated, and it satisfies the
  // test below while having nowhere to put a page key. Taking it would both
  // scroll it by the one pixel `Math.max(1, …)` floors at and swallow the
  // key the document should have had.
  if (el.clientHeight <= 0) return false
  // A rounded-up `clientHeight` can sit a pixel under `scrollHeight` on a box
  // with nothing to scroll; one pixel is not a scroll either way.
  if (el.scrollHeight - el.clientHeight <= 1) return false
  const overflow = getComputedStyle(el).overflowY
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay"
}

function isActivatable(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return true
  if (el instanceof HTMLAnchorElement) return el.hasAttribute("href")
  if (el instanceof HTMLInputElement)
    return (
      el.type === "submit" ||
      el.type === "button" ||
      el.type === "reset" ||
      el.type === "image"
    )
  return false
}

function isCheckable(el: Element): el is HTMLInputElement {
  return (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  )
}

/**
 * Implicit submission, as the spec has it: click the form's default button if
 * it has one (so the button's own handler and its name/value take part);
 * otherwise submit only if there is a single field that blocks implicit
 * submission — a form with two text fields and no button does not go on
 * Enter, and neither should this.
 */
function submitImplicitly(input: HTMLInputElement): void {
  const form = input.form
  if (!form || isDisabledControl(input)) return
  const elements = Array.from(form.elements)
  const button = elements.find(
    (el) =>
      (el instanceof HTMLButtonElement && el.type === "submit") ||
      (el instanceof HTMLInputElement &&
        (el.type === "submit" || el.type === "image"))
  )
  if (button instanceof HTMLElement) {
    if (!(button as HTMLButtonElement).disabled) button.click()
    return
  }
  const blocking = elements.filter(
    (el) =>
      el instanceof HTMLInputElement &&
      isTextControl(el) &&
      el.type !== "hidden"
  )
  if (blocking.length > 1) return
  if (typeof form.requestSubmit === "function") form.requestSubmit()
  else form.submit()
}

/** Tab order as document order over the tabbable elements — the common case.
 *  `tabindex` greater than zero, and elements under a shadow root, are not
 *  ordered specially here. */
function moveFocus(from: Element, direction: 1 | -1): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]"
    )
  ).filter((el) => isTabbable(el))
  if (candidates.length === 0) return
  const index = candidates.indexOf(from as HTMLElement)
  const next =
    index === -1
      ? direction === 1
        ? candidates[0]
        : candidates[candidates.length - 1]
      : candidates[(index + direction + candidates.length) % candidates.length]
  next.focus({ preventScroll: true })
}

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false
  if ((el as HTMLInputElement).disabled) return false
  if (el instanceof HTMLInputElement && el.type === "hidden") return false
  const style = getComputedStyle(el)
  if (style.display === "none" || style.visibility === "hidden") return false
  return el.getClientRects().length > 0
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

const OPTIONS_LISTED = 20

/** Choose options by value or by visible label, and tell the page. */
export function selectIn(el: Element, values: string[]): ActionFailure | null {
  const other =
    el instanceof HTMLLabelElement
      ? el.control
      : (el.closest("select") ?? el.querySelector("select"))
  const select =
    el instanceof HTMLSelectElement
      ? el
      : other instanceof HTMLSelectElement && isRendered(other)
        ? other
        : null
  if (!select)
    return { error: "not-editable", detail: `${describe(el)} is not a select` }
  if (isDisabledControl(select))
    return { error: "disabled", detail: `${describe(select)} is disabled` }
  if (values.length === 0)
    return { error: "unsupported", detail: "no value to select" }
  if (!select.multiple && values.length > 1)
    return {
      error: "unsupported",
      detail: `${describe(select)} takes one value`,
    }
  const options = Array.from(select.options)
  const picked: HTMLOptionElement[] = []
  for (const wanted of values) {
    const matches = (o: HTMLOptionElement) =>
      o.value === wanted ||
      o.label === wanted ||
      (o.textContent ?? "").trim() === wanted
    // A disabled option cannot be chosen by a person and is not chosen here;
    // it is named in the refusal so the agent knows it exists. As the spec
    // has it: its own attribute, or a disabled `<optgroup>` it is a child of.
    const usable = (o: HTMLOptionElement) =>
      !o.disabled &&
      !(
        o.parentElement instanceof HTMLOptGroupElement &&
        o.parentElement.disabled
      )
    const option =
      options.find((o) => usable(o) && o.value === wanted) ??
      options.find((o) => usable(o) && matches(o))
    if (!option) {
      const disabled = options.find((o) => !usable(o) && matches(o))
      if (disabled)
        return {
          error: "disabled",
          detail: `option ${JSON.stringify(wanted)} in ${describe(select)} is disabled`,
        }
      const listed = options
        .slice(0, OPTIONS_LISTED)
        .map((o) => JSON.stringify(o.value || o.label))
        .join(", ")
      const more =
        options.length > OPTIONS_LISTED ? `, … (${options.length} in all)` : ""
      return {
        error: "no-option",
        detail: `no option ${JSON.stringify(wanted)} in ${describe(select)}; the options are ${listed}${more}`,
      }
    }
    picked.push(option)
  }
  select.focus({ preventScroll: true })
  for (const option of options) option.selected = false
  for (const option of picked) option.selected = true
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  select.dispatchEvent(new Event("change", { bubbles: true }))
  return null
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** How to name an element in a message: enough for a reader to find it in
 *  the tree, no more. */
export function describe(el: Element): string {
  return describeNode(el, true)
}

/** The same, with the words optional: [`obscuredBy`] drops them where they
 *  would be the other element's words repeated back. */
function describeNode(el: Element, withText: boolean): string {
  let name = el.tagName.toLowerCase()
  if (el.id) name += `#${el.id}`
  if (!withText) return name
  const text = textOf(el)
  if (text) name += ` "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`
  return name
}

function textOf(el: Element): string {
  return (el.textContent ?? "").trim().replace(/\s+/g, " ")
}

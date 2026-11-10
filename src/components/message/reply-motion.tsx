"use client"

import { Component, type ReactNode, type RefObject } from "react"

import { CHAT_MOTION, chatMotionAllowed } from "@/lib/chat-motion"

/**
 * The reply's layout changes, played rather than jumped to.
 *
 * A reply being written changes shape several times: its first step pulls the
 * prose written so far onto the rail, a step joins and pushes the turning ring
 * down, a command turns into a group of them, and when the reply is done its
 * closing prose comes off the rail and settles under the steps. Each is a new
 * layout committed at once. This plays each one: whatever is in both layouts
 * glides from where it was to where it is now, and whatever is new fades in.
 *
 * What it moves is marked `data-motion-key` — the same key on whichever
 * element stands for the same thing in either layout (the prose as a step on
 * the rail and as the answer under it, the turning ring under the prose and at
 * the foot of the steps). The layouts are read once per change of shape
 * (`shape`), never per token, and only around a reply that is being written
 * or has just been: a reply folded or unfolded by hand has its own slide, and
 * history never moves. The positions are read before React writes the new
 * layout (`getSnapshotBeforeUpdate`, the one lifecycle that runs then) and
 * after (`componentDidUpdate`); the motion is a transform and an opacity, so
 * nothing changes size under the virtual list while it plays.
 *
 * The pending reply — what stands in the thread between a send and the first
 * thing the agent says — is drawn as a reply too, in the same place. As it
 * gives way it leaves its layout behind (`handoff="give"`), and the reply that
 * takes its place starts from it (`handoff="take"`), so the turning ring moves
 * down as the first words arrive instead of jumping.
 */

/** Marks the element that stands for one thing in every layout of a reply. */
export const MOTION_KEY = "data-motion-key"
/** On a keyed element that sees to its own arrival (one that fades in late,
 *  say): nothing fades it in here. */
export const MOTION_SELF = "data-motion-self"

type Layout = Map<string, { x: number; y: number }>

/** A layout left by a pending reply, for the reply that takes its place. */
const handoffs = new WeakMap<Element, { layout: Layout; at: number }>()
/** How long a pending reply's layout waits for the reply that replaces it:
 *  they are swapped in one commit, so anything older belongs to a send that
 *  never got an answer. */
const HANDOFF_MS = 500
/** The glide each element is making, so the next change starts from wherever
 *  this one has got to. (A fade-in is left to finish: it moves no layout.) */
const gliding = new WeakMap<Element, Animation>()

function scopeOf(root: Element): Element | null {
  return root.closest(".chat-motion-scope")
}

/** Whether `element`, mounting now, comes with a reply that takes the pending
 *  reply's place (`handoff`): what the reply mounts with arrives, as rows that
 *  join a list do, rather than standing there. Asked from inside the reply as
 *  it mounts — the reply's own mount, which runs after, takes the pending
 *  reply's layout and forgets it. */
export function takesPendingPlace(element: Element): boolean {
  const scope = scopeOf(element)
  const left = scope ? handoffs.get(scope) : undefined
  return left !== undefined && performance.now() - left.at <= HANDOFF_MS
}

/** Where each keyed element sits now, from the root's top-left corner — as it
 *  is drawn, mid-glide included. */
function measure(root: HTMLElement): Layout {
  const origin = root.getBoundingClientRect()
  const layout: Layout = new Map()
  for (const element of root.querySelectorAll(`[${MOTION_KEY}]`)) {
    const key = element.getAttribute(MOTION_KEY)!
    if (layout.has(key)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    layout.set(key, { x: rect.left - origin.left, y: rect.top - origin.top })
  }
  return layout
}

function glide(element: Element, dx: number, dy: number) {
  if (typeof element.animate !== "function") return
  const animation = element.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    CHAT_MOTION.move
  )
  gliding.set(element, animation)
  animation.addEventListener("finish", () => {
    if (gliding.get(element) === animation) gliding.delete(element)
  })
}

function fadeIn(element: Element) {
  if (typeof element.animate !== "function") return
  const { duration, easing, rise } = CHAT_MOTION.enter
  element.animate(
    [
      { opacity: 0, transform: `translateY(${rise}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration, easing }
  )
}

/** Move everything keyed in `root` from `before` to where it is now. */
function play(root: HTMLElement, before: Layout) {
  const elements = [...root.querySelectorAll(`[${MOTION_KEY}]`)]
  // A glide still under way stops where it is: the new one starts from there
  // (that is where `before` saw it), and the new layout is read without it.
  for (const element of elements) {
    gliding.get(element)?.cancel()
    gliding.delete(element)
  }
  // Every position is read before anything moves: a glide applies at once,
  // and a row read after its group started gliding would be read where the
  // group's glide draws it, not where it lies.
  const origin = root.getBoundingClientRect()
  const now = new Map<Element, { x: number; y: number }>()
  for (const element of elements) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    now.set(element, { x: rect.left - origin.left, y: rect.top - origin.top })
  }
  // How far each glide moves its element, for the elements inside it: they
  // go along with it, so only the rest of their move is their own.
  const carried = new Map<Element, { dx: number; dy: number }>()
  // What fades in, for the new elements inside it: they fade with it.
  const fading: Element[] = []
  const seen = new Set<string>()
  for (const element of elements) {
    const key = element.getAttribute(MOTION_KEY)!
    if (seen.has(key)) continue
    seen.add(key)
    const at = now.get(element)
    if (!at) continue
    const was = before.get(key)
    if (!was) {
      // New. Not faded in when it brings in something already on screen —
      // a group taking in the command that was there: that one glides into
      // place, and fading its new parent would blink it out first.
      if (element.hasAttribute(MOTION_SELF)) continue
      if (fading.some((outer) => outer.contains(element))) continue
      const keepsOne = [...element.querySelectorAll(`[${MOTION_KEY}]`)].some(
        (inner) => before.has(inner.getAttribute(MOTION_KEY)!)
      )
      if (keepsOne) continue
      fadeIn(element)
      fading.push(element)
      continue
    }
    const dx = was.x - at.x
    const dy = was.y - at.y
    let carrier: Element | null = element.parentElement
    while (carrier && carrier !== root && !carried.has(carrier)) {
      carrier = carrier.parentElement
    }
    const by = carrier && carrier !== root ? carried.get(carrier) : undefined
    const ownX = dx - (by?.dx ?? 0)
    const ownY = dy - (by?.dy ?? 0)
    if (Math.abs(ownX) < 1 && Math.abs(ownY) < 1) continue
    carried.set(element, { dx, dy })
    glide(element, ownX, ownY)
  }
}

export interface ReplyMotionProps {
  /** Changes whenever the reply's layout changes shape: a step joins, the
   *  prose moves between the rail and the answer, the reply ends. */
  shape: string
  /** The reply is being written. Its layout moves while it is, and in the
   *  change that ends it; never in history. */
  live: boolean
  /** Whether the steps are open. Folding them by hand has a slide of its own,
   *  so that change plays nothing here. */
  open: boolean
  /** The reply's root element; every key is measured from its corner. */
  rootRef: RefObject<HTMLElement | null>
  /** `give`: the pending reply, leaving its layout as it goes; `take`: a
   *  reply that may be taking that place. */
  handoff?: "give" | "take"
  children: ReactNode
}

export class ReplyMotion extends Component<ReplyMotionProps> {
  componentDidMount() {
    const { handoff, live, rootRef } = this.props
    const root = rootRef.current
    if (handoff !== "take" || !live || !root) return
    const scope = scopeOf(root)
    const left = scope ? handoffs.get(scope) : undefined
    if (!scope || !left) return
    handoffs.delete(scope)
    if (performance.now() - left.at > HANDOFF_MS || !chatMotionAllowed()) {
      return
    }
    play(root, left.layout)
  }

  getSnapshotBeforeUpdate(previous: ReplyMotionProps): Layout | null {
    const { shape, live, open, rootRef } = this.props
    if (previous.shape === shape || previous.open !== open) return null
    if (!live && !previous.live) return null
    const root = rootRef.current
    if (!root || !chatMotionAllowed()) return null
    return measure(root)
  }

  componentDidUpdate(
    _previous: ReplyMotionProps,
    _state: unknown,
    before: Layout | null
  ) {
    const root = this.props.rootRef.current
    if (before && root) play(root, before)
  }

  componentWillUnmount() {
    const { handoff, rootRef } = this.props
    const root = rootRef.current
    if (handoff !== "give" || !root || !chatMotionAllowed()) return
    // Still in the document: React takes the nodes out after this runs.
    const scope = scopeOf(root)
    if (scope) {
      handoffs.set(scope, { layout: measure(root), at: performance.now() })
    }
  }

  render() {
    return this.props.children
  }
}

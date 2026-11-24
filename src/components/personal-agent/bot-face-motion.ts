/**
 * The faces that move (`bot-avatar.tsx`): one animation frame loop for all
 * of them, each face's drawing written straight into its group — no React
 * render per frame.
 *
 * A face is in the loop only while its pose changes: easing to a new look,
 * turning toward the pointer and back, glancing, or in a look that moves
 * (thinking, working; a done face's turn, a failed one's shake). At rest it
 * leaves the loop, and the loop stops when no face is in it. A face draws
 * again only when its pose has changed enough to show (`poseKey`), at most
 * some thirty times a second unless the pointer is on it, and not while it
 * is off screen; the loop sleeps with the window hidden, as frames do. While
 * only its eyes move (a glance) its body stays the page's drawing at rest
 * (`restFace`); turned, it is drawn whole, and back at rest it is the
 * page's again.
 *
 * The hops, breaths and blinks are CSS (globals.css): they move the drawing
 * whole, and cost no drawing.
 */

import type { BotLook } from "@/lib/types"

import { defineFace } from "./bot-face-page"
import {
  faceMarkup,
  isMoving,
  isRestBody,
  isSnapping,
  norm,
  poseAt,
  poseKey,
  restFace,
  restPose,
  type FacePose,
} from "./bot-shapes"

/** What a face is drawn as and doing. */
export interface FaceMotionState {
  shape: string
  small: boolean
  look: BotLook
  /** Where its eyes glance at rest (in the face's units), or `null`. */
  glance: readonly [number, number] | null
}

export interface FaceMotion {
  /** What it is now. The first call also says which look its drawing shows
   *  as it is (`drawn`), so it eases from there. */
  set(state: FaceMotionState, drawn?: BotLook): void
  /** The pointer from its middle, in its own sizes, or `null` once gone. */
  aim(ptr: readonly [number, number] | null): void
  dispose(): void
}

/** How far a face turns toward its pose each 60th of a second. */
const EASE_TURN = 0.14
const EASE_EYES = 0.2
/** The least time between two drawings of a face the pointer is not on. */
const DRAW_EVERY_MS = 32

interface Face extends FaceMotionState {
  el: Element
  id: string
  ptr: readonly [number, number] | null
  /** When its look began, in frame time (`-1`: at its next frame). */
  since: number
  cur: FacePose | null
  drawnKey: string
  drawnAt: number
  steppedAt: number
  visible: boolean
}

const active = new Set<Face>()
let frame = 0

function wake(face: Face) {
  active.add(face)
  if (!frame && typeof requestAnimationFrame === "function") {
    frame = requestAnimationFrame(tick)
  }
}

function tick(now: number) {
  frame = 0
  for (const face of active) {
    if (step(face, now)) active.delete(face)
  }
  if (active.size) frame = requestAnimationFrame(tick)
}

const ease = (k: number, dt: number) => 1 - Math.pow(1 - k, dt / (1000 / 60))

/** One frame of a face; `true` once it is at rest (drawn as it is, or out
 *  of sight). */
function step(face: Face, now: number): boolean {
  if (!face.el.isConnected) return true
  if (face.since < 0) face.since = now
  const t = (now - face.since) / 1000
  const target = poseAt(face.shape, face.look, t, face.ptr, face.glance)
  const dt = face.steppedAt ? Math.min(100, now - face.steppedAt) : 1000 / 60
  face.steppedAt = now
  const cur = face.cur ?? target
  const e = ease(EASE_EYES, dt)
  const gx = cur.gx + (target.gx - cur.gx) * e
  const gy = cur.gy + (target.gy - cur.gy) * e
  let n = target.n
  // A spin or a shake turns it as it goes; anything else it eases to.
  if (!isSnapping(face.look, t)) {
    const k = ease(EASE_TURN, dt)
    n = norm([
      cur.n[0] + (target.n[0] - cur.n[0]) * k,
      cur.n[1] + (target.n[1] - cur.n[1]) * k,
      cur.n[2] + (target.n[2] - cur.n[2]) * k,
    ])
  }
  const settled =
    !isMoving(face.look, t) &&
    Math.abs(n[0] - target.n[0]) +
      Math.abs(n[1] - target.n[1]) +
      Math.abs(n[2] - target.n[2]) <
      0.002 &&
    Math.abs(gx - target.gx) + Math.abs(gy - target.gy) < 0.2
  face.cur = settled
    ? target
    : { n, gx, gy, open: target.open, star: target.star }
  if (!face.visible) return settled
  if (!settled && !face.ptr && now - face.drawnAt < DRAW_EVERY_MS) return false
  const key = poseKey(face.cur)
  if (key !== face.drawnKey) {
    face.el.innerHTML = draw(face, face.cur)
    face.drawnKey = key
    face.drawnAt = now
  }
  return settled
}

/** A face's drawing for a pose: its look's body at rest (the page's, a
 *  `<use>`) while only its eyes have moved, else a drawing of its own. */
function draw(face: Face, pose: FacePose): string {
  const { shape, look, small } = face
  if (isRestBody(shape, look, pose)) {
    defineFace(shape, look, small)
    return restFace(shape, look, small, pose)
  }
  return faceMarkup(shape, look, pose, small, face.id)
}

/** Start moving the face drawn in `el` (its drawing's ids from `id`). */
export function startFaceMotion(el: Element, id: string): FaceMotion {
  let face: Face | null = null
  let gone = false
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1]
          if (!face || !entry) return
          face.visible = entry.isIntersecting
          if (face.visible) wake(face)
        })
      : null
  io?.observe(el)
  return {
    set(state, drawn) {
      if (gone) return
      if (!face) {
        const rest = restPose(state.shape, drawn ?? state.look)
        face = {
          ...state,
          el,
          id,
          ptr: null,
          since: -1,
          cur: rest,
          drawnKey: poseKey(rest),
          drawnAt: 0,
          steppedAt: 0,
          visible: true,
        }
        // What the page drew is the look it shows: unless it is another,
        // nothing to do until something moves it.
        if (
          (drawn ?? state.look) !== state.look ||
          isMoving(state.look, 0) ||
          state.glance
        ) {
          wake(face)
        }
        return
      }
      const redraw = state.shape !== face.shape || state.small !== face.small
      if (state.look !== face.look) face.since = -1
      if (redraw) {
        // The page drew it anew, at its look's rest.
        face.cur = restPose(state.shape, drawn ?? state.look)
        face.drawnKey = ""
      }
      face.shape = state.shape
      face.small = state.small
      face.look = state.look
      face.glance = state.glance
      wake(face)
    },
    aim(ptr) {
      if (!face || gone) return
      if (!ptr && !face.ptr) return
      face.ptr = ptr
      wake(face)
    },
    dispose() {
      gone = true
      io?.disconnect()
      if (face) active.delete(face)
      face = null
    },
  }
}

/** Test seam: faces in the loop. */
export function __activeFacesForTests(): number {
  return active.size
}

/** Test seam: an empty loop (a frame asked of a fake clock since gone
 *  never comes). */
export function __resetFaceMotionForTests(): void {
  active.clear()
  frame = 0
}

/**
 * Gesture vocabulary for the workspace floating ball.
 *
 * Pure — no DOM, no timers — so the recogniser can be exercised directly and
 * the component above it stays a thin view. The vocabulary and thresholds are
 * carried over from the MindFS blue-ring menu (`quickSwitch.ts`) so the muscle
 * memory of that app transfers unchanged.
 *
 * Two families:
 * - click-scale: tap / doubleTap / longPress, decided on duration alone.
 * - path gestures: one-stroke swipes (left/right/up and the two upward
 *   diagonals), two-stage trails that start upward and turn, and round-trip
 *   trails that come back on themselves.
 *
 * Path tracking is anchor-based, not displacement-from-origin based: each time
 * the direction changes, the anchor moves to the finger. Summing displacement
 * from the origin makes a ↑ then ↓ trail cancel out into a single straight
 * stroke, which is how the original implementation mistook "upDown" for a
 * diagonal.
 */

export type FloatingBallGesture =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "left"
  | "right"
  | "up"
  | "upLeft"
  | "upRight"
  | "upThenLeft"
  | "upThenRight"
  | "upLeftThenRight"
  | "upRightThenLeft"
  | "upRightThenDown"
  | "upLeftThenDown"
  | "upDown"
  | "rightThenLeft"
  | "leftThenRight"

export type FloatingBallAction =
  | "panel"
  | "newConversation"
  | "toggleSidebar"
  | "toggleSearch"
  | "toggleTerminal"
  | "nextTab"
  | "prevTab"
  | "reopenClosedTab"
  | "openFolder"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "stopGenerating"
  | "openSettings"

export const FLOATING_BALL_GESTURES: readonly FloatingBallGesture[] = [
  "tap",
  "doubleTap",
  "longPress",
  "left",
  "right",
  "up",
  "upLeft",
  "upRight",
  "upThenLeft",
  "upThenRight",
  "upLeftThenRight",
  "upRightThenLeft",
  "upRightThenDown",
  "upLeftThenDown",
  "upDown",
  "rightThenLeft",
  "leftThenRight",
]

/**
 * What each gesture does out of the box.
 *
 * `upLeftThenRight` and `upRightThenLeft` are deliberately unbound: the trails
 * that reach them pass through the two-stage bindings above, so a stray
 * continuation would fire a second action on the way.
 */
export const DEFAULT_FLOATING_BALL_BINDINGS: Readonly<
  Record<FloatingBallGesture, FloatingBallAction | null>
> = {
  tap: "panel",
  doubleTap: "toggleTerminal",
  longPress: "openSettings",
  left: "newConversation",
  right: "toggleSidebar",
  up: "panel",
  upLeft: "toggleSearch",
  upRight: "nextTab",
  upThenLeft: "prevTab",
  upThenRight: "reopenClosedTab",
  upLeftThenRight: null,
  upRightThenLeft: null,
  upRightThenDown: "stopGenerating",
  upLeftThenDown: "zoomOut",
  upDown: "openFolder",
  rightThenLeft: "zoomReset",
  leftThenRight: "zoomIn",
}

/** A press held at least this long is a long press, not a tap. */
export const LONG_PRESS_MS = 600
/** A second press within this window of the first makes it a double tap. */
export const DOUBLE_TAP_MS = 300
/**
 * Movement faster than this after touchdown is a gesture; slower is a drag of
 * the ball itself. Both start with the same pointer, so time is what tells
 * them apart.
 */
export const GESTURE_ONSET_MS = 250
/** Below this displacement nothing counts as movement at all. */
export const MOVE_PX = 8
/** A single stroke must reach this far on an axis to name a direction. */
export const SWIPE_PX = 30
/** Reverse travel within one stage that starts a new stage. */
export const SEGMENT_GAP_PX = 22

type Segment = "L" | "R" | "U" | "D" | "UL" | "UR" | "DL" | "DR"

const OPPOSITE: Record<Segment, Segment> = {
  L: "R",
  R: "L",
  U: "D",
  D: "U",
  UL: "DR",
  UR: "DL",
  DL: "UR",
  DR: "UL",
}

function isOpposite(a: Segment | null, b: Segment): boolean {
  return a !== null && OPPOSITE[a] === b
}

/**
 * Name the direction of one stage, or null while it is still too short.
 *
 * A stage that is long on both axes is a diagonal; otherwise the longer axis
 * wins, and only when it dominates by 1.6x — a nearly square 30x28 stroke is
 * still "up", not "upLeft".
 */
function classifySegment(dx: number, dy: number): Segment | null {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx >= SWIPE_PX && ady >= SWIPE_PX) {
    if (dy < 0) return dx < 0 ? "UL" : "UR"
    return dx < 0 ? "DL" : "DR"
  }
  if (adx >= SWIPE_PX && adx > ady * 1.6) return dx < 0 ? "L" : "R"
  if (ady >= SWIPE_PX && ady > adx * 1.6) return dy < 0 ? "U" : "D"
  return null
}

/** The last two stages of a trail, folded into the gesture they spell. */
function foldTrail(path: readonly Segment[]): FloatingBallGesture | null {
  if (path.length < 2) return null
  const a = path[path.length - 2]
  const b = path[path.length - 1]
  if (a === "L" && b === "R") return "leftThenRight"
  if (a === "R" && b === "L") return "rightThenLeft"
  if (a === "U" && b === "D") return "upDown"
  if (a === "U" && b === "L") return "upThenLeft"
  if (a === "U" && b === "R") return "upThenRight"
  if (a === "UL" && b === "R") return "upLeftThenRight"
  if (a === "UR" && b === "L") return "upRightThenLeft"
  if (a === "UR" && b === "D") return "upRightThenDown"
  if (a === "UL" && b === "D") return "upLeftThenDown"
  return null
}

/** A single stage as a gesture. Downward strokes are unbound by default. */
function singleStage(stage: Segment): FloatingBallGesture | null {
  switch (stage) {
    case "L":
      return "left"
    case "R":
      return "right"
    case "U":
      return "up"
    case "UL":
      return "upLeft"
    case "UR":
      return "upRight"
    default:
      return null
  }
}

export interface FloatingBallTracker {
  /** Touchdown. */
  start(x: number, y: number): void
  /** Every pointer sample while the press is down. */
  move(x: number, y: number): void
  /** Lift-off: the path gesture, or null when this press was not one. */
  end(x: number, y: number): FloatingBallGesture | null
  /** Whether the press has travelled far enough to be a gesture at all. */
  readonly moved: boolean
  /** Stages recognised so far, oldest first. Exposed for tests and debugging. */
  readonly trail: readonly Segment[]
  reset(): void
}

export function createFloatingBallTracker(): FloatingBallTracker {
  let originX = 0
  let originY = 0
  let anchorX = 0
  let anchorY = 0
  let moved = false
  let trail: Segment[] = []

  const reset = () => {
    originX = 0
    originY = 0
    anchorX = 0
    anchorY = 0
    moved = false
    trail = []
  }

  return {
    get moved() {
      return moved
    },
    get trail() {
      return trail
    },
    reset,
    start(x, y) {
      reset()
      originX = x
      originY = y
      anchorX = x
      anchorY = y
    },
    move(x, y) {
      const total = Math.hypot(x - originX, y - originY)
      if (!moved && total <= MOVE_PX) return
      moved = true

      const stage = classifySegment(x - anchorX, y - anchorY)
      if (!stage) return
      const last = trail.length > 0 ? trail[trail.length - 1] : null
      if (stage === last) return

      if (isOpposite(last, stage) || trail.length === 0) {
        // A reversal always starts a new stage; so does the first one.
        trail.push(stage)
      } else if (trail.length === 1 && foldTrail([trail[0], stage]) === null) {
        // Jitter at the start of a stroke (U that drifts into UL) replaces the
        // opening stage — unless the pair spells a binding, in which case the
        // second stage must be kept or the gesture is lost.
        trail[0] = stage
      } else {
        trail.push(stage)
      }
      // The next stage is measured from here, so it does not inherit the
      // travel that already named this one.
      anchorX = x
      anchorY = y
    },
    end(x, y) {
      const dx = x - originX
      const dy = y - originY
      if (!moved || Math.hypot(dx, dy) <= MOVE_PX) return null

      const folded = foldTrail(trail)
      if (folded) return folded

      if (trail.length === 1) return singleStage(trail[0])
      return null
    },
  }
}

/**
 * Which click-scale gesture a completed press is.
 *
 * `msSinceLastTap` is the gap to the previous tap on the ball, or null when
 * there is none pending. A press that produced a long press or a double tap
 * clears that pending tap; a plain tap starts the window.
 */
export function resolveTapGesture(
  heldMs: number,
  msSinceLastTap: number | null
): "longPress" | "doubleTap" | "tap" {
  if (heldMs >= LONG_PRESS_MS) return "longPress"
  if (msSinceLastTap !== null && msSinceLastTap <= DOUBLE_TAP_MS) {
    return "doubleTap"
  }
  return "tap"
}

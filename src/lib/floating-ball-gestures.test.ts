import { describe, expect, it } from "vitest"

import {
  createFloatingBallTracker,
  DEFAULT_FLOATING_BALL_BINDINGS,
  FLOATING_BALL_GESTURES,
  LONG_PRESS_MS,
  MOVE_PX,
  resolveTapGesture,
  SWIPE_PX,
  type FloatingBallGesture,
} from "./floating-ball-gestures"

/** Walk a straight line in `n` samples, the way a finger reports positions. */
function steps(
  from: [number, number],
  to: [number, number],
  n = 8
): [number, number][] {
  const points: [number, number][] = []
  for (let i = 1; i <= n; i += 1) {
    points.push([
      from[0] + ((to[0] - from[0]) * i) / n,
      from[1] + ((to[1] - from[1]) * i) / n,
    ])
  }
  return points
}

/** Run a trail of legs through the tracker and return what it names. */
function trail(...legs: [number, number][]): FloatingBallGesture | null {
  const points: [number, number][] = [[0, 0]]
  for (const leg of legs) {
    points.push(...steps(points[points.length - 1], leg))
  }
  return run(points)
}

function run(points: [number, number][]): FloatingBallGesture | null {
  const tracker = createFloatingBallTracker()
  tracker.start(points[0][0], points[0][1])
  for (const point of points.slice(1)) tracker.move(point[0], point[1])
  return tracker.end()
}

const S = SWIPE_PX

describe("single-stroke gestures", () => {
  it("names each cardinal and upward diagonal", () => {
    expect(
      run([
        [0, 0],
        [-(S + 20), 0],
      ])
    ).toBe("left")
    expect(
      run([
        [0, 0],
        [S + 20, 0],
      ])
    ).toBe("right")
    expect(
      run([
        [0, 0],
        [0, -(S + 20)],
      ])
    ).toBe("up")
    expect(
      run([
        [0, 0],
        [-(S + 10), -(S + 10)],
      ])
    ).toBe("upLeft")
    expect(
      run([
        [0, 0],
        [S + 10, -(S + 10)],
      ])
    ).toBe("upRight")
  })

  it("names downward strokes as first-class gestures", () => {
    // Batch v82: down/downLeft/downRight are recognisable now (binding them is
    // the bindings table's job, not the recogniser's).
    expect(
      run([
        [0, 0],
        [0, S + 20],
      ])
    ).toBe("down")
    expect(
      run([
        [0, 0],
        [-(S + 10), S + 10],
      ])
    ).toBe("downLeft")
    expect(
      run([
        [0, 0],
        [S + 10, S + 10],
      ])
    ).toBe("downRight")
  })

  it("ignores movement below the threshold", () => {
    expect(
      run([
        [0, 0],
        [MOVE_PX - 3, 3],
      ])
    ).toBeNull()
  })

  it("needs one axis to dominate before naming a direction", () => {
    // 45 across vs 20 down is 2.25x: clearly a horizontal stroke.
    expect(
      run([
        [0, 0],
        [S + 15, 20],
      ])
    ).toBe("right")
    // 30 vs 20 is only 1.5x and neither axis reaches the diagonal threshold,
    // so the stroke stays ambiguous and fires nothing rather than guessing.
    expect(
      run([
        [0, 0],
        [S, 20],
      ])
    ).toBeNull()
  })
})

describe("two-stage trails", () => {
  it("folds a return stroke into its round-trip gesture", () => {
    expect(trail([-50, 0], [50, 0])).toBe("leftThenRight")
    expect(trail([50, 0], [-50, 0])).toBe("rightThenLeft")
    expect(trail([0, -50], [0, 50])).toBe("upDown")
    expect(trail([0, 50], [0, -50])).toBe("downUp")
  })

  it("folds an upward start plus a turn", () => {
    expect(trail([0, -50], [-60, -50])).toBe("upThenLeft")
    expect(trail([0, -50], [60, -50])).toBe("upThenRight")
    expect(trail([-40, -40], [-40, 40])).toBe("upLeftThenDown")
    expect(trail([40, -40], [40, 40])).toBe("upRightThenDown")
    expect(trail([0, -50], [S + 10, S + 10])).toBe("upThenDownRight")
  })

  it("folds the batch-v82 downward and horizontal starts", () => {
    // Each of these pairs previously fell through the jitter-replacement rule
    // and silently became a different single-stage gesture.
    expect(trail([0, 50], [S + 10, -(S + 10)])).toBe("downThenUpRight")
    expect(trail([50, 0], [50, -(S + 20)])).toBe("rightThenUp")
    expect(trail([50, 0], [50, S + 20])).toBe("rightThenDown")
    expect(trail([0, 50], [S + 20, 50])).toBe("downThenRight")
    expect(trail([0, 50], [-(S + 20), 50])).toBe("downThenLeft")
    expect(trail([S + 10, S + 10], [S + 10, -(S + 20)])).toBe("downRightThenUp")
    expect(trail([-(S + 10), S + 10], [-(S + 10), -(S + 20)])).toBe(
      "downLeftThenUp"
    )
  })

  it("keeps a round trip whose finger lands back at the origin", () => {
    // Regression (batch v82): end() used to require displacement from the
    // origin, which dropped a ↓↑ drawn cleanly back to its start.
    const points: [number, number][] = [
      ...steps([0, 0], [0, 60]),
      ...steps([0, 60], [0, 0]),
    ]
    expect(run(points)).toBe("downUp")
    const upDown: [number, number][] = [
      ...steps([0, 0], [0, -60]),
      ...steps([0, -60], [0, 0]),
    ]
    expect(run(upDown)).toBe("upDown")
  })

  it("does not read a horizontal round trip as a stop gesture", () => {
    // Regression: summing displacement from the origin cancelled ←→ into a
    // diagonal, which fired the stop binding.
    expect(trail([-50, 0], [50, 0])).not.toBe("upRightThenDown")
  })

  it("records the stages it saw", () => {
    const tracker = createFloatingBallTracker()
    tracker.start(0, 0)
    for (const point of steps([0, 0], [0, -60])) tracker.move(...point)
    for (const point of steps([0, -60], [0, 60])) tracker.move(...point)
    expect(tracker.trail).toEqual(["U", "D"])
  })
})

describe("click-scale gestures", () => {
  it("separates a tap, a double tap and a long press", () => {
    expect(resolveTapGesture(80, null)).toBe("tap")
    expect(resolveTapGesture(80, 120)).toBe("doubleTap")
    expect(resolveTapGesture(LONG_PRESS_MS, null)).toBe("longPress")
    expect(resolveTapGesture(LONG_PRESS_MS, 50)).toBe("longPress")
    expect(resolveTapGesture(80, 400)).toBe("tap")
  })
})

describe("default bindings", () => {
  it("binds every gesture, allowing deliberate gaps", () => {
    const unbound = FLOATING_BALL_GESTURES.filter(
      (gesture) => DEFAULT_FLOATING_BALL_BINDINGS[gesture] === null
    )
    // The long corner continuations are the only intentional gaps: a trail
    // passing through a two-stage binding would otherwise fire twice. Batch
    // v86 gave the straight down family the aux-panel bindings, so nothing
    // recognisable is left idle except the corner continuations that must
    // stay unreachable.
    expect(unbound.sort()).toEqual(["upLeftThenRight", "upRightThenLeft"])
  })

  it("keeps the MindFS muscle memory for the headline gestures", () => {
    expect(DEFAULT_FLOATING_BALL_BINDINGS.left).toBe("newConversation")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.tap).toBe("panel")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.longPress).toBe("openSettings")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.upRightThenDown).toBe(
      "stopGenerating"
    )
  })

  it("gives the right sidebar the down family and double tap", () => {
    // Batch v86: the aux panel is the phone's newest high-traffic surface.
    // Double tap moves off the terminal onto the panel toggle, and the two
    // downward diagonals open its most-read tabs (↓ itself is the toggle;
    // openGitLog stays unbound — three bindings on one family leave no
    // unambiguous stroke for it, and the panel rail reaches it in one tap).
    expect(DEFAULT_FLOATING_BALL_BINDINGS.down).toBe("toggleAuxPanel")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.doubleTap).toBe("toggleAuxPanel")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.downLeft).toBe("openChanges")
    expect(DEFAULT_FLOATING_BALL_BINDINGS.downRight).toBe("openSessionDetails")
  })
})

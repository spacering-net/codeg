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
  const last = points[points.length - 1]
  return tracker.end(last[0], last[1])
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

  it("leaves downward strokes unbound", () => {
    expect(
      run([
        [0, 0],
        [0, S + 20],
      ])
    ).toBeNull()
    expect(
      run([
        [0, 0],
        [-(S + 10), S + 10],
      ])
    ).toBeNull()
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
  })

  it("folds an upward start plus a turn", () => {
    expect(trail([0, -50], [-60, -50])).toBe("upThenLeft")
    expect(trail([0, -50], [60, -50])).toBe("upThenRight")
    expect(trail([-40, -40], [-40, 40])).toBe("upLeftThenDown")
    expect(trail([40, -40], [40, 40])).toBe("upRightThenDown")
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
    // The two long corner continuations are the only intentional gaps: a
    // trail passing through a two-stage binding would otherwise fire twice.
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
})

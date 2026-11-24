import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"

import * as motionEsm from "motion"

type Motion = typeof motionEsm

// The patched motion-dom@13.3.0 is reached through `motion`, both as the
// ESM build Next bundles and as the CommonJS build `require` resolves.
const builds: Array<[string, Motion]> = [
  ["ESM", motionEsm],
  ["CommonJS", createRequire(import.meta.url)("motion") as Motion],
]

interface FakeAnimation {
  onfinish: (() => void) | null
  oncancel: null
  currentTime: number
  playbackRate: number
  startTime: number
  playState: string
  effect: { getComputedTiming: () => { duration: number } }
  cancel: () => void
  pause: () => void
  play: () => void
  finish: () => void
}

function fakeAnimation(): FakeAnimation {
  const animation: FakeAnimation = {
    onfinish: null,
    oncancel: null,
    currentTime: 0,
    playbackRate: 1,
    startTime: 0,
    playState: "running",
    effect: { getComputedTiming: () => ({ duration: 200 }) },
    cancel: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(),
    // A browser fires the finish event synchronously enough for these checks.
    finish: () => animation.onfinish?.(),
  }
  return animation
}

function nativeAnimation({ NativeAnimation }: Motion) {
  const waapi = fakeAnimation()
  const element = document.createElement("div")
  element.animate = vi.fn(() => waapi as unknown as Animation)
  const onComplete = vi.fn()
  const animation = new NativeAnimation({
    element,
    name: "opacity",
    keyframes: ["0", "1"],
    duration: 200,
    onComplete,
  } as ConstructorParameters<Motion["NativeAnimation"]>[0])
  return { animation, waapi, onComplete }
}

describe.each(builds)("Motion WAAPI finish handler (%s)", (_, motion) => {
  it("releases the handler once the animation finishes", async () => {
    const { animation, waapi, onComplete } = nativeAnimation(motion)
    expect(waapi.onfinish).toBeTypeOf("function")

    waapi.finish()

    expect(waapi.onfinish).toBeNull()
    expect(onComplete).toHaveBeenCalledTimes(1)
    await expect(animation.finished).resolves.toBeUndefined()
  })

  it("releases the handler on cancel and restores it on play", () => {
    const { animation, waapi, onComplete } = nativeAnimation(motion)

    animation.cancel()
    expect(waapi.onfinish).toBeNull()

    animation.play()
    waapi.finish()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it("still completes an animation that was cancelled", async () => {
    const { animation, waapi, onComplete } = nativeAnimation(motion)

    animation.cancel()
    animation.complete()

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(waapi.onfinish).toBeNull()
    await expect(animation.finished).resolves.toBeUndefined()
  })

  it("does not complete an animation that was stopped", () => {
    const { animation, onComplete } = nativeAnimation(motion)

    animation.stop()
    animation.complete()

    expect(onComplete).not.toHaveBeenCalled()
  })

  it("does not restore the handler after a timeline handoff", () => {
    const { animation, waapi } = nativeAnimation(motion)

    animation.attachTimeline({ observe: () => () => {} })
    animation.play()

    expect(waapi.onfinish).toBeNull()
  })

  it("releases a wrapped animation's handler when it finishes", async () => {
    const waapi = fakeAnimation()
    const animation = new motion.NativeAnimationWrapper(
      waapi as unknown as Animation
    )

    waapi.finish()

    expect(waapi.onfinish).toBeNull()
    await expect(animation.finished).resolves.toBeUndefined()
  })
})

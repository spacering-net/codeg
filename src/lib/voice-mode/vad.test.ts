import { describe, expect, it } from "vitest"
import { createVad } from "./vad"

describe("createVad", () => {
  it("detects speech start and end, works with clock starting at 0", () => {
    let now = 0
    const vad = createVad({ endSilenceMs: 1000, now: () => now })

    expect(vad.push(-60)).toEqual([])

    now += 50
    expect(vad.push(-40)).toEqual(["speech-candidate"])

    now += 50
    expect(vad.push(-60)).toEqual(["candidate-dropped"])

    now += 50
    expect(vad.push(-30)).toEqual(["speech-candidate"])

    now += 150
    expect(vad.push(-30)).toEqual(["speech-start"])

    now += 100
    expect(vad.push(-30)).toEqual([])

    now += 100
    expect(vad.push(-60)).toEqual([])

    now += 1000
    expect(vad.push(-60)).toEqual(["speech-end"])
  })

  it("adjusts threshold when playback is active, restores when false", () => {
    let now = 0
    const vad = createVad({ endSilenceMs: 1000, now: () => now })
    vad.setPlaybackActive(true)
    expect(vad.push(-40)).toEqual([])
    expect(vad.push(-30)).toEqual(["speech-candidate"])
    now += 150
    expect(vad.push(-30)).toEqual([])
    now += 150
    expect(vad.push(-30)).toEqual(["speech-start"])
    now += 1000
    expect(vad.push(-60)).toEqual([])
    now += 1000
    expect(vad.push(-60)).toEqual(["speech-end"])
    vad.setPlaybackActive(false)
    now += 100
    expect(vad.push(-40)).toEqual(["speech-candidate"])
    now += 150
    expect(vad.push(-40)).toEqual(["speech-start"])
  })

  it("resets end timer if speech resumes inside silence window", () => {
    let now = 0
    const vad = createVad({ endSilenceMs: 1000, now: () => now })
    now += 100
    expect(vad.push(-30)).toEqual(["speech-candidate"])
    now += 150
    expect(vad.push(-30)).toEqual(["speech-start"])
    now += 100
    expect(vad.push(-60)).toEqual([])
    now += 500
    expect(vad.push(-60)).toEqual([])
    now += 100
    expect(vad.push(-30)).toEqual([])
    now += 100
    expect(vad.push(-60)).toEqual([])
    now += 1000
    expect(vad.push(-60)).toEqual(["speech-end"])
  })

  it("adapts floor to sustained noise", () => {
    let now = 0
    const vad = createVad({ endSilenceMs: 1000, now: () => now })
    expect(vad.push(-40)).toEqual(["speech-candidate"])
    now += 100
    expect(vad.push(-60)).toEqual(["candidate-dropped"])
    for (let i = 0; i < 500; i++) {
      now += 20
      vad.push(-49)
    }
    now += 20
    expect(vad.push(-40)).toEqual([])
    now += 20
    expect(vad.push(-30)).toEqual(["speech-candidate"])
  })
})

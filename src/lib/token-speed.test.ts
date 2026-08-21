import { describe, expect, it } from "vitest"
import {
  countChars,
  estimateTokens,
  formatTokPerSec,
  TokenCountAccumulator,
  TokenSpeedTracker,
} from "./token-speed"

describe("formatTokPerSec", () => {
  it("matches the live-turn one-decimal tok/s label", () => {
    expect(formatTokPerSec(47.23)).toBe("47.2 tok/s")
    expect(formatTokPerSec(0)).toBe("0.0 tok/s")
  })
})

describe("estimateTokens", () => {
  it("counts latin at 4 chars per token", () => {
    expect(estimateTokens("hello world")).toBeCloseTo(10 / 4)
  })

  it("counts cjk at 1.8 chars per token", () => {
    expect(estimateTokens("你好世界")).toBeCloseTo(4 / 1.8)
  })

  it("skips whitespace", () => {
    expect(estimateTokens("  a b  ")).toBeCloseTo(2 / 4)
  })

  it("mixes cjk and latin", () => {
    expect(estimateTokens("你好 world")).toBeCloseTo(2 / 1.8 + 5 / 4)
  })

  it("counts fullwidth punctuation as cjk", () => {
    expect(estimateTokens("你好，世界！")).toBeCloseTo(6 / 1.8)
  })

  it("returns 0 for empty or whitespace-only text", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("   ")).toBe(0)
  })

  it("counts hiragana and katakana as dense", () => {
    // Kana tokenizes as densely as Han; counting it as latin under-reports
    // Japanese output by more than 2x.
    expect(countChars("これはテストです")).toEqual({ dense: 8, other: 0 })
    expect(estimateTokens("ひらがなカタカナ")).toBeCloseTo(8 / 1.8)
  })

  it("counts hangul as dense", () => {
    expect(countChars("한국어 출력")).toEqual({ dense: 5, other: 0 })
    expect(estimateTokens("한국어")).toBeCloseTo(3 / 1.8)
  })

  it("counts cjk punctuation outside the fullwidth block as dense", () => {
    // 。(U+3002) and 、(U+3001) live in CJK Symbols and Punctuation, not in the
    // Halfwidth/Fullwidth Forms block.
    expect(countChars("你好。世界、")).toEqual({ dense: 6, other: 0 })
  })

  it("treats the ideographic space as whitespace, not as a dense char", () => {
    expect(countChars("你　好")).toEqual({ dense: 2, other: 0 })
  })

  it("counts an astral character once", () => {
    // Surrogate pairs: the high half scores, the low half is skipped.
    expect(countChars("🚀")).toEqual({ dense: 1, other: 0 })
    expect(countChars("𠀀𠀁")).toEqual({ dense: 2, other: 0 })
  })

  it("is exactly additive over a suffix measurement", () => {
    const head = "先看一段中文 and some latin"
    const tail = "、それからかな 그리고 한국어 🚀 tail"
    const whole = head + tail
    expect(estimateTokens(whole)).toBeCloseTo(
      estimateTokens(head) + estimateTokens(whole, head.length)
    )
  })

  it("stays additive when a split lands inside a surrogate pair", () => {
    const whole = "a🚀b"
    // Split between the high and low surrogate of the rocket.
    const cut = 2
    const head = countChars(whole.slice(0, cut))
    const tail = countChars(whole, cut)
    expect({
      dense: head.dense + tail.dense,
      other: head.other + tail.other,
    }).toEqual(countChars(whole))
  })
})

describe("TokenCountAccumulator", () => {
  /** Drive one pass over `texts` and return the total. */
  function pass(acc: TokenCountAccumulator, texts: string[]): number {
    acc.beginPass()
    for (const text of texts) acc.push(text)
    return acc.endPass()
  }

  it("matches a whole-string measure as blocks grow", () => {
    const acc = new TokenCountAccumulator()
    let text = ""
    for (const chunk of ["Hello ", "世界，", "これは", " a test", " 한국어"]) {
      text += chunk
      expect(pass(acc, [text])).toBeCloseTo(estimateTokens(text))
    }
  })

  it("sums across several blocks and picks up newly appended ones", () => {
    const acc = new TokenCountAccumulator()
    expect(pass(acc, ["abcd", "你好"])).toBeCloseTo(4 / 4 + 2 / 1.8)
    // First block grew, and a third block appeared.
    expect(pass(acc, ["abcdefgh", "你好", "xyzw"])).toBeCloseTo(
      8 / 4 + 2 / 1.8 + 4 / 4
    )
  })

  it("re-measures a block that got shorter instead of longer", () => {
    // A snapshot hydration can re-seat the turn rather than append to it.
    const acc = new TokenCountAccumulator()
    expect(pass(acc, ["aaaaaaaa"])).toBeCloseTo(8 / 4)
    expect(pass(acc, ["你好"])).toBeCloseTo(2 / 1.8)
  })

  it("drops blocks a later pass no longer reaches", () => {
    const acc = new TokenCountAccumulator()
    expect(pass(acc, ["aaaa", "bbbb", "cccc"])).toBeCloseTo(12 / 4)
    expect(pass(acc, ["aaaa"])).toBeCloseTo(4 / 4)
  })

  it("resets to zero", () => {
    const acc = new TokenCountAccumulator()
    pass(acc, ["aaaa"])
    acc.reset()
    expect(pass(acc, [])).toBe(0)
  })
})

describe("TokenSpeedTracker", () => {
  it("seeds the baseline on the first observation", () => {
    const tracker = new TokenSpeedTracker()
    expect(tracker.observe(0, 0)).toBeNull()
  })

  it("computes a constant rate", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    expect(tracker.observe(100, 1000)).toBeCloseTo(100)
  })

  it("withholds a reading until it covers a meaningful window", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    expect(tracker.observe(5, 100)).toBeNull()
    expect(tracker.observe(10, 200)).toBeNull()
    expect(tracker.observe(15, 300)).toBeCloseTo(50)
  })

  it("opens at the real rate even when the store's first samples are empty", () => {
    // The store notifies once per wire envelope (EVENT_APPLIED) before the
    // batched content delta lands, so most samples carry no new tokens at all.
    // Bias correction is what keeps that from dragging the opening reading to 0.
    const tracker = new TokenSpeedTracker()
    const rate = 60
    let produced = 0
    let committed = 0
    let first: number | null = null
    for (let ms = 0; ms <= 3000; ms += 4) {
      produced += rate * 0.004
      if (ms % 16 === 0) committed = produced // the 16ms stream batch flush
      const reading = tracker.observe(committed, ms)
      if (reading != null && first == null) first = reading
    }
    expect(first).not.toBeNull()
    expect(first as number).toBeGreaterThan(rate * 0.85)
    expect(first as number).toBeLessThan(rate * 1.15)
  })

  it("smooths a burst followed by silence", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(200, 1000)
    const rate = tracker.observe(200, 2000)
    expect(rate).toBeGreaterThan(0)
    expect(rate as number).toBeLessThan(200)
  })

  it("holds the reading across a paused wait instead of decaying", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    const generating = tracker.observe(100, 1000)
    expect(generating).toBeCloseTo(100)
    // 9s of tool wait: same token count, pause=true.
    const held = tracker.observe(100, 10_000, { pause: true })
    expect(held).toBeCloseTo(generating as number)
  })

  it("does not dilute the next generating sample by a paused wait", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    tracker.observe(100, 10_000, { pause: true })
    // 50 tokens in the 1s after the wait — 50 tok/s, not 50 / 10s.
    const resumed = tracker.observe(150, 11_000)
    expect(resumed).toBeGreaterThan(40)
    expect(resumed as number).toBeLessThan(80)
  })

  it("counts a slow generating gap (no pause) as real time", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    // 1s of silence while still generating (slow decode) must pull the rate.
    const slowed = tracker.observe(100, 2000)
    expect(slowed).toBeLessThan(80)
    expect(slowed as number).toBeGreaterThan(20)
  })

  it("reports generating-only average excluding paused waits", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    tracker.observe(100, 10_000, { pause: true })
    tracker.observe(200, 11_000)
    // 200 tokens over 2s generating, not 11s wall.
    expect(tracker.average()).toBeCloseTo(100)
    expect(tracker.generatingElapsedMs).toBe(2000)
    expect(tracker.generatingTokenCount).toBeCloseTo(200)
  })

  it("ignores non-positive time deltas", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 1000)
    expect(tracker.observe(50, 1000)).toBeNull()
    expect(tracker.observe(100, 500)).toBeNull()
  })

  it("re-reports the current reading for a non-positive delta once warm", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    const warm = tracker.observe(100, 1000)
    expect(tracker.observe(100, 1000)).toBeCloseTo(warm as number)
  })

  it("resets to a fresh baseline", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    tracker.reset()
    expect(tracker.observe(0, 2000)).toBeNull()
    expect(tracker.average()).toBeNull()
  })
})

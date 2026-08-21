import { afterEach, describe, expect, it } from "vitest"

import {
  commitLiveSessionOutputSpeed,
  getSessionOutputSpeed,
  migrateSessionOutputSpeed,
  resetSessionOutputSpeedForTests,
  setLiveSessionOutputSpeed,
} from "./session-output-speed"

afterEach(() => {
  resetSessionOutputSpeedForTests()
})

describe("session output speed", () => {
  it("hides a reading until generating time is meaningful", () => {
    setLiveSessionOutputSpeed(1, 10, 100)
    expect(getSessionOutputSpeed(1)).toBeNull()
  })

  it("reports tokens over generating time", () => {
    setLiveSessionOutputSpeed(1, 100, 1000)
    const snap = getSessionOutputSpeed(1)
    expect(snap?.averageTps).toBeCloseTo(100)
    expect(snap?.generatingMs).toBe(1000)
    expect(snap?.outputTokens).toBe(100)
  })

  it("replaces the live slot instead of stacking samples", () => {
    setLiveSessionOutputSpeed(1, 50, 500)
    setLiveSessionOutputSpeed(1, 100, 1000)
    expect(getSessionOutputSpeed(1)?.outputTokens).toBe(100)
  })

  it("commits a finished turn so the next live slot cannot overwrite it", () => {
    setLiveSessionOutputSpeed(1, 100, 1000)
    commitLiveSessionOutputSpeed(1)
    setLiveSessionOutputSpeed(1, 50, 1000)
    const snap = getSessionOutputSpeed(1)
    expect(snap?.outputTokens).toBe(150)
    expect(snap?.generatingMs).toBe(2000)
    expect(snap?.averageTps).toBeCloseTo(75)
  })

  it("migrates a virtual runtime id onto the persisted conversation", () => {
    setLiveSessionOutputSpeed(-7, 80, 1000)
    commitLiveSessionOutputSpeed(-7)
    migrateSessionOutputSpeed(-7, 42)
    expect(getSessionOutputSpeed(-7)).toBeNull()
    expect(getSessionOutputSpeed(42)?.outputTokens).toBe(80)
  })
})

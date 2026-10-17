import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  matchFullAccessMode,
  resolveDefaultModeForAgent,
  setAgentDefaultMode,
  setYoloEnabled,
  clearAllAgentDefaultModes,
  getAgentDefaultMode,
} from "./default-mode-prefs"

beforeEach(() => {
  window.localStorage.clear()
  clearAllAgentDefaultModes()
  setYoloEnabled(false)
})

afterEach(() => {
  window.localStorage.clear()
})

describe("matchFullAccessMode", () => {
  it("prefers danger over other full-access names", () => {
    expect(
      matchFullAccessMode(["default", "danger-full-access", "yolo-mode"])
    ).toBe("danger-full-access")
  })

  it("matches each CLI's own vocabulary", () => {
    expect(matchFullAccessMode(["build", "yolo"])).toBe("yolo")
    expect(matchFullAccessMode(["default", "bypassPermissions"])).toBe(
      "bypassPermissions"
    )
    expect(matchFullAccessMode(["safe", "full_access"])).toBe("full_access")
    expect(matchFullAccessMode(["ask", "access:unrestricted"])).toBe(
      "access:unrestricted"
    )
  })

  it("returns null when nothing matches", () => {
    expect(matchFullAccessMode(["build", "plan", "auto", "dontAsk"])).toBeNull()
  })

  it("is case-insensitive and stable on ties (list order)", () => {
    expect(matchFullAccessMode(["Build", "Plan", "YOLO"])).toBe("YOLO")
    expect(matchFullAccessMode(["yolo-alpha", "yolo-beta"])).toBe("yolo-alpha")
  })
})

describe("resolveDefaultModeForAgent", () => {
  it("an explicit pin wins over the Yolo switch", () => {
    setAgentDefaultMode("zcode", "plan")
    setYoloEnabled(true)
    expect(resolveDefaultModeForAgent("zcode", ["build", "plan", "yolo"])).toBe(
      "plan"
    )
  })

  it("a pin the agent no longer offers degrades to no preference", () => {
    setAgentDefaultMode("zcode", "gone")
    expect(resolveDefaultModeForAgent("zcode", ["build", "yolo"])).toBeNull()
  })

  it("Yolo resolves through the weight order", () => {
    setYoloEnabled(true)
    expect(
      resolveDefaultModeForAgent("codex", ["default", "danger-full-access"])
    ).toBe("danger-full-access")
    expect(
      resolveDefaultModeForAgent("claude", ["default", "dontAsk"])
    ).toBeNull()
  })

  it("without Yolo or a pin there is no preference", () => {
    expect(resolveDefaultModeForAgent("zcode", ["build", "yolo"])).toBeNull()
  })

  it("clearing pins removes them for every agent", () => {
    setAgentDefaultMode("zcode", "plan")
    setAgentDefaultMode("codex", "default")
    clearAllAgentDefaultModes()
    expect(getAgentDefaultMode("zcode")).toBeNull()
    expect(getAgentDefaultMode("codex")).toBeNull()
  })
})

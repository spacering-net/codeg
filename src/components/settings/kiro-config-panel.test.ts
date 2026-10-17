import { describe, expect, it } from "vitest"

import { buildKiroEnv, kiroPermissionModeFromEnv } from "./kiro-config-panel"

describe("kiroPermissionModeFromEnv", () => {
  // Mirrors the launch side (`kiro_trust_all_tools_enabled`): only an explicit
  // "1"/"true" trusts every tool, so an unset or unknown value keeps asking.
  it("reads the launch knob the way the backend does", () => {
    expect(kiroPermissionModeFromEnv({})).toBe("ask")
    expect(kiroPermissionModeFromEnv({ KIRO_TRUST_ALL_TOOLS: "0" })).toBe("ask")
    expect(kiroPermissionModeFromEnv({ KIRO_TRUST_ALL_TOOLS: "yes" })).toBe(
      "ask"
    )
    expect(kiroPermissionModeFromEnv({ KIRO_TRUST_ALL_TOOLS: "1" })).toBe(
      "trust_all"
    )
    expect(kiroPermissionModeFromEnv({ KIRO_TRUST_ALL_TOOLS: " TRUE " })).toBe(
      "trust_all"
    )
  })
})

describe("buildKiroEnv", () => {
  it("writes both permission states explicitly and keeps unrelated keys", () => {
    const prev = { OTHER: "x", KIRO_API_KEY: "old" }
    expect(buildKiroEnv(prev, "old", "trust_all")).toEqual({
      OTHER: "x",
      KIRO_API_KEY: "old",
      KIRO_TRUST_ALL_TOOLS: "1",
    })
    expect(buildKiroEnv(prev, "old", "ask").KIRO_TRUST_ALL_TOOLS).toBe("0")
    // The input is not mutated.
    expect(prev).toEqual({ OTHER: "x", KIRO_API_KEY: "old" })
  })

  it("trims the API key and deletes it when empty", () => {
    expect(buildKiroEnv({}, "  ksk_1  ", "ask").KIRO_API_KEY).toBe("ksk_1")
    expect(
      buildKiroEnv({ KIRO_API_KEY: "old" }, "   ", "ask")
    ).not.toHaveProperty("KIRO_API_KEY")
  })
})

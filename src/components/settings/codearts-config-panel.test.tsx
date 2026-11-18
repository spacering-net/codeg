/** The AK/SK panel writes only its two keys into the agent's env. Leaving a
 *  field empty must REMOVE the key, otherwise an empty page value would shadow
 *  the OS-level credential the bridge is supposed to fall back to. */
import { describe, expect, it } from "vitest"

import {
  CODEARTS_AK_ENV,
  CODEARTS_SK_ENV,
  buildCodeArtsEnv,
} from "./codearts-config-panel"

describe("buildCodeArtsEnv", () => {
  it("writes trimmed credentials and preserves unrelated env keys", () => {
    const env = buildCodeArtsEnv(
      { PATH: "/usr/bin", OTHER: "kept" },
      "  AK-123  ",
      " SK-456\n"
    )
    expect(env[CODEARTS_AK_ENV]).toBe("AK-123")
    expect(env[CODEARTS_SK_ENV]).toBe("SK-456")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.OTHER).toBe("kept")
  })

  it("removes empty credentials so the OS fallback applies", () => {
    const env = buildCodeArtsEnv(
      { [CODEARTS_AK_ENV]: "old", [CODEARTS_SK_ENV]: "old" },
      "   ",
      ""
    )
    expect(env).not.toHaveProperty(CODEARTS_AK_ENV)
    expect(env).not.toHaveProperty(CODEARTS_SK_ENV)
  })

  it("does not mutate the env it was handed", () => {
    const prev = { KEEP: "1" }
    buildCodeArtsEnv(prev, "ak", "sk")
    expect(prev).toEqual({ KEEP: "1" })
  })
})

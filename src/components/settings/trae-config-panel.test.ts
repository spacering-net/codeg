import { describe, expect, it } from "vitest"

import { TRAE_HOST_ENV, TRAE_PAT_ENV, buildTraeEnv } from "./trae-config-panel"

describe("buildTraeEnv", () => {
  // The names TRAE CLI documents; the backend reads the same two
  // (`acp::trae::TRAE_PAT_ENV` / `TRAE_HOST_ENV`).
  it("uses the variable names TRAE CLI reads", () => {
    expect(TRAE_PAT_ENV).toBe("TRAECLI_PERSONAL_ACCESS_TOKEN")
    expect(TRAE_HOST_ENV).toBe("TRAECLI_HOST")
  })

  it("trims both fields and keeps unrelated keys", () => {
    const prev = { OTHER: "x" }
    expect(
      buildTraeEnv(prev, "  pat_123  ", " https://api.example.com ")
    ).toEqual({
      OTHER: "x",
      TRAECLI_PERSONAL_ACCESS_TOKEN: "pat_123",
      TRAECLI_HOST: "https://api.example.com",
    })
    // The input is not mutated.
    expect(prev).toEqual({ OTHER: "x" })
  })

  it("deletes a cleared field so sign-in falls back to traecli login", () => {
    const prev = {
      TRAECLI_PERSONAL_ACCESS_TOKEN: "old",
      TRAECLI_HOST: "https://api.example.com",
      OTHER: "x",
    }
    expect(buildTraeEnv(prev, "   ", "")).toEqual({ OTHER: "x" })
  })
})

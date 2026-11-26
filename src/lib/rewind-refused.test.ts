import { describe, expect, it } from "vitest"
import { RewindRefusedError, asRewindRefusedError } from "./rewind-refused"

describe("asRewindRefusedError", () => {
  it("reads the agent's reason out of either transport's rejection", () => {
    // Tauri: the AcpError's Display string; web: AppCommandError.message.
    expect(asRewindRefusedError("edited message refused: busy")?.reason).toBe(
      "busy"
    )
    expect(
      asRewindRefusedError({
        code: "invalid_input",
        message: "edited message refused: beforeCompaction",
      })?.reason
    ).toBe("beforeCompaction")
    const own = new RewindRefusedError("unavailable")
    expect(asRewindRefusedError(own)).toBe(own)
  })

  it("leaves every other failure alone", () => {
    expect(asRewindRefusedError("turn already in progress")).toBeNull()
    expect(asRewindRefusedError(new Error("network down"))).toBeNull()
    expect(asRewindRefusedError(null)).toBeNull()
  })
})

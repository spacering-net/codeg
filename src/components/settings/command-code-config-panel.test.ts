import { describe, expect, it } from "vitest"

import {
  COMMAND_CODE_API_KEY_ENV,
  COMMAND_CODE_LOGIN_COMMAND,
  buildCommandCodeEnv,
} from "./command-code-config-panel"

describe("buildCommandCodeEnv", () => {
  // The name Command Code reads (the backend's
  // `acp::command_code::COMMAND_CODE_API_KEY_ENV`), and a login command that
  // works on every platform: the docs' short `cmd` is the Windows shell.
  it("uses the variable and command Command Code understands", () => {
    expect(COMMAND_CODE_API_KEY_ENV).toBe("COMMAND_CODE_API_KEY")
    expect(COMMAND_CODE_LOGIN_COMMAND).toBe("command-code login")
  })

  it("trims the key and keeps unrelated keys", () => {
    const prev = { OTHER: "x" }
    expect(buildCommandCodeEnv(prev, "  user_abc  ")).toEqual({
      OTHER: "x",
      COMMAND_CODE_API_KEY: "user_abc",
    })
    // The input is not mutated.
    expect(prev).toEqual({ OTHER: "x" })
  })

  it("deletes a cleared key so sign-in falls back to command-code login", () => {
    expect(
      buildCommandCodeEnv({ COMMAND_CODE_API_KEY: "old", OTHER: "x" }, "   ")
    ).toEqual({ OTHER: "x" })
  })
})

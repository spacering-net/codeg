import { describe, expect, it } from "vitest"

import { webServerStartErrorMessage } from "./start-error"

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

describe("webServerStartErrorMessage", () => {
  it("maps a backend bind key to its localized text, with the port", () => {
    expect(
      webServerStartErrorMessage({ message: "web_server.port_in_use" }, t, 3080)
    ).toBe('errors.portInUse:{"port":3080}')
  })

  it("passes an unknown message through, and falls back when there is none", () => {
    expect(webServerStartErrorMessage({ message: "boom" }, t, 1)).toBe("boom")
    expect(webServerStartErrorMessage(new Error(""), t, 1)).toBe("startFailed")
    expect(webServerStartErrorMessage(null, t, 1)).toBe("startFailed")
  })
})

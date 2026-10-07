import { describe, expect, it } from "vitest"

import { SUGGESTED_SERVERS } from "./mcp-settings"

/**
 * The one thing about a suggested server that is worth a test.
 *
 * A suggestion is codeg naming a package for someone who is adding a browser
 * tool by hand — which is exactly the person who cannot tell the official
 * `chrome-devtools-mcp` from the lookalikes the registry carries under the
 * same name and description with a different owner. So the package string is
 * not a detail to be tidied later: it is the whole value of offering the
 * button, and a well-meant edit to it is a supply-chain change.
 */
describe("suggested MCP servers", () => {
  it("names the official chrome-devtools package, exactly", () => {
    const chrome = SUGGESTED_SERVERS.find((s) => s.key === "chromeDevtools")
    expect(chrome).toBeDefined()
    expect(chrome!.spec.command).toBe("npx")
    expect(chrome!.spec.args).toEqual(["-y", "chrome-devtools-mcp@latest"])
    expect(chrome!.spec.type).toBe("stdio")
  })

  /** Every entry has to carry the sentence that says what it is and is not —
   *  a suggestion without one is an endorsement. */
  it("every suggestion explains itself", () => {
    expect(SUGGESTED_SERVERS.length).toBeGreaterThan(0)
    for (const suggested of SUGGESTED_SERVERS) {
      expect(suggested.note).toMatch(/^local\./)
      expect(suggested.id.trim()).not.toBe("")
      expect(suggested.label.trim()).not.toBe("")
    }
  })
})

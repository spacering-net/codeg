import { describe, expect, it } from "vitest"
import { joinPlan, sidecarCommand } from "./embedded-tailnet"

describe("embedded tailnet join plan", () => {
  it("accepts an auth key and is stable across two builds", () => {
    const input = {
      hostname: "codeg-desk",
      target: "http://127.0.0.1:3080",
      authKey: "tskey-auth-example",
    }
    const first = joinPlan(input)
    const second = joinPlan(input)
    expect(first).toEqual(second)
    expect(first.auth).toEqual({
      kind: "auth-key",
      value: "tskey-auth-example",
    })
    expect(sidecarCommand(first)).toContain("--authkey")
    expect(sidecarCommand(first)).toContain("http://127.0.0.1:3080")
  })

  it("accepts an auth URL and is stable across two builds", () => {
    const input = {
      target: "http://127.0.0.1:3080",
      authUrl: "https://login.tailscale.com/a/example",
    }
    const first = joinPlan(input)
    const second = joinPlan(input)
    expect(first).toEqual(second)
    expect(first.hostname).toBe("codeg")
    expect(first.auth.kind).toBe("auth-url")
    expect(sidecarCommand(first)).toContain("--login-server")
  })

  it("rejects missing or mixed auth", () => {
    expect(() => joinPlan({ target: "http://127.0.0.1:3080" })).toThrow(
      /auth key or auth URL/
    )
    expect(() =>
      joinPlan({
        target: "http://127.0.0.1:3080",
        authKey: "k",
        authUrl: "https://login.tailscale.com/a/x",
      })
    ).toThrow(/either/)
    expect(() => joinPlan({ target: "", authKey: "k" })).toThrow(/target/)
  })
})

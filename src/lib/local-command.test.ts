import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  remote: true,
  baseUrl: "https://devbox.example:3080/",
}))

vi.mock("@/lib/transport", () => ({
  isRemoteDesktopMode: () => h.remote,
  getServerBaseUrl: () => h.baseUrl,
}))

import { getRemoteHostName, parseLocalCommand } from "./local-command"

describe("parseLocalCommand", () => {
  it("strips the local: prefix", () => {
    expect(parseLocalCommand("local: zed .")).toBe("zed .")
    expect(parseLocalCommand("  LOCAL:open -a Zed")).toBe("open -a Zed")
  })

  it("leaves ordinary commands alone", () => {
    expect(parseLocalCommand("pnpm dev")).toBeNull()
    expect(parseLocalCommand("echo local: x")).toBeNull()
  })

  it("treats a bare prefix as no command", () => {
    expect(parseLocalCommand("local:   ")).toBeNull()
  })
})

describe("getRemoteHostName", () => {
  it("returns the remote server's host name", () => {
    h.remote = true
    expect(getRemoteHostName()).toBe("devbox.example")
  })

  it("is null outside a remote-desktop window", () => {
    h.remote = false
    expect(getRemoteHostName()).toBeNull()
  })
})

import { describe, expect, it } from "vitest"

import { remoteConnectionOfProfile, remoteHostAddress } from "./remote-host"

describe("remoteConnectionOfProfile", () => {
  it("reads the connection out of a remote profile's id", () => {
    expect(remoteConnectionOfProfile("remote-4")).toBe(4)
    expect(remoteConnectionOfProfile("remote-1234")).toBe(1234)
  })

  it("is null for every other profile", () => {
    for (const profile of [
      "default",
      "p-abc",
      "remote-",
      "remote-x",
      "remote-0",
      "remote-1.5",
      null,
      undefined,
    ]) {
      expect(remoteConnectionOfProfile(profile)).toBeNull()
    }
  })
})

describe("remoteHostAddress", () => {
  it("puts the macOS alias back to the remote host's own localhost", () => {
    expect(remoteHostAddress("http://remote.localhost:3000/a?b=1#c")).toBe(
      "http://localhost:3000/a?b=1#c"
    )
    expect(remoteHostAddress("wss://remote.localhost/hmr")).toBe(
      "wss://localhost/hmr"
    )
  })

  it("leaves every other address alone", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost:3000/",
      "http://10.0.0.5:8080/x",
      "https://example.com/",
      "not a url",
    ]) {
      expect(remoteHostAddress(url)).toBe(url)
    }
  })
})

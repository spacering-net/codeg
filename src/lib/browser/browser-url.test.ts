import { describe, expect, it } from "vitest"

import {
  BLANK_PAGE_URL,
  displayHostPort,
  hostnameOf,
  isBlankPageUrl,
  isLoopbackHost,
  isLoopbackOrPrivateUrl,
  isPrivateNetworkHost,
  isRemoteHostName,
  normalizeUrlForDedupe,
  originOf,
  portOf,
} from "./browser-url"

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "::",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    // How the URL parser writes the mapped form, and a fully qualified name.
    "::ffff:7f00:1",
    "[::ffff:7f00:1]",
    "localhost.",
    "app.localhost.",
  ])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each([
    "example.com",
    "localhost.example.com",
    "128.0.0.1",
    "10.0.0.1",
    "notlocalhost",
    "",
  ])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe("isPrivateNetworkHost", () => {
  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.20",
    "169.254.169.254",
    "fd12:3456::1",
    "fc00::1",
    "fe80::1%en0",
    "[fe80::1]",
    "mymac.local",
    "mymac.local.",
    "::ffff:192.168.0.1",
    "::ffff:c0a8:1",
  ])("%s is private / link-local", (host) => {
    expect(isPrivateNetworkHost(host)).toBe(true)
  })

  it.each([
    "172.15.0.1",
    "172.32.0.1",
    "11.0.0.1",
    "192.169.0.1",
    "8.8.8.8",
    "2001:db8::1",
    "example.com",
    "127.0.0.1",
    "localhost",
  ])("%s is not private", (host) => {
    expect(isPrivateNetworkHost(host)).toBe(false)
  })
})

describe("isRemoteHostName", () => {
  // Exactly what a page's address becomes once parsed: the parser, not the
  // person, decides the spelling the classifier sees.
  it("sees every spelling the URL parser produces for loopback", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]:3000/",
      "http://localhost.:3000/",
    ]) {
      expect(isLoopbackOrPrivateUrl(url)).toBe(true)
    }
  })

  it("puts loopback and private names on the remote host", () => {
    expect(isRemoteHostName("localhost", "dev.example.com")).toBe(true)
    expect(isRemoteHostName("192.168.1.20", "dev.example.com")).toBe(true)
    expect(isRemoteHostName("example.org", "dev.example.com")).toBe(false)
  })

  // The window reaches the server itself directly, so its own private name
  // is an address of this computer's network too.
  it("leaves the server's own private name to this computer", () => {
    expect(isRemoteHostName("192.168.1.5", "192.168.1.5")).toBe(false)
    expect(isRemoteHostName("192.168.1.6", "192.168.1.5")).toBe(true)
    expect(isRemoteHostName("fd00::5", "[FD00::5]")).toBe(false)
  })

  // Through an SSH tunnel the server is this machine's loopback: nothing on
  // this machine's loopback is the remote's.
  it("exempts nothing for a server reached through a loopback address", () => {
    expect(isRemoteHostName("127.0.0.1", "127.0.0.1")).toBe(true)
    expect(isRemoteHostName("localhost", "localhost")).toBe(true)
  })

  it("puts everything loopback or private on the remote host when the server has no name", () => {
    expect(isRemoteHostName("192.168.1.5", null)).toBe(true)
  })
})

describe("URL helpers", () => {
  it("hostnameOf strips IPv6 brackets and lower-cases", () => {
    expect(hostnameOf("http://[::1]:3000/x")).toBe("::1")
    expect(hostnameOf("HTTPS://Example.COM/")).toBe("example.com")
    expect(hostnameOf("not a url")).toBeNull()
  })

  it("isLoopbackOrPrivateUrl looks at the host only", () => {
    expect(isLoopbackOrPrivateUrl("http://localhost:3000/api")).toBe(true)
    expect(isLoopbackOrPrivateUrl("http://192.168.0.5:8080/")).toBe(true)
    expect(isLoopbackOrPrivateUrl("https://github.com/x")).toBe(false)
    expect(isLoopbackOrPrivateUrl("garbage")).toBe(false)
  })

  it("originOf returns null for opaque origins", () => {
    expect(originOf("https://example.com:8443/a/b")).toBe(
      "https://example.com:8443"
    )
    expect(originOf("about:blank")).toBeNull()
    expect(originOf("blob:null/abc")).toBeNull()
  })

  it("portOf resolves defaults per scheme", () => {
    expect(portOf("http://example.com/")).toBe(80)
    expect(portOf("https://example.com/")).toBe(443)
    expect(portOf("http://example.com:3000/")).toBe(3000)
    expect(portOf("mailto:x@y")).toBeNull()
  })

  it("normalizeUrlForDedupe drops the fragment and serializes", () => {
    expect(normalizeUrlForDedupe("HTTP://Example.com/a#frag")).toBe(
      "http://example.com/a"
    )
    expect(normalizeUrlForDedupe("http://example.com")).toBe(
      "http://example.com/"
    )
    expect(normalizeUrlForDedupe("nope")).toBeNull()
  })

  it("isBlankPageUrl recognizes the empty page and nothing that merely looks like it", () => {
    expect(isBlankPageUrl(BLANK_PAGE_URL)).toBe(true)
    expect(isBlankPageUrl("about:blank#anything")).toBe(true)
    // A site is never the empty page, however it is spelled.
    expect(isBlankPageUrl("about:srcdoc")).toBe(false)
    expect(isBlankPageUrl("https://about.blank/")).toBe(false)
    expect(isBlankPageUrl("https://example.com/about:blank")).toBe(false)
    // A query turns it into a different document (`about:blank?x` carries
    // data), so it is not the empty tab either.
    expect(isBlankPageUrl("about:blank?x=1")).toBe(false)
    expect(isBlankPageUrl("")).toBe(false)
  })

  it("displayHostPort keeps an explicit port and omits the default", () => {
    expect(displayHostPort("http://localhost:3000/app")).toBe("localhost:3000")
    expect(displayHostPort("https://example.com/")).toBe("example.com")
  })
})

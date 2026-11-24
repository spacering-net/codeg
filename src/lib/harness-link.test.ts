/**
 * The address an "Open in Codeg" link carries, from arrival to the Harness
 * page: what counts as one, how it comes off the page's address, the single
 * slot it waits in, and how it is carried across the instance's login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AFTER_LOGIN_MAX_AGE_MS,
  __resetHarnessLinkForTests,
  forgetHarnessLinkForLogin,
  harnessLinkRefOf,
  keepHarnessLinkForLogin,
  queueHarnessLink,
  subscribeWaitingHarnessLink,
  takeHarnessLinkAfterLogin,
  takeHarnessLinkFromAddress,
  takeWaitingHarnessLink,
  waitingHarnessLink,
  withoutHarnessLinkParam,
  workspacePathAfterLogin,
} from "./harness-link"

const AFTER_LOGIN_KEY = "codeg:harness-link-after-login"

beforeEach(() => {
  __resetHarnessLinkForTests()
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
})

describe("harnessLinkRefOf", () => {
  it.each([
    ["?harness=acme/pdf-tools", "acme/pdf-tools"],
    // The way the desktop app writes it on a cold start, and the login page.
    ["?harness=acme%2Fpdf-tools", "acme/pdf-tools"],
    ["?harness=browser-use.com%2Fbrowser-use", "browser-use.com/browser-use"],
    // Forgiven as everywhere else an address is read.
    ["?harness=%20Acme/PDF-Tools%20", "acme/pdf-tools"],
    ["harness=acme/pdf-tools", "acme/pdf-tools"],
  ])("reads %s", (search, ref) => {
    expect(harnessLinkRefOf(search)).toBe(ref)
  })

  it("ignores every other parameter", () => {
    expect(
      harnessLinkRefOf("?utm_source=spacering&harness=acme/pdf-tools&x=1#top")
    ).toBe("acme/pdf-tools")
    expect(harnessLinkRefOf("?ref=acme/pdf-tools")).toBeNull()
  })

  it("takes the first of a repeated parameter", () => {
    expect(harnessLinkRefOf("?harness=acme/one&harness=acme/two")).toBe(
      "acme/one"
    )
  })

  it.each([
    "",
    "?",
    "?harness",
    "?harness=",
    "?harness=acme",
    "?harness=acme/",
    "?harness=/pdf",
    "?harness=acme/pdf/extra",
    "?harness=acme%2Fpdf%2F..%2F..%2Fother",
    "?harness=..%2F..%2Fother%2Fname",
    "?harness=acme/pdf_tools",
    "?harness=acme/pdf%20tools",
    "?harness=-acme/pdf",
    "?harness=https://spacering.net/harness/acme/pdf",
    "?harness=scheme:acme/pdf",
    "?harness=%E7%94%A8%E6%88%B7/%E6%8A%80%E8%83%BD",
    `?harness=acme/${"a".repeat(65)}`,
    `?harness=${"a".repeat(254)}/pdf`,
    `?harness=${"a".repeat(100_000)}`,
  ])("refuses %j", (search) => {
    expect(harnessLinkRefOf(search)).toBeNull()
  })
})

describe("withoutHarnessLinkParam", () => {
  it.each([
    ["?harness=acme/pdf", ""],
    ["?harness=acme%2Fpdf&x=1", "?x=1"],
    ["?x=1&harness=acme/pdf", "?x=1"],
    ["?a=1&harness=acme/pdf&b=2", "?a=1&b=2"],
    // Every one of them, the ones that are not an address too.
    ["?harness=acme/one&harness=nope&b=2", "?b=2"],
    ["?harness&b=2", "?b=2"],
    ["", ""],
  ])("takes the parameter off %j", (search, expected) => {
    expect(withoutHarnessLinkParam(search)).toBe(expected)
  })

  it("leaves the rest spelled exactly as it was", () => {
    // Re-serializing would turn `%20` into `+` and `/` into `%2F`.
    expect(
      withoutHarnessLinkParam(
        "?remoteConnectionId=3&q=a%20b&path=/x/y&harness=acme/pdf&flag"
      )
    ).toBe("?remoteConnectionId=3&q=a%20b&path=/x/y&flag")
  })

  it("only takes off the one parameter, not look-alikes", () => {
    expect(withoutHarnessLinkParam("?harnesses=1&Harness=2&xharness=3")).toBe(
      "?harnesses=1&Harness=2&xharness=3"
    )
  })
})

describe("takeHarnessLinkFromAddress", () => {
  it("reads the item and takes the parameter off the address, keeping the rest and the hash", () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?folder=7&harness=acme%2Fpdf-tools&q=a%20b#section"
    )
    expect(takeHarnessLinkFromAddress()).toBe("acme/pdf-tools")
    expect(window.location.pathname).toBe("/workspace")
    expect(window.location.search).toBe("?folder=7&q=a%20b")
    expect(window.location.hash).toBe("#section")
  })

  it("can be read only once", () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    expect(takeHarnessLinkFromAddress()).toBe("acme/pdf-tools")
    expect(takeHarnessLinkFromAddress()).toBeNull()
    expect(window.location.pathname).toBe("/workspace")
    expect(window.location.search).toBe("")
  })

  it("drops a value that is not an address, and the parameter with it", () => {
    window.history.replaceState(null, "", "/workspace?harness=..%2Fx&a=1#h")
    expect(takeHarnessLinkFromAddress()).toBeNull()
    expect(window.location.search).toBe("?a=1")
    expect(window.location.hash).toBe("#h")
  })

  it("leaves an address without the parameter alone", () => {
    window.history.replaceState({ mine: 1 }, "", "/workspace?a=1#h")
    const replace = vi.spyOn(window.history, "replaceState")
    expect(takeHarnessLinkFromAddress()).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(window.history.state).toEqual({ mine: 1 })
  })

  it("replaces the entry rather than adding one, so back does not lead to it", () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    const before = window.history.length
    takeHarnessLinkFromAddress()
    expect(window.history.length).toBe(before)
  })
})

describe("the waiting link", () => {
  it("holds one address, the newest", () => {
    expect(waitingHarnessLink()).toBeNull()
    queueHarnessLink("acme/one")
    queueHarnessLink("acme/two")
    expect(waitingHarnessLink()).toBe("acme/two")
  })

  it("hands it out once", () => {
    queueHarnessLink("acme/pdf-tools")
    expect(takeWaitingHarnessLink()).toBe("acme/pdf-tools")
    expect(takeWaitingHarnessLink()).toBeNull()
    expect(waitingHarnessLink()).toBeNull()
  })

  it("refuses anything that is not an address, whoever hands it over", () => {
    queueHarnessLink("acme/ok")
    for (const bad of ["", "acme", "../x", "a/b/c", 42, null] as unknown[]) {
      queueHarnessLink(bad as string)
    }
    expect(waitingHarnessLink()).toBe("acme/ok")
  })

  it("keeps the address in its one spelling", () => {
    queueHarnessLink("  Acme/PDF-Tools ")
    expect(waitingHarnessLink()).toBe("acme/pdf-tools")
  })

  it("tells its listeners when it changes, and only then", () => {
    const listener = vi.fn()
    const off = subscribeWaitingHarnessLink(listener)
    queueHarnessLink("acme/pdf-tools")
    queueHarnessLink("acme/pdf-tools")
    expect(listener).toHaveBeenCalledTimes(1)
    takeWaitingHarnessLink()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    queueHarnessLink("acme/other")
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("across the instance's login", () => {
  it("keeps the waiting address for after the login, in this tab's storage", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    queueHarnessLink("acme/pdf-tools")
    keepHarnessLinkForLogin()
    expect(JSON.parse(sessionStorage.getItem(AFTER_LOGIN_KEY)!)).toEqual({
      ref: "acme/pdf-tools",
      at: 1_000_000,
    })
    expect(localStorage.length).toBe(0)
  })

  it("leaves no older address behind when nothing is waiting", () => {
    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ ref: "acme/old", at: Date.now() })
    )
    keepHarnessLinkForLogin()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("hands the kept address back once", () => {
    queueHarnessLink("acme/pdf-tools")
    keepHarnessLinkForLogin()
    expect(takeHarnessLinkAfterLogin()).toBe("acme/pdf-tools")
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
    expect(takeHarnessLinkAfterLogin()).toBeNull()
  })

  it("does not hand back an address kept too long ago, and drops it", () => {
    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ ref: "acme/pdf-tools", at: 5_000 })
    )
    expect(
      takeHarnessLinkAfterLogin(5_000 + AFTER_LOGIN_MAX_AGE_MS + 1)
    ).toBeNull()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()

    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ ref: "acme/pdf-tools", at: 5_000 })
    )
    expect(takeHarnessLinkAfterLogin(5_000 + AFTER_LOGIN_MAX_AGE_MS)).toBe(
      "acme/pdf-tools"
    )
  })

  it.each([
    ["not JSON", "{"],
    ["no object", "null"],
    ["no time", JSON.stringify({ ref: "acme/pdf-tools" })],
    ["a time to come", JSON.stringify({ ref: "acme/pdf-tools", at: 9e15 })],
    ["a time that is no number", JSON.stringify({ ref: "acme/x", at: "now" })],
    ["not an address", JSON.stringify({ ref: "../x", at: 1 })],
    ["no address", JSON.stringify({ at: 1 })],
  ])("hands back nothing for a kept value with %s", (_, raw) => {
    sessionStorage.setItem(AFTER_LOGIN_KEY, raw)
    expect(takeHarnessLinkAfterLogin(2)).toBeNull()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("is forgotten on request", () => {
    queueHarnessLink("acme/pdf-tools")
    keepHarnessLinkForLogin()
    forgetHarnessLinkForLogin()
    expect(takeHarnessLinkAfterLogin()).toBeNull()
  })

  it("survives storage that cannot be used, by having nothing", () => {
    const failing = () => {
      throw new DOMException("denied", "SecurityError")
    }
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(failing)
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(failing)
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(failing)
    queueHarnessLink("acme/pdf-tools")
    expect(() => keepHarnessLinkForLogin()).not.toThrow()
    expect(() => forgetHarnessLinkForLogin()).not.toThrow()
    expect(takeHarnessLinkAfterLogin()).toBeNull()
  })

  it("sends a successful login to the workspace, with the kept item once", () => {
    queueHarnessLink("browser-use.com/browser-use")
    keepHarnessLinkForLogin()
    expect(workspacePathAfterLogin()).toBe(
      "/workspace?harness=browser-use.com%2Fbrowser-use"
    )
    expect(workspacePathAfterLogin()).toBe("/workspace")
  })

  it("sends a login with nothing kept to the plain workspace", () => {
    expect(workspacePathAfterLogin()).toBe("/workspace")
  })
})

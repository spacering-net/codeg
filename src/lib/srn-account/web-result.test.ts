/**
 * How a Codeg Web sign-in's result (`/workspace?srn=…`) comes off the address,
 * waits to be shown, and is carried across the instance's login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AFTER_LOGIN_MAX_AGE_MS } from "@/lib/workspace-address"
import {
  __resetSrnResultForTests,
  claimSrnResultFromAddress,
  isSrnWebResult,
  keepSrnResultForLogin,
  queueSrnResult,
  srnProblemOfResult,
  takeSrnResultAfterLogin,
  takeSrnResultFromAddress,
  takeWaitingSrnResult,
  waitingSrnResult,
  withSrnResultAfterLogin,
} from "./web-result"

const AFTER_LOGIN_KEY = "codeg:srn-result-after-login"

beforeEach(() => {
  __resetSrnResultForTests()
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
})

describe("the results a sign-in can end with", () => {
  it.each([
    ["ok", null],
    ["access_denied", "accessDenied"],
    ["expired", "expired"],
    ["flow_missing", "flowMissing"],
    ["invalid_callback", "invalidCallback"],
    ["exchange_failed", "exchangeFailed"],
    ["client_rejected", "clientRejected"],
    ["network", "network"],
    ["rate_limited", "rateLimited"],
    ["server", "server"],
    ["invalid_response", "invalidResponse"],
    ["account_changed", "accountChanged"],
    ["revoked", "revoked"],
    ["not_enabled", "notEnabled"],
    ["key_unavailable", "keyUnavailable"],
    ["storage_failed", "storage"],
    ["internal", "internal"],
  ])("%s is a result, said as %s", (result, name) => {
    expect(isSrnWebResult(result)).toBe(true)
    expect(srnProblemOfResult(result)?.name ?? null).toBe(name)
    // A result never carries a number.
    expect(srnProblemOfResult(result)?.params.seconds).toBeUndefined()
  })

  it.each(["", "OK", "storage", "toString", "__proto__", "ok ", "<b>"])(
    "%j is not one",
    (value) => {
      expect(isSrnWebResult(value)).toBe(false)
    }
  )
})

describe("takeSrnResultFromAddress", () => {
  it("reads the result and takes it off the address, keeping the rest and the hash", () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?folder=7&srn=access_denied&x=a%20b#files"
    )
    expect(takeSrnResultFromAddress()).toBe("access_denied")
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    ).toBe("/workspace?folder=7&x=a%20b#files")
  })

  it("can be read only once", () => {
    window.history.replaceState(null, "", "/workspace?srn=ok")
    expect(takeSrnResultFromAddress()).toBe("ok")
    expect(takeSrnResultFromAddress()).toBeNull()
  })

  it("drops a value that is not a result, and the parameter with it", () => {
    window.history.replaceState(null, "", "/workspace?srn=%3Cscript%3E#x")
    expect(takeSrnResultFromAddress()).toBeNull()
    expect(`${window.location.search}${window.location.hash}`).toBe("#x")
  })

  it("replaces the entry rather than adding one, so back does not lead to it", () => {
    window.history.replaceState(null, "", "/workspace?srn=ok")
    const length = window.history.length
    takeSrnResultFromAddress()
    expect(window.history.length).toBe(length)
  })

  it("leaves a Harness link beside it alone", () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?harness=acme%2Fpdf&srn=expired"
    )
    expect(takeSrnResultFromAddress()).toBe("expired")
    expect(window.location.search).toBe("?harness=acme%2Fpdf")
  })
})

describe("the waiting result", () => {
  it("is claimed from the address once, and handed out once", () => {
    window.history.replaceState(null, "", "/workspace?srn=revoked")
    claimSrnResultFromAddress()
    claimSrnResultFromAddress()
    expect(waitingSrnResult()).toBe("revoked")
    expect(takeWaitingSrnResult()).toBe("revoked")
    expect(takeWaitingSrnResult()).toBeNull()
  })

  it("refuses anything that is not a result", () => {
    queueSrnResult("nope")
    expect(waitingSrnResult()).toBeNull()
  })
})

describe("across the instance's login", () => {
  it("keeps a result not shown yet, in this tab's storage", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    queueSrnResult("access_denied")
    keepSrnResultForLogin()
    expect(JSON.parse(sessionStorage.getItem(AFTER_LOGIN_KEY)!)).toEqual({
      result: "access_denied",
      at: 1_000_000,
    })
  })

  it("leaves no older result behind when nothing is waiting", () => {
    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ result: "ok", at: Date.now() })
    )
    keepSrnResultForLogin()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })

  it("puts the kept result back into the workspace's address, once", () => {
    queueSrnResult("expired")
    keepSrnResultForLogin()
    expect(withSrnResultAfterLogin("/workspace?harness=acme%2Fpdf")).toBe(
      "/workspace?harness=acme%2Fpdf&srn=expired"
    )
    expect(withSrnResultAfterLogin("/workspace")).toBe("/workspace")

    queueSrnResult("ok")
    keepSrnResultForLogin()
    expect(withSrnResultAfterLogin("/workspace")).toBe("/workspace?srn=ok")
  })

  it("drops a result kept too long ago, or one that is not a result", () => {
    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ result: "ok", at: 5_000 })
    )
    expect(takeSrnResultAfterLogin(5_000 + AFTER_LOGIN_MAX_AGE_MS + 1)).toBe(
      null
    )
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()

    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ result: "javascript:x", at: Date.now() })
    )
    expect(takeSrnResultAfterLogin()).toBeNull()
  })

  it("is forgotten as the workspace loads: that login is over", () => {
    queueSrnResult("ok")
    keepSrnResultForLogin()
    __resetSrnResultForTests()
    claimSrnResultFromAddress()
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
    expect(waitingSrnResult()).toBeNull()
  })
})

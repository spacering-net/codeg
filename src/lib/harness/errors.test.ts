import { describe, expect, it } from "vitest"

import {
  HarnessClientError,
  harnessFailureOf,
  isRetryableFailure,
  isUnsupportedCommandError,
} from "./errors"
import { backendError } from "./test-fixtures"

describe("harnessFailureOf — the backend's own failures", () => {
  it.each([
    "disabled",
    "network",
    "notFound",
    "invalidRef",
    "tooLarge",
    "invalidResponse",
  ] as const)("reads %s from its i18n key", (kind) => {
    expect(harnessFailureOf(backendError(kind))).toEqual({ kind, detail: "" })
  })

  it("carries how long a rate limit asks to wait", () => {
    expect(
      harnessFailureOf(backendError("rateLimited", { seconds: "42" }))
    ).toEqual({ kind: "rateLimited", seconds: 42, detail: "" })
  })

  it.each<Record<string, string> | undefined>([
    undefined,
    {},
    { seconds: "soon" },
    { seconds: "0" },
  ])("waits a minute when a rate limit gives no usable time (%j)", (params) => {
    expect(harnessFailureOf(backendError("rateLimited", params))).toEqual({
      kind: "rateLimited",
      seconds: 60,
      detail: "",
    })
  })

  it("carries the status of a server error", () => {
    expect(harnessFailureOf(backendError("server", { status: "503" }))).toEqual(
      { kind: "server", status: "503", detail: "" }
    )
  })

  it("reads the same failure when a transport delivers it as a JSON message", () => {
    const wrapped = new Error(JSON.stringify(backendError("network")))
    expect(harnessFailureOf(wrapped)).toEqual({ kind: "network", detail: "" })
  })

  it("shows a kind a newer backend added with the text it came with", () => {
    expect(harnessFailureOf(backendError("quotaExceeded"))).toEqual({
      kind: "unknown",
      detail: "harness quotaExceeded",
    })
  })
})

describe("harnessFailureOf — a backend without the commands", () => {
  it("recognizes a browser's 501 from codeg-server", () => {
    const error = {
      code: "not_implemented",
      message: "API endpoint 'harness_list' is not available in web mode",
    }
    expect(isUnsupportedCommandError(error)).toBe(true)
    expect(harnessFailureOf(error)).toEqual({
      kind: "unsupported",
      detail: "",
    })
  })

  it("recognizes the same 501 relayed by a remote workspace window", () => {
    const error = {
      code: "network_error",
      message: "Remote returned HTTP 501 Not Implemented",
      detail:
        '{"code":"not_implemented","message":"API endpoint \'harness_list\' is not available in web mode"}',
    }
    expect(harnessFailureOf(error).kind).toBe("unsupported")
  })

  it("recognizes a desktop build without the command", () => {
    expect(harnessFailureOf("Command harness_status not found").kind).toBe(
      "unsupported"
    )
  })

  it("does not mistake the catalog's own 501 for an old backend", () => {
    const error = {
      ...backendError("server", { status: "501" }),
      message: "Remote returned HTTP 501 Not Implemented",
    }
    expect(harnessFailureOf(error)).toEqual({
      kind: "server",
      status: "501",
      detail: "",
    })
  })

  it.each([
    { code: "network_error", message: "Remote HTTP request failed" },
    { code: "network_error", message: "Remote returned HTTP 502 Bad Gateway" },
    new Error("Request timed out"),
    "Command not found in the manual",
    null,
    undefined,
    42,
  ])("does not call %j unsupported", (error) => {
    expect(isUnsupportedCommandError(error)).toBe(false)
  })
})

describe("harnessFailureOf — everything else", () => {
  it("keeps a client-side failure's kind", () => {
    expect(
      harnessFailureOf(new HarnessClientError("invalidRef", "bad address"))
    ).toEqual({ kind: "invalidRef", detail: "" })
  })

  it("passes on the text of a failure it cannot name", () => {
    expect(harnessFailureOf(new Error("Request timed out"))).toEqual({
      kind: "unknown",
      detail: "Request timed out",
    })
    expect(
      harnessFailureOf({
        code: "network_error",
        message: "Remote HTTP request failed",
        detail: "connection refused",
      })
    ).toEqual({ kind: "unknown", detail: "connection refused" })
  })

  it.each([null, undefined, 0, "", {}, []])("never throws on %j", (value) => {
    expect(harnessFailureOf(value).kind).toBe("unknown")
  })
})

describe("isRetryableFailure", () => {
  it.each([
    ["network", true],
    ["rateLimited", true],
    ["server", true],
    ["tooLarge", true],
    ["invalidResponse", true],
    ["unknown", true],
    ["notFound", false],
    ["invalidRef", false],
    ["unsupported", false],
    ["disabled", false],
  ] as const)("%s → %s", (kind, retryable) => {
    expect(isRetryableFailure({ kind, detail: "" })).toBe(retryable)
  })
})

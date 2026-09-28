import { describe, expect, it } from "vitest"

import {
  acpErrorNotifiesDesktop,
  isTurnFailureCode,
  routeAcpError,
} from "./acp-error-presentation"

describe("routeAcpError", () => {
  it("keeps session-state failures as the session's own error", () => {
    for (const code of [
      "initialize_timeout",
      "process_exited",
      "turn_failed_refusal",
      "turn_failed_empty",
      "turn_failed_auth_required",
    ]) {
      expect(routeAcpError(code)).toMatchObject({
        kind: "session",
        level: "error",
      })
    }
  })

  it("defaults unknown and absent codes to the conservative session error", () => {
    const fallback = { kind: "session", level: "error", rawAsDetail: false }
    expect(routeAcpError("some_future_code")).toEqual(fallback)
    expect(routeAcpError(null)).toEqual(fallback)
    expect(routeAcpError(undefined)).toEqual(fallback)
    expect(routeAcpError("")).toEqual(fallback)
  })

  it("treats the answer to a click as that and nothing more", () => {
    expect(routeAcpError("set_mode_failed")).toMatchObject({
      kind: "action",
      level: "error",
    })
    expect(routeAcpError("set_config_option_failed")).toMatchObject({
      kind: "action",
      level: "error",
    })
    expect(routeAcpError("goal_control_failed")).toMatchObject({
      kind: "action",
      level: "error",
    })
    expect(routeAcpError("grok_model_switch_incompatible_agent")).toMatchObject(
      { kind: "action", level: "warning" }
    )
    expect(routeAcpError("image_dropped")).toMatchObject({
      kind: "action",
      level: "warning",
    })
  })

  it("leaves a failure the transcript's card shows to that card", () => {
    const route = routeAcpError("compaction_failed")
    expect(route.kind).toBe("transcript")
    expect(acpErrorNotifiesDesktop(route)).toBe(false)
  })

  it("keeps a session restored as new as an amber session state", () => {
    expect(routeAcpError("session_load_fallback")).toMatchObject({
      kind: "session",
      level: "warning",
      rawAsDetail: true,
    })
  })

  it("keeps the raw reason where the localized line drops it", () => {
    // The localized line for these names only the agent; the backend's own
    // reason must not be lost.
    for (const code of [
      "set_mode_failed",
      "set_config_option_failed",
      "goal_control_failed",
      "image_dropped",
      "session_load_fallback",
    ]) {
      expect(routeAcpError(code).rawAsDetail).toBe(true)
    }
    // …while this one's localized sentence is complete on its own.
    expect(
      routeAcpError("grok_model_switch_incompatible_agent").rawAsDetail
    ).toBe(false)
  })
})

describe("acpErrorNotifiesDesktop", () => {
  it("notifies only for a session that broke", () => {
    expect(acpErrorNotifiesDesktop(routeAcpError("process_exited"))).toBe(true)
    expect(acpErrorNotifiesDesktop(routeAcpError(null))).toBe(true)
    expect(
      acpErrorNotifiesDesktop(routeAcpError("session_load_fallback"))
    ).toBe(false)
    expect(acpErrorNotifiesDesktop(routeAcpError("set_mode_failed"))).toBe(
      false
    )
  })
})

describe("isTurnFailureCode", () => {
  it("recognizes codeg's verdicts on a failed turn", () => {
    for (const code of [
      "turn_failed_refusal",
      "turn_failed_empty",
      "turn_failed_empty_protocol",
      "turn_failed_auth_required",
    ]) {
      expect(isTurnFailureCode(code)).toBe(true)
    }
  })

  it("leaves every other failure alone", () => {
    for (const code of [
      "process_exited",
      "initialize_timeout",
      "session_load_fallback",
      "",
      null,
      undefined,
    ]) {
      expect(isTurnFailureCode(code)).toBe(false)
    }
  })
})

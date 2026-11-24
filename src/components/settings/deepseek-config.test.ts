import { describe, expect, it } from "vitest"

import {
  buildDeepSeekEnv,
  isValidDeepSeekBaseUrl,
} from "./deepseek-config-panel"

describe("buildDeepSeekEnv", () => {
  it("writes the two knobs the panel owns", () => {
    expect(
      buildDeepSeekEnv({}, " sk-abc ", " https://gw.example.com ")
    ).toEqual({
      DEEPSEEK_API_KEY: "sk-abc",
      DEEPSEEK_BASE_URL: "https://gw.example.com",
    })
  })

  it("leaves the birth model to the raw env editor", () => {
    // The model is a per-session selector; the panel does not show it, so a
    // save must not touch the launch default someone set by hand.
    const prev = { DEEPSEEK_ACP_MODEL: "gw-private-model" }
    expect(buildDeepSeekEnv(prev, "sk-1", "")).toEqual({
      DEEPSEEK_ACP_MODEL: "gw-private-model",
      DEEPSEEK_API_KEY: "sk-1",
    })
  })

  it("deletes rather than blanks an emptied field", () => {
    // An empty `DEEPSEEK_BASE_URL` is an empty endpoint rather than "fall back
    // to the default", so the key has to disappear.
    const prev = {
      DEEPSEEK_API_KEY: "sk-old",
      DEEPSEEK_BASE_URL: "https://old.example.com",
    }
    expect(buildDeepSeekEnv(prev, "", "")).toEqual({})
  })

  it("strips trailing slashes from the endpoint", () => {
    // The adapter concatenates `${baseURL}/chat/completions`.
    expect(
      buildDeepSeekEnv({}, "", "https://gw.example.com//").DEEPSEEK_BASE_URL
    ).toBe("https://gw.example.com")
  })

  it("preserves unrelated keys, including a real provider route", () => {
    // `DEEPSEEK_ACP_PROVIDER` is deliberately not exposed by the panel (only
    // the `deepseek-official` route exists), so a value set by hand or by an
    // older build must survive a save.
    const prev = {
      DEEPSEEK_ACP_PROVIDER: "deepseek-official",
      DSH_HOME: "/data/dsh",
    }
    expect(buildDeepSeekEnv(prev, "sk-1", "")).toEqual({
      DEEPSEEK_ACP_PROVIDER: "deepseek-official",
      DSH_HOME: "/data/dsh",
      DEEPSEEK_API_KEY: "sk-1",
    })
  })

  it("drops a provider route holding a URL", () => {
    // An earlier build bound the settings page's "API base URL" field to
    // DEEPSEEK_ACP_PROVIDER. A URL is never a valid route id, and leaving it
    // makes `agents.create()` reject every session while the endpoint field on
    // screen looks perfectly correct.
    const prev = { DEEPSEEK_ACP_PROVIDER: "https://api.deepseek.com" }
    expect(buildDeepSeekEnv(prev, "", "https://gw.example.com")).toEqual({
      DEEPSEEK_BASE_URL: "https://gw.example.com",
    })
  })
})

describe("isValidDeepSeekBaseUrl", () => {
  it("accepts empty (meaning: use the adapter default)", () => {
    expect(isValidDeepSeekBaseUrl("")).toBe(true)
    expect(isValidDeepSeekBaseUrl("   ")).toBe(true)
  })

  it("accepts http(s) URLs and rejects anything else", () => {
    expect(isValidDeepSeekBaseUrl("https://api.deepseek.com")).toBe(true)
    expect(isValidDeepSeekBaseUrl("http://127.0.0.1:8080/v1")).toBe(true)
    // A bare host has no scheme to fetch with; the failure would otherwise
    // only surface at the first turn.
    expect(isValidDeepSeekBaseUrl("api.deepseek.com")).toBe(false)
    expect(isValidDeepSeekBaseUrl("ftp://api.deepseek.com")).toBe(false)
  })

  it("rejects a query string or fragment", () => {
    // The adapter builds `${baseURL}/chat/completions` by concatenation, so a
    // query would swallow the path: `/v1?api-version=1` requests the path
    // `/v1` with the query `api-version=1/chat/completions`.
    expect(
      isValidDeepSeekBaseUrl("https://gw.example.com/v1?api-version=1")
    ).toBe(false)
    expect(isValidDeepSeekBaseUrl("https://gw.example.com/v1#frag")).toBe(false)
    // A bare delimiter parses to an EMPTY `search`/`hash`, so the check has to
    // read the raw text — the character is still there when it is concatenated.
    expect(isValidDeepSeekBaseUrl("https://gw.example.com/v1?")).toBe(false)
    expect(isValidDeepSeekBaseUrl("https://gw.example.com/v1#")).toBe(false)
  })

  it("rejects an endpoint carrying credentials", () => {
    // `fetch` refuses to construct a request from such a URL, and the error
    // names neither this field nor the reason.
    expect(isValidDeepSeekBaseUrl("https://user:pass@gw.example.com")).toBe(
      false
    )
  })
})

import { describe, expect, it } from "vitest"

import { jsonExcerpt, parseJsonOrThrow } from "./json-parse-error"

/** What the engine says on its own, so a test can assert the delta. */
function nativeMessage(raw: string): string {
  try {
    JSON.parse(raw)
    return ""
  } catch (err) {
    return (err as Error).message
  }
}

describe("parseJsonOrThrow", () => {
  it("returns the parsed value unchanged on valid JSON", () => {
    expect(parseJsonOrThrow<{ a: number }>('{"a":1}', "API test")).toEqual({
      a: 1,
    })
  })

  it("names the source in the error", () => {
    expect(() => parseJsonOrThrow("{oops", "API acp_list_agents")).toThrow(
      /Invalid JSON from API acp_list_agents/
    )
  })

  it("reports the payload size, which is what identifies a truncation", () => {
    const raw = `{"k":"${"x".repeat(200)}`
    expect(() => parseJsonOrThrow(raw, "API big")).toThrow(
      new RegExp(`\\(${raw.length} chars\\)`)
    )
  })

  it("keeps the engine's own message so the offset is not lost", () => {
    let message = ""
    try {
      parseJsonOrThrow('{"a":', "src")
    } catch (err) {
      message = (err as Error).message
    }
    let native = ""
    try {
      JSON.parse('{"a":')
    } catch (err) {
      native = (err as Error).message
    }
    expect(message).toContain(native)
  })

  it("sketches the document around the failure", () => {
    let message = ""
    try {
      // Unterminated string — the exact shape reported in #736.
      parseJsonOrThrow(`{"key":"${"v".repeat(80)}`, "API x")
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("near:")
    // The run of letters survives as its class, so the shape of the break is
    // still legible without the bytes.
    expect(message).toContain("aaa")
  })

  /**
   * The payload that produced the #736 report was `acp_list_agents`, whose rows
   * carry each agent's `env` — where users keep their provider API keys. This
   * error message is the one thing a user is invited to paste into a public
   * issue, so no byte of the body may reach it.
   */
  it("never lets a credential in the payload reach the error message", () => {
    const secret = "sk-ant-api03-REALSECRET"
    // Long enough that V8 reports a position rather than quoting the document.
    const raw = `{"env":{"ANTHROPIC_API_KEY":"${secret}"},"k":"${"v".repeat(200)}`
    let message = ""
    try {
      parseJsonOrThrow(raw, "API y")
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain(secret)
    expect(message).not.toContain("REALSECRET")
    // ...but the structure that identifies the failure is still there.
    expect(message).toContain("API y")
    expect(message).toContain("⟪here⟫")
  })

  /**
   * V8 does not only report a position: for a short document it quotes the
   * source straight back — `Unexpected token '}', ..."RET"},"x":}" is not valid
   * JSON`. Redacting our own excerpt would buy nothing while that rode along.
   */
  it("drops the source text V8 embeds in its own message", () => {
    // Short enough that V8 quotes the WHOLE document rather than a window —
    // verified: `JSON.parse('{"k":"SSSSS","x":}')` reports
    // `Unexpected token '}', "{"k":"SSSSS","x":}" is not valid JSON`. Use a
    // longer body and the window happens to cut the secret in half, which
    // would make this test pass without the stripping it is named after.
    const secret = "SSSSS"
    const raw = `{"k":"${secret}","x":}`
    let message = ""
    try {
      parseJsonOrThrow(raw, "API z")
    } catch (err) {
      message = (err as Error).message
    }
    expect(JSON.stringify({ native: nativeMessage(raw) })).toContain(secret)
    expect(message).not.toContain(secret)
    // The failure is still named; only the quoted document is gone.
    expect(message.toLowerCase()).toContain("unexpected")
    expect(message).toContain("API z")
  })

  /**
   * The engine also names the OFFENDING TOKEN, which is one more body byte.
   * Measured formats, all of which have to be covered:
   *   V8          `Unexpected token '}', "…" is not valid JSON`
   *   V8 (older)  `Unexpected token o in JSON at position 1`
   *   JSC/WebKit  `JSON Parse error: Unexpected identifier "SECRET"`
   * JSC is what the desktop build's webview runs, so this is not academic.
   */
  it("redacts the offending token the engine names", () => {
    let message = ""
    try {
      // A bare word: every engine reports it by quoting the word itself.
      parseJsonOrThrow("SECRET", "API w")
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain("SECRET")
    // The single quoted character is the load-bearing assertion: the
    // double-quote cut alone already removes the long form, so checking only
    // for "SECRET" would pass with the token left verbatim. V8 reports `'S'`
    // here and JSC reports no single-quoted token at all, so the negative
    // holds on both while the mutation (token unredacted) breaks it.
    expect(message).not.toMatch(/'S'/)
    expect(message).toContain("API w")
  })
})

describe("jsonExcerpt", () => {
  it("marks the offset", () => {
    expect(jsonExcerpt("abcdef", 3)).toContain("⟪here⟫")
  })

  it("elides both sides of a long document", () => {
    const raw = "x".repeat(500)
    const excerpt = jsonExcerpt(raw, 250)
    expect(excerpt.startsWith("…")).toBe(true)
    expect(excerpt.endsWith("…")).toBe(true)
    expect(excerpt.length).toBeLessThan(raw.length)
  })

  it("escapes control characters instead of smearing them across the output", () => {
    // A literal newline inside a string is one of the ways a JSON body ends up
    // unparseable; the excerpt has to stay on one line to be readable.
    const excerpt = jsonExcerpt('{"a":"b\nc"}', 7)
    expect(excerpt).toContain("\\x0a")
    expect(excerpt).not.toContain("\n")
  })

  /** Structure is the whole point of the excerpt, so punctuation is verbatim. */
  it("keeps JSON punctuation while collapsing letters and digits", () => {
    expect(jsonExcerpt('{"key":123}', 11)).toContain('{"aaa":000}')
  })

  /**
   * "The server sent an HTML error page" is the single most common cause, and
   * has to stay recognizable after redaction or the excerpt earns nothing.
   */
  it("leaves an HTML error page recognizable", () => {
    expect(jsonExcerpt("<!DOCTYPE html><html>", 0)).toContain(
      "<!AAAAAAA aaaa><aaaa>"
    )
  })

  it("redacts the no-offset fallback too", () => {
    expect(jsonExcerpt('{"tok":"s3cret"}', null)).toBe('{"aaa":"a0aaaa"}')
  })

  /**
   * Slicing on a UTF-16 boundary can cut an astral character in half. The lone
   * surrogate left behind must not reach the output as a broken code unit.
   */
  it("never emits a lone surrogate from a split astral character", () => {
    const raw = `${"a".repeat(59)}😀${"b".repeat(59)}`
    const excerpt = jsonExcerpt(raw, 60)
    for (const unit of excerpt) {
      const code = unit.charCodeAt(0)
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false)
    }
  })

  /** An offset past the end still has to produce the tail, not an empty window. */
  it("clamps an out-of-range offset", () => {
    const excerpt = jsonExcerpt('{"a":1}', 9999)
    expect(excerpt).toContain("⟪here⟫")
    expect(excerpt).toContain('{"a":0}')
  })

  it("falls back to a bounded prefix when the engine reported no offset", () => {
    const raw = "y".repeat(500)
    const excerpt = jsonExcerpt(raw, null)
    expect(excerpt.length).toBeLessThan(raw.length)
    expect(excerpt.endsWith("…")).toBe(true)
  })
})

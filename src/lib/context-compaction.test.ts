import { describe, expect, it } from "vitest"

import {
  COMPACTION_SUMMARY_META_KEY,
  contextCompactionPayload,
  contextCompactionSummary,
  isContextCompactionMeta,
} from "./context-compaction"

describe("isContextCompactionMeta", () => {
  it("accepts the legacy boolean marker (codex ≤1.2.x, grok bridge)", () => {
    expect(isContextCompactionMeta({ contextCompaction: true })).toBe(true)
    // Grok stamps sibling token counts next to the marker.
    expect(
      isContextCompactionMeta({
        contextCompaction: true,
        tokensBefore: 51777,
        tokensAfter: 4616,
      })
    ).toBe(true)
  })

  it("accepts the versioned object (codex-acp 1.3.0+, #396)", () => {
    // 1.3.0 emits the bare payload…
    expect(isContextCompactionMeta({ contextCompaction: { version: 1 } })).toBe(
      true
    )
    // …the schema reserves optional fields…
    expect(
      isContextCompactionMeta({
        contextCompaction: {
          version: 1,
          preTokens: 51777,
          postTokens: 4616,
          durationMs: 3200,
          trigger: "auto",
        },
      })
    ).toBe(true)
    // …and future versions must keep matching (forward-compatible).
    expect(isContextCompactionMeta({ contextCompaction: { version: 2 } })).toBe(
      true
    )
  })

  it("rejects non-marker shapes", () => {
    expect(isContextCompactionMeta(null)).toBe(false)
    expect(isContextCompactionMeta(undefined)).toBe(false)
    expect(isContextCompactionMeta("contextCompaction")).toBe(false)
    expect(isContextCompactionMeta({})).toBe(false)
    expect(isContextCompactionMeta({ contextCompaction: false })).toBe(false)
    expect(isContextCompactionMeta({ contextCompaction: "true" })).toBe(false)
    expect(isContextCompactionMeta({ contextCompaction: 1 })).toBe(false)
    // An object without a valid integer version ≥ 1 is not the versioned form.
    expect(isContextCompactionMeta({ contextCompaction: {} })).toBe(false)
    expect(isContextCompactionMeta({ contextCompaction: { version: 0 } })).toBe(
      false
    )
    expect(
      isContextCompactionMeta({ contextCompaction: { version: 1.5 } })
    ).toBe(false)
    expect(
      isContextCompactionMeta({ contextCompaction: { version: "1" } })
    ).toBe(false)
  })
})

describe("contextCompactionPayload", () => {
  it("returns the versioned payload object", () => {
    const payload = { version: 1, preTokens: 100, postTokens: 40 }
    expect(
      contextCompactionPayload({ contextCompaction: payload })
    ).toStrictEqual(payload)
  })

  it("returns null for the boolean marker and non-compaction meta", () => {
    expect(contextCompactionPayload({ contextCompaction: true })).toBeNull()
    expect(contextCompactionPayload({ contextCompaction: false })).toBeNull()
    expect(contextCompactionPayload({})).toBeNull()
    expect(contextCompactionPayload(null)).toBeNull()
  })
})

describe("contextCompactionSummary", () => {
  const claimed = {
    contextCompaction: { version: 1 },
    [COMPACTION_SUMMARY_META_KEY]: true,
  }

  it("returns the output of a call the backend claimed", () => {
    expect(contextCompactionSummary(claimed, "We refactored the parser.")).toBe(
      "We refactored the parser."
    )
  })

  it("ignores output the backend did not claim as a summary", () => {
    // claude's LEGACY call parks its metadata object on the same channel.
    expect(
      contextCompactionSummary(
        { contextCompaction: { version: 1 } },
        '{"trigger":"manual","preTokens":191322}'
      )
    ).toBeNull()
    // The grok bridge's boolean marker never carries one either.
    expect(
      contextCompactionSummary({ contextCompaction: true }, "text")
    ).toBeNull()
  })

  it("requires the claim on a compaction call, and a non-blank output", () => {
    expect(
      contextCompactionSummary({ [COMPACTION_SUMMARY_META_KEY]: true }, "x")
    ).toBeNull()
    expect(
      contextCompactionSummary(
        { ...claimed, [COMPACTION_SUMMARY_META_KEY]: "true" },
        "x"
      )
    ).toBeNull()
    expect(contextCompactionSummary(claimed, null)).toBeNull()
    expect(contextCompactionSummary(claimed, undefined)).toBeNull()
    expect(contextCompactionSummary(claimed, "  \n ")).toBeNull()
  })
})

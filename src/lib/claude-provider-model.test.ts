import { describe, expect, it } from "vitest"

import {
  parseClaudeProviderModel,
  serializeClaudeProviderModel,
  type ClaudeProviderModel,
} from "@/lib/types"

describe("Claude provider model with custom option trio", () => {
  // The custom model option trio rides along with the six model fields in the
  // provider's `model` JSON, so a round-trip must preserve all nine keys.
  it("round-trips the six model fields plus the custom option trio", () => {
    const model: ClaudeProviderModel = {
      main: "gw/main",
      reasoning: "gw/reasoning",
      haiku: "gw/haiku",
      sonnet: "gw/sonnet",
      opus: "gw/opus",
      fable: "gw/fable",
      customOption: "gw/opus-preview",
      customOptionName: "Gateway Opus",
      customOptionDescription: "via gateway",
    }

    const serialized = serializeClaudeProviderModel(model)
    expect(serialized).not.toBeNull()
    expect(parseClaudeProviderModel(serialized)).toEqual(model)
  })

  // A provider may define ONLY a custom option (no standard model overrides);
  // serialize must still emit it rather than collapsing to null.
  it("serializes a provider that defines only the custom option", () => {
    const serialized = serializeClaudeProviderModel({
      customOption: "gw/opus-preview",
    })
    expect(serialized).not.toBeNull()
    const parsed = parseClaudeProviderModel(serialized)
    expect(parsed.customOption).toBe("gw/opus-preview")
    expect(parsed.main).toBeUndefined()
  })

  // Empty/whitespace custom values are dropped on both serialize and parse,
  // matching the trim-or-omit semantics of the six model fields.
  it("drops empty custom option values", () => {
    expect(
      serializeClaudeProviderModel({
        main: "gw/main",
        customOption: "   ",
        customOptionName: "",
      })
    ).toBe(JSON.stringify({ main: "gw/main" }))

    const parsed = parseClaudeProviderModel(
      JSON.stringify({
        main: "gw/main",
        customOption: "",
        customOptionName: 42,
      })
    )
    expect(parsed).toEqual({ main: "gw/main" })
  })

  // Backward compatibility: a legacy provider JSON with only the five model
  // fields parses with no custom keys.
  it("parses legacy provider JSON without custom keys", () => {
    const parsed = parseClaudeProviderModel(
      JSON.stringify({ main: "claude-sonnet-4-6", opus: "claude-opus-4-8" })
    )
    expect(parsed).toEqual({
      main: "claude-sonnet-4-6",
      opus: "claude-opus-4-8",
    })
    expect(parsed.customOption).toBeUndefined()
  })
})

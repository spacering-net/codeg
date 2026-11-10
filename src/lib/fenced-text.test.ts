import { describe, expect, it } from "vitest"

import { unwrapWholeFence } from "@/lib/fenced-text"

const REFUSAL =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

describe("unwrapWholeFence", () => {
  it("lifts the fence claude-agent-acp puts around a failed tool's result", () => {
    expect(unwrapWholeFence("```\n" + REFUSAL + "\n```")).toBe(REFUSAL)
    expect(unwrapWholeFence("```\nline one\nline two\n```")).toBe(
      "line one\nline two"
    )
  })

  it("lifts a fence with an info string, a longer run, or surrounding blank lines", () => {
    expect(unwrapWholeFence("```console\n$ false\n```")).toBe("$ false")
    expect(unwrapWholeFence("````\nhas ``` inside a line\n````")).toBe(
      "has ``` inside a line"
    )
    expect(unwrapWholeFence("\n```\nbody\n```\n")).toBe("body")
  })

  it("leaves text that is not one fenced block as written", () => {
    for (const text of [
      "File does not exist.",
      "Error: ```\nnot a fence opener\n```",
      "```\nfirst\n```\nbetween\n```\nsecond\n```",
      "```\nunclosed",
      "```\nclosed by a longer run\n````",
      "```\n```",
    ]) {
      expect(unwrapWholeFence(text)).toBe(text)
    }
  })
})

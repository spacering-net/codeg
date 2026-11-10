import { describe, expect, it } from "vitest"

import { thoughtBodyWithoutTitle, thoughtTitle } from "./thought"

const SUMMARY = [
  "**Summarizing log status**",
  "",
  "I need to gather the logs.",
  "",
  "**Checking the Makefile**",
  "",
  "The docs target is missing.",
].join("\n")

describe("thoughtTitle", () => {
  it("uses the first heading once the thought is done", () => {
    expect(thoughtTitle(SUMMARY, false)).toBe("Summarizing log status")
  })

  it("uses the newest heading while it is still being written", () => {
    expect(thoughtTitle(SUMMARY, true)).toBe("Checking the Makefile")
  })

  it("accepts ATX headings and ignores fenced code", () => {
    expect(
      thoughtTitle("```\n# not a title\n```\n## Real title\nbody", false)
    ).toBe("Real title")
  })

  it("falls back to the first sentence", () => {
    expect(
      thoughtTitle("Let me look at the parser first. Then the tests.", false)
    ).toBe("Let me look at the parser first")
    expect(thoughtTitle("- `foo` is broken\nmore", false)).toBe("foo is broken")
  })

  it("clips long titles", () => {
    const title = thoughtTitle("x".repeat(80), false)
    expect(title).toHaveLength(60)
    expect(title?.endsWith("…")).toBe(true)
  })

  it("is null for an empty thought", () => {
    expect(thoughtTitle("  \n ", false)).toBeNull()
  })
})

describe("thoughtBodyWithoutTitle", () => {
  it("drops the heading the row already shows", () => {
    expect(thoughtBodyWithoutTitle(SUMMARY, "Summarizing log status")).toBe(
      SUMMARY.split("\n").slice(2).join("\n")
    )
  })

  it("keeps the body when the title came from elsewhere", () => {
    const content = "Plain reasoning text."
    expect(thoughtBodyWithoutTitle(content, "Plain reasoning text")).toBe(
      content
    )
  })
})

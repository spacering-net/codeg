import { describe, expect, it } from "vitest"

import {
  readLineCount,
  searchResultText,
  summarizeSearchResult,
} from "./explore"

describe("readLineCount", () => {
  it("counts the content of the structured read shape", () => {
    expect(
      readLineCount(JSON.stringify({ start_line: 10, content: "a\nb\nc\n" }))
    ).toBe(3)
  })

  it("counts raw text and codex's command envelope", () => {
    expect(readLineCount("one\ntwo")).toBe(2)
    expect(
      readLineCount(
        JSON.stringify({ formatted_output: "x\ny\nz", exit_code: 0 })
      )
    ).toBe(3)
  })

  it("is null when nothing came back", () => {
    expect(readLineCount("")).toBeNull()
    expect(readLineCount(null)).toBeNull()
  })
})

describe("searchResultText", () => {
  it("treats codex's empty exit-1 grep envelope as no matches", () => {
    expect(
      searchResultText(
        "grep",
        null,
        JSON.stringify({ formatted_output: "", exit_code: 1 })
      )
    ).toBe("")
  })

  it("keeps a real grep failure out", () => {
    expect(searchResultText("grep", null, "rg: bad regex")).toBeNull()
  })

  it("unwraps codex's envelope and passes other output through", () => {
    expect(
      searchResultText(
        "grep",
        JSON.stringify({ formatted_output: "a.ts:1:x", exit_code: 0 }),
        null
      )
    ).toBe("a.ts:1:x")
    expect(searchResultText("glob", "a.ts\nb.ts", null)).toBe("a.ts\nb.ts")
  })
})

describe("summarizeSearchResult", () => {
  it("counts matched lines and the files they are in", () => {
    expect(
      summarizeSearchResult("src/a.ts:4:x\nsrc/a.ts:9:y\nsrc/b.ts:1:z")
    ).toEqual({ kind: "matches", matches: 3, files: 2 })
  })

  it("counts files, ignoring Claude Code's Found preamble", () => {
    expect(
      summarizeSearchResult("Found 2 files\n/repo/a.ts\n/repo/b.ts")
    ).toEqual({ kind: "files", files: 2 })
  })

  it("reports no matches for empty output and Claude Code's empty notices", () => {
    expect(summarizeSearchResult("")).toEqual({ kind: "none" })
    expect(summarizeSearchResult("No files found")).toEqual({ kind: "none" })
    expect(summarizeSearchResult("No matches found")).toEqual({
      kind: "none",
    })
  })

  it("falls back to result lines for output in neither shape", () => {
    expect(summarizeSearchResult("3\n4")).toEqual({ kind: "lines", lines: 2 })
  })

  it("is null when there is no result yet", () => {
    expect(summarizeSearchResult(null)).toBeNull()
  })
})

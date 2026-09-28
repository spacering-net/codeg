import { describe, expect, it } from "vitest"

import {
  isCodexGrepNoMatchEnvelope,
  parseCodexCommandEnvelope,
  parseCodexListFilesTitle,
  parseCodexSearchTitle,
} from "./codex-command-action"

describe("parseCodexSearchTitle", () => {
  it("parses a query scoped to a path (path is unquoted)", () => {
    expect(
      parseCodexSearchTitle("Search for 'Tests run:' in com.forwayaudio.app")
    ).toEqual({ query: "Tests run:", path: "com.forwayaudio.app" })
  })

  it("parses a query with no path", () => {
    expect(parseCodexSearchTitle("Search for 'TODO'")).toEqual({
      query: "TODO",
      path: null,
    })
  })

  it("keeps an apostrophe inside the query", () => {
    expect(parseCodexSearchTitle('Search for "don\'t stop"')).toBeNull()
    expect(parseCodexSearchTitle("Search for 'don't stop'")).toEqual({
      query: "don't stop",
      path: null,
    })
  })

  it('splits on the LAST separator so a query containing "\' in " survives', () => {
    expect(parseCodexSearchTitle("Search for 'a' in b' in src/lib")).toEqual({
      query: "a' in b",
      path: "src/lib",
    })
  })

  it("keeps an unquoted ' in ' inside the query when there is no path", () => {
    expect(parseCodexSearchTitle("Search for 'x in y'")).toEqual({
      query: "x in y",
      path: null,
    })
  })

  it("parses a path-only search", () => {
    expect(parseCodexSearchTitle("Search in 'src/lib'")).toEqual({
      query: null,
      path: "src/lib",
    })
  })

  it("parses the bare title as a successful, field-less match", () => {
    expect(parseCodexSearchTitle("Search")).toEqual({
      query: null,
      path: null,
    })
  })

  it("rejects titles that are not codex search actions", () => {
    expect(parseCodexSearchTitle("Read file 'src/lib/a.ts'")).toBeNull()
    expect(parseCodexSearchTitle("List files in 'src'")).toBeNull()
    expect(parseCodexSearchTitle("Searching for stuff")).toBeNull()
    expect(parseCodexSearchTitle("Search for ''")).toBeNull()
    expect(parseCodexSearchTitle("")).toBeNull()
    expect(parseCodexSearchTitle(null)).toBeNull()
    expect(parseCodexSearchTitle(undefined)).toBeNull()
  })
})

describe("parseCodexListFilesTitle", () => {
  it("parses a path-scoped listing", () => {
    expect(parseCodexListFilesTitle("List files in 'src/components'")).toEqual({
      path: "src/components",
    })
  })

  it("parses the bare title", () => {
    expect(parseCodexListFilesTitle("List files")).toEqual({ path: null })
  })

  it("rejects other titles", () => {
    expect(parseCodexListFilesTitle("Search for 'x'")).toBeNull()
    expect(parseCodexListFilesTitle("List files in ''")).toBeNull()
    expect(parseCodexListFilesTitle("Listing files")).toBeNull()
    expect(parseCodexListFilesTitle(null)).toBeNull()
  })
})

describe("parseCodexCommandEnvelope", () => {
  it("unwraps the codex command-execution envelope", () => {
    expect(
      parseCodexCommandEnvelope(
        JSON.stringify({ exit_code: 0, formatted_output: "a.ts:1:hit" })
      )
    ).toEqual({ output: "a.ts:1:hit", exitCode: 0 })
  })

  it("keeps an empty output (a search with no matches)", () => {
    expect(
      parseCodexCommandEnvelope(
        JSON.stringify({ exit_code: 1, formatted_output: "" })
      )
    ).toEqual({ output: "", exitCode: 1 })
  })

  it("requires BOTH exit_code:number and formatted_output:string", () => {
    expect(
      parseCodexCommandEnvelope(JSON.stringify({ exit_code: 0 }))
    ).toBeNull()
    expect(
      parseCodexCommandEnvelope(JSON.stringify({ formatted_output: "x" }))
    ).toBeNull()
    expect(
      parseCodexCommandEnvelope(
        JSON.stringify({ exit_code: "0", formatted_output: "x" })
      )
    ).toBeNull()
  })

  it("rejects non-object and non-JSON payloads", () => {
    expect(parseCodexCommandEnvelope("not json")).toBeNull()
    expect(parseCodexCommandEnvelope("[1,2]")).toBeNull()
    expect(parseCodexCommandEnvelope('"a string"')).toBeNull()
  })
})

describe("isCodexGrepNoMatchEnvelope", () => {
  it("accepts exit 1 with empty or whitespace-only output", () => {
    for (const formatted_output of ["", "\n", "\r\n", "   "]) {
      expect(
        isCodexGrepNoMatchEnvelope(
          JSON.stringify({ exit_code: 1, formatted_output })
        )
      ).toBe(true)
    }
  })

  it("rejects a real failure: any diagnostic text, or exit >= 2", () => {
    expect(
      isCodexGrepNoMatchEnvelope(
        JSON.stringify({
          exit_code: 1,
          formatted_output: "rg: unclosed group",
        })
      )
    ).toBe(false)
    expect(
      isCodexGrepNoMatchEnvelope(
        JSON.stringify({ exit_code: 2, formatted_output: "" })
      )
    ).toBe(false)
  })

  it("rejects a successful search and anything that is not the envelope", () => {
    expect(
      isCodexGrepNoMatchEnvelope(
        JSON.stringify({ exit_code: 0, formatted_output: "a.ts:1:hit" })
      )
    ).toBe(false)
    expect(isCodexGrepNoMatchEnvelope("")).toBe(false)
    expect(isCodexGrepNoMatchEnvelope("rg: no such file")).toBe(false)
    expect(isCodexGrepNoMatchEnvelope(JSON.stringify({ exit_code: 1 }))).toBe(
      false
    )
  })
})

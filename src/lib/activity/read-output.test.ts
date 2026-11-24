import { describe, expect, it } from "vitest"

import { codexCommandReadOutput, parseReadOutput } from "./explore"

describe("parseReadOutput", () => {
  it("keeps the structured Claude read shape { start_line, content }", () => {
    const raw = JSON.stringify({ start_line: 12, content: "line a\nline b" })
    expect(parseReadOutput(raw)).toEqual({
      startLine: 12,
      content: "line a\nline b",
    })
  })

  it("returns plain non-JSON text verbatim", () => {
    expect(parseReadOutput("just some text")).toEqual({
      startLine: 1,
      content: "just some text",
    })
  })

  it("unwraps a clean codex { formatted_output, exit_code } envelope", () => {
    // codex read commandAction output where formatted_output is already clean.
    const raw = JSON.stringify({
      formatted_output: "---\nname: using-superpowers\n---",
      exit_code: 0,
    })
    expect(parseReadOutput(raw)).toEqual({
      startLine: 1,
      content: "---\nname: using-superpowers\n---",
    })
  })

  it("strips codex CLI framing (Chunk ID / Wall time / Output:) from formatted_output", () => {
    const framed =
      "Chunk ID: 60dc01\n" +
      "Wall time: 0.0000 seconds\n" +
      "Process exited with code 0\n" +
      "Original token count: 1475\n" +
      "Output:\n" +
      "---\nname: using-superpowers\n---"
    const raw = JSON.stringify({ formatted_output: framed, exit_code: 0 })
    expect(parseReadOutput(raw)).toEqual({
      startLine: 1,
      content: "---\nname: using-superpowers\n---",
    })
  })

  // ── regression guards (Codex review) ──────────────────────────────────

  it("does NOT unwrap a JSON file whose content is an object with an output-like key", () => {
    // A genuine read of a JSON file. Without the strict { formatted_output +
    // exit_code } gate these would render only the inner value, losing the file.
    for (const obj of [
      { output: "x" },
      { stdout: "x" },
      { text: "x" },
      { result: "x" },
      { exit_code: 0 }, // metadata-only, no formatted_output
      { formatted_output: "x" }, // formatted_output without exit_code
    ]) {
      const raw = JSON.stringify(obj)
      expect(parseReadOutput(raw)).toEqual({ startLine: 1, content: raw })
    }
  })

  it("does NOT truncate file content whose first line is literally 'Output:'", () => {
    // A real codex read envelope, but formatted_output is unframed file content
    // that happens to start with "Output:" — the envelope parser must not strip it.
    const raw = JSON.stringify({
      formatted_output: "Output:\nthe real first line\nsecond line",
      exit_code: 0,
    })
    expect(parseReadOutput(raw)).toEqual({
      startLine: 1,
      content: "Output:\nthe real first line\nsecond line",
    })
  })
})

describe("codexCommandReadOutput", () => {
  it("requires both exit_code:number and formatted_output:string", () => {
    expect(codexCommandReadOutput(JSON.stringify({ output: "x" }))).toBeNull()
    expect(codexCommandReadOutput(JSON.stringify({ exit_code: 0 }))).toBeNull()
    expect(
      codexCommandReadOutput(JSON.stringify({ formatted_output: "x" }))
    ).toBeNull()
    expect(codexCommandReadOutput("not json")).toBeNull()
    expect(
      codexCommandReadOutput(
        JSON.stringify({ formatted_output: "hello", exit_code: 0 })
      )
    ).toBe("hello")
  })
})

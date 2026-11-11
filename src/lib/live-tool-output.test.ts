import { describe, expect, it } from "vitest"
import {
  appendLiveToolRawOutput,
  MAX_LIVE_TOOL_RAW_OUTPUT_CHARS as LIMIT,
  replaceLiveToolRawOutput,
} from "./live-tool-output"

describe("live tool raw output retention", () => {
  it("keeps the newest text of an oversized opening/replacement frame", () => {
    const output = replaceLiveToolRawOutput("old".repeat(LIMIT) + "\nDONE")
    expect(output.raw_output_chunks.join("")).toHaveLength(LIMIT)
    expect(output.raw_output_chunks.join("")).toMatch(/\nDONE$/)
    expect(output.raw_output_total_bytes).toBe(LIMIT)
  })

  it("bounds a single oversized append, without needing another chunk to evict", () => {
    const output = appendLiveToolRawOutput(
      replaceLiveToolRawOutput(null),
      "x".repeat(LIMIT + 500)
    )
    expect(output.raw_output_total_bytes).toBe(LIMIT)
    expect(output.raw_output_chunks.join("")).toBe("x".repeat(LIMIT))
  })

  it("uses the remaining tail budget across chunk boundaries", () => {
    const previous = replaceLiveToolRawOutput("a".repeat(LIMIT - 3))
    const output = appendLiveToolRawOutput(previous, "0123456789")
    expect(output.raw_output_total_bytes).toBe(LIMIT)
    expect(output.raw_output_chunks.join("")).toBe(
      "a".repeat(LIMIT - 10) + "0123456789"
    )
    expect(previous.raw_output_chunks).toEqual(["a".repeat(LIMIT - 3)])
  })

  it("retains an exact-budget result unchanged", () => {
    const text = "x".repeat(LIMIT)
    expect(replaceLiveToolRawOutput(text).raw_output_chunks).toEqual([text])
  })

  it("does not start the retained text in the middle of an emoji", () => {
    const output = replaceLiveToolRawOutput(
      "discard" + "😀" + "x".repeat(LIMIT - 1)
    )
    expect(output.raw_output_chunks.join("")).toBe("x".repeat(LIMIT - 1))
    expect(output.raw_output_total_bytes).toBe(LIMIT - 1)
  })

  it("preserves null versus empty output precedence", () => {
    const absent = replaceLiveToolRawOutput(null)
    expect(absent.raw_output_chunks).toEqual([])
    const empty = appendLiveToolRawOutput(absent, "")
    expect(empty.raw_output_chunks).toEqual([""])
    expect(appendLiveToolRawOutput(empty, "").raw_output_chunks).toBe(
      empty.raw_output_chunks
    )
    const populated = replaceLiveToolRawOutput("result")
    expect(appendLiveToolRawOutput(populated, null).raw_output_chunks).toBe(
      populated.raw_output_chunks
    )
  })

  it("does not accumulate thousands of empty append chunks", () => {
    let output = replaceLiveToolRawOutput("")
    for (let i = 0; i < 2_000; i += 1) {
      output = appendLiveToolRawOutput(output, "")
    }
    expect(output.raw_output_chunks).toEqual([""])
    expect(output.raw_output_total_bytes).toBe(0)
  })

  it("compacts many tiny chunks while preserving their exact content", () => {
    let output = replaceLiveToolRawOutput(null)
    for (let i = 0; i < 1_000; i += 1) {
      output = appendLiveToolRawOutput(output, String(i % 10))
    }
    expect(output.raw_output_chunks.length).toBeLessThanOrEqual(128)
    expect(output.raw_output_chunks.join("")).toBe("0123456789".repeat(100))
    expect(output.raw_output_total_bytes).toBe(1_000)
  })

  it.each(["{", "["])(
    "preserves a structured result beginning with %s",
    (open) => {
      const value =
        open === "{"
          ? { text: "x".repeat(LIMIT + 100), status: "completed" }
          : [{ text: "x".repeat(LIMIT + 100), status: "completed" }]
      const raw = " \n" + JSON.stringify(value)
      const output = replaceLiveToolRawOutput(raw)
      expect(output.raw_output_chunks.join("")).toBe(raw)
      expect(JSON.parse(output.raw_output_chunks.join(""))).toEqual(value)
    }
  )

  it.each([
    "[+] Building 12.3s (4/9)\n",
    "[1/200] Compiling foo.o\n",
    "[INFO] starting server\n",
    "[2026-11-12 10:00:00] request\n",
    "{{ template }} rendered\n",
    '["a"] then text\n',
  ])("bounds a plain-text stream that opens with a bracket: %j", (head) => {
    let output = replaceLiveToolRawOutput(head)
    for (let i = 0; i < 150; i += 1) {
      output = appendLiveToolRawOutput(output, "log line\n".repeat(200))
    }
    expect(output.raw_output_total_bytes).toBe(LIMIT)
    expect(output.raw_output_chunks.join("")).toHaveLength(LIMIT)
    expect(
      replaceLiveToolRawOutput(head + "x".repeat(LIMIT)).raw_output_total_bytes
    ).toBe(LIMIT)
  })

  it("judges the head across chunk boundaries", () => {
    let plain = replaceLiveToolRawOutput("  [")
    plain = appendLiveToolRawOutput(plain, "+] Building\n")
    plain = appendLiveToolRawOutput(plain, "x".repeat(LIMIT))
    expect(plain.raw_output_total_bytes).toBe(LIMIT)

    let json = replaceLiveToolRawOutput("[\n  {")
    json = appendLiveToolRawOutput(json, '\n    "text": -1.5e3, "ok": tr')
    json = appendLiveToolRawOutput(json, 'ue, "body": "' + "x".repeat(LIMIT))
    json = appendLiveToolRawOutput(json, '" }\n]')
    expect(JSON.parse(json.raw_output_chunks.join(""))[0].body).toHaveLength(
      LIMIT
    )
  })

  it("keeps the newest text while a stream stays at the budget", () => {
    let output = replaceLiveToolRawOutput(null)
    let expected = ""
    for (let i = 0; i < 400; i += 1) {
      const line = `line ${i}\n`.repeat(100)
      output = appendLiveToolRawOutput(output, line)
      expected = (expected + line).slice(-LIMIT)
    }
    expect(output.raw_output_chunks.join("")).toBe(expected)
    expect(output.raw_output_total_bytes).toBe(expected.length)
  })

  it("preserves a structured result arriving across partial append frames", () => {
    let output = replaceLiveToolRawOutput(' \n{"tasks":[{"message":"')
    for (let i = 0; i < 150; i += 1) {
      output = appendLiveToolRawOutput(output, "x".repeat(2_000))
    }
    output = appendLiveToolRawOutput(output, '","status":"completed"}]}')
    const parsed = JSON.parse(output.raw_output_chunks.join(""))
    expect(parsed.tasks[0].message).toHaveLength(300_000)
    expect(parsed.tasks[0].status).toBe("completed")
    expect(output.raw_output_total_bytes).toBe(
      output.raw_output_chunks.join("").length
    )
    expect(output.raw_output_chunks.length).toBeLessThanOrEqual(128)
  })
})

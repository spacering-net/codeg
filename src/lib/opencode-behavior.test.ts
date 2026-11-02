import { describe, expect, it } from "vitest"

import { parseJsoncObject } from "./jsonc-edit"
import {
  parseOpenCodeNumberInput,
  readOpenCodeBehavior,
  removeIgnoredLegacyKeys,
  setOpenCodeDefaultAgent,
  setOpenCodeNumber,
  setOpenCodeToggle,
  setOpenCodeUpdate,
} from "./opencode-behavior"

const parse = (text: string) => parseJsoncObject(text).value

describe("readOpenCodeBehavior", () => {
  it("reads every OpenCode 2 field out of a full document", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        default_agent: "plan",
        update: "notify",
        snapshots: false,
        compaction: { auto: false, keep: { tokens: 20000 }, buffer: 10000 },
        tool_output: { max_lines: 500, max_bytes: 1024 },
        experimental: {
          todo: true,
          background_compaction: true,
          subagent_depth: 2,
        },
      })
    )
    expect(view).toEqual({
      defaultAgent: "plan",
      update: "notify",
      invalid: false,
      ignoredLegacyKeys: [],
      toggles: {
        snapshots: false,
        "compaction.auto": false,
        "experimental.todo": true,
        "experimental.background_compaction": true,
      },
      numbers: {
        "experimental.subagent_depth": 2,
        "compaction.keep.tokens": 20000,
        "compaction.buffer": 10000,
        "tool_output.max_lines": 500,
        "tool_output.max_bytes": 1024,
      },
    })
  })

  it("falls back to the 1.x spellings OpenCode 2 still loads", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        autoupdate: false,
        snapshot: false,
        compaction: { preserve_recent_tokens: 9000, reserved: 7000 },
      })
    )
    expect(view.update).toBe("disable")
    expect(view.toggles.snapshots).toBe(false)
    expect(view.numbers["compaction.keep.tokens"]).toBe(9000)
    expect(view.numbers["compaction.buffer"]).toBe(7000)

    // The 2.x key wins where both are set, as in OpenCode's normalizer.
    const both = readOpenCodeBehavior(
      JSON.stringify({
        autoupdate: true,
        update: "disable",
        snapshot: true,
        snapshots: false,
      })
    )
    expect(both.update).toBe("disable")
    expect(both.toggles.snapshots).toBe(false)
  })

  it("lists the 1.x keys OpenCode 2 does not act on", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        share: "auto",
        subagent_depth: 3,
        compaction: { prune: true, tail_turns: 4 },
      })
    )
    expect(view.ignoredLegacyKeys).toEqual([
      "subagent_depth",
      "compaction.tail_turns",
      "compaction.prune",
      "share",
    ])
    // A top-level subagent_depth is dropped, not read as the depth.
    expect(view.numbers["experimental.subagent_depth"]).toBeNull()
  })

  it("reports every field unset for an empty document and locks on bad text", () => {
    const empty = readOpenCodeBehavior("")
    expect(empty.invalid).toBe(false)
    expect(empty.update).toBeNull()
    expect(Object.values(empty.toggles).every((v) => v === null)).toBe(true)
    expect(readOpenCodeBehavior("{ nope").invalid).toBe(true)
  })

  it("reads a document with comments", () => {
    const view = readOpenCodeBehavior(
      '{\n  // keep\n  "experimental": { "todo": true, },\n}\n'
    )
    expect(view.toggles["experimental.todo"]).toBe(true)
  })

  it("reads a compaction buffer given as a share of the window", () => {
    const buffer = (compaction: object) =>
      readOpenCodeBehavior(JSON.stringify({ compaction })).numbers[
        "compaction.buffer"
      ]
    expect(buffer({ buffer: "20%" })).toBe("20%")
    expect(buffer({ buffer: "12.5%" })).toBe("12.5%")
    expect(buffer({ buffer: "1%" })).toBe("1%")
    expect(buffer({ buffer: "99.9%" })).toBe("99.9%")
    // 1.x's key takes the same values (`normalize.ts` decodes it with the
    // 2.x field's schema).
    expect(buffer({ reserved: "30%" })).toBe("30%")
    // What OpenCode rejects reads as unset, as any malformed value does.
    for (const rejected of [
      "100%",
      "0%",
      "0.5%",
      "05%",
      "20 %",
      "20",
      "%",
      "x%",
    ]) {
      expect(buffer({ buffer: rejected }), rejected).toBeNull()
    }
    // Only the buffer takes a share.
    expect(
      readOpenCodeBehavior(
        JSON.stringify({ compaction: { keep: { tokens: "20%" } } })
      ).numbers["compaction.keep.tokens"]
    ).toBeNull()
  })
})

describe("parseOpenCodeNumberInput", () => {
  it("reads integers, shares for the buffer, and nothing else", () => {
    expect(parseOpenCodeNumberInput("compaction.buffer", "")).toBeNull()
    expect(parseOpenCodeNumberInput("compaction.buffer", "  ")).toBeNull()
    expect(parseOpenCodeNumberInput("compaction.buffer", "20000")).toBe(20000)
    expect(parseOpenCodeNumberInput("compaction.buffer", " 20% ")).toBe("20%")
    expect(parseOpenCodeNumberInput("compaction.buffer", "12.5%")).toBe("12.5%")
    // A trailing dot still spells the integer, as `Number` reads it.
    expect(parseOpenCodeNumberInput("compaction.buffer", "12.")).toBe(12)
    // On the way to a value: spells none yet.
    for (const partial of ["12.5", "100%", "-", "1e", "%"]) {
      expect(
        parseOpenCodeNumberInput("compaction.buffer", partial),
        partial
      ).toBeUndefined()
    }
    expect(
      parseOpenCodeNumberInput("compaction.keep.tokens", "20%")
    ).toBeUndefined()
    expect(parseOpenCodeNumberInput("tool_output.max_lines", "-3")).toBe(-3)
  })
})

describe("writers", () => {
  it("writes update and drops 1.x's autoupdate", () => {
    const out = setOpenCodeUpdate('{"autoupdate": true}', "notify")
    expect(parse(out)).toEqual({ update: "notify" })
    expect(parse(setOpenCodeUpdate(out, null))).toEqual({})
  })

  it("writes toggles at their 2.x path, removing the 1.x spelling", () => {
    const out = setOpenCodeToggle('{"snapshot": true}', "snapshots", false)
    expect(parse(out)).toEqual({ snapshots: false })
    const todo = setOpenCodeToggle(out, "experimental.todo", true)
    expect(parse(todo)).toEqual({
      snapshots: false,
      experimental: { todo: true },
    })
    // Unsetting prunes the emptied parent.
    expect(parse(setOpenCodeToggle(todo, "experimental.todo", null))).toEqual({
      snapshots: false,
    })
  })

  it("writes numbers at their 2.x path and validates the floor", () => {
    const start = JSON.stringify({
      subagent_depth: 4,
      compaction: { auto: true, preserve_recent_tokens: 1, reserved: 2 },
    })
    const depth = setOpenCodeNumber(start, "experimental.subagent_depth", 2)
    // Setting the 2.x key removes the ignored top-level one.
    expect(parse(depth)).toEqual({
      compaction: { auto: true, preserve_recent_tokens: 1, reserved: 2 },
      experimental: { subagent_depth: 2 },
    })
    const keep = setOpenCodeNumber(depth, "compaction.keep.tokens", 5000)
    expect(parse(keep)).toMatchObject({
      compaction: { auto: true, reserved: 2, keep: { tokens: 5000 } },
    })
    const buffer = setOpenCodeNumber(keep, "compaction.buffer", null)
    expect(parse(buffer)).toEqual({
      compaction: { auto: true, keep: { tokens: 5000 } },
      experimental: { subagent_depth: 2 },
    })
    // Below the floor, or not an integer: untouched.
    expect(setOpenCodeNumber(buffer, "tool_output.max_lines", 0)).toBe(buffer)
    expect(setOpenCodeNumber(buffer, "compaction.buffer", 1.5)).toBe(buffer)
  })

  it("writes a share of the window for the buffer only", () => {
    const start = JSON.stringify({ compaction: { auto: true, reserved: 2 } })
    const share = setOpenCodeNumber(start, "compaction.buffer", "20%")
    // Written at the 2.x path, replacing the 1.x spelling.
    expect(parse(share)).toEqual({ compaction: { auto: true, buffer: "20%" } })
    expect(readOpenCodeBehavior(share).numbers["compaction.buffer"]).toBe("20%")
    // A token count replaces it, and an emptied field unsets it.
    const tokens = setOpenCodeNumber(share, "compaction.buffer", 20000)
    expect(parse(tokens)).toEqual({ compaction: { auto: true, buffer: 20000 } })
    expect(parse(setOpenCodeNumber(share, "compaction.buffer", null))).toEqual({
      compaction: { auto: true },
    })
    // A share OpenCode rejects, or one for a field that takes none: untouched.
    expect(setOpenCodeNumber(share, "compaction.buffer", "100%")).toBe(share)
    expect(setOpenCodeNumber(share, "compaction.buffer", "20")).toBe(share)
    expect(setOpenCodeNumber(share, "compaction.keep.tokens", "20%")).toBe(
      share
    )
  })

  it("leaves a share alone when another field is written", () => {
    const text = '{\n  // free room\n  "compaction": { "buffer": "20%" },\n}\n'
    const out = setOpenCodeNumber(text, "compaction.keep.tokens", 5000)
    expect(out).toContain("// free room")
    expect(parse(out)).toEqual({
      compaction: { buffer: "20%", keep: { tokens: 5000 } },
    })
  })

  it("keeps comments and leaves unparsable text alone", () => {
    const text = '{\n  // my agent\n  "default_agent": "build",\n}\n'
    const out = setOpenCodeDefaultAgent(text, "plan")
    expect(out).toContain("// my agent")
    expect(parse(out)).toEqual({ default_agent: "plan" })
    expect(setOpenCodeDefaultAgent("{ nope", "plan")).toBe("{ nope")
  })

  it("removes the ignored 1.x keys on request", () => {
    const out = removeIgnoredLegacyKeys(
      JSON.stringify({
        share: "auto",
        subagent_depth: 3,
        compaction: { prune: true, tail_turns: 4, auto: false },
        model: "a/b",
      })
    )
    expect(parse(out)).toEqual({ compaction: { auto: false }, model: "a/b" })
  })
})

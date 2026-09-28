import { describe, expect, it } from "vitest"

import {
  readOpenCodeBehavior,
  setOpenCodeAutoUpdate,
  setOpenCodeDefaultAgent,
  setOpenCodeNumber,
  setOpenCodeShare,
  setOpenCodeToggle,
} from "./opencode-behavior"

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>

describe("readOpenCodeBehavior", () => {
  it("reads every field out of a full document", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        default_agent: "plan",
        share: "disabled",
        autoupdate: "notify",
        snapshot: false,
        subagent_depth: 2,
        compaction: {
          auto: false,
          prune: true,
          tail_turns: 4,
          preserve_recent_tokens: 20000,
          reserved: 10000,
        },
        tool_output: { max_lines: 500, max_bytes: 1024 },
      })
    )
    expect(view).toEqual({
      defaultAgent: "plan",
      share: "disabled",
      autoupdate: "notify",
      invalid: false,
      toggles: {
        snapshot: false,
        "compaction.auto": false,
        "compaction.prune": true,
      },
      numbers: {
        subagent_depth: 2,
        "compaction.tail_turns": 4,
        "compaction.preserve_recent_tokens": 20000,
        "compaction.reserved": 10000,
        "tool_output.max_lines": 500,
        "tool_output.max_bytes": 1024,
      },
    })
  })

  it("reports every field unset for an empty document", () => {
    const view = readOpenCodeBehavior("")
    expect(view.invalid).toBe(false)
    expect(view.defaultAgent).toBe("")
    expect(view.share).toBeNull()
    expect(view.autoupdate).toBeNull()
    expect(view.toggles["compaction.auto"]).toBeNull()
    expect(view.numbers["tool_output.max_lines"]).toBeNull()
  })

  it("maps autoupdate's boolean/'notify' union onto three selectable modes", () => {
    expect(readOpenCodeBehavior('{"autoupdate":true}').autoupdate).toBe("on")
    expect(readOpenCodeBehavior('{"autoupdate":false}').autoupdate).toBe("off")
    expect(readOpenCodeBehavior('{"autoupdate":"notify"}').autoupdate).toBe(
      "notify"
    )
    // A value outside the union reads as unset rather than as a wrong mode.
    expect(
      readOpenCodeBehavior('{"autoupdate":"weekly"}').autoupdate
    ).toBeNull()
  })

  it("locks itself on an unparsable document", () => {
    const view = readOpenCodeBehavior("{ not json")
    expect(view.invalid).toBe(true)
    expect(view.share).toBeNull()
  })
})

describe("writers", () => {
  it("leaves unrelated keys untouched", () => {
    const before = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-opus-5",
      permission: { "*": "allow" },
    })
    const after = parse(setOpenCodeShare(before, "auto"))
    expect(after.$schema).toBe("https://opencode.ai/config.json")
    expect(after.model).toBe("anthropic/claude-opus-5")
    expect(after.permission).toEqual({ "*": "allow" })
    expect(after.share).toBe("auto")
  })

  it("deletes rather than pins when a control returns to unset", () => {
    // "Not configured" and "configured to today's default" are different
    // documents — only the first keeps following OpenCode when it moves.
    const withShare = setOpenCodeShare("{}", "manual")
    expect(parse(withShare).share).toBe("manual")
    expect(setOpenCodeShare(withShare, null)).toBe("")

    const withAgent = setOpenCodeDefaultAgent("{}", "plan")
    expect(parse(withAgent).default_agent).toBe("plan")
    // A whitespace-only name is the same as clearing the box.
    expect(setOpenCodeDefaultAgent(withAgent, "   ")).toBe("")

    const withUpdate = setOpenCodeAutoUpdate("{}", "off")
    expect(parse(withUpdate).autoupdate).toBe(false)
    expect(setOpenCodeAutoUpdate(withUpdate, null)).toBe("")
  })

  it("prunes a nested parent that its last leaf left empty", () => {
    const withTwo = setOpenCodeNumber(
      setOpenCodeToggle("{}", "compaction.auto", false),
      "compaction.reserved",
      10000
    )
    expect(parse(withTwo).compaction).toEqual({ auto: false, reserved: 10000 })

    const withOne = setOpenCodeNumber(withTwo, "compaction.reserved", null)
    expect(parse(withOne).compaction).toEqual({ auto: false })

    // …and the object itself goes when nothing is left in it, rather than
    // leaving `"compaction": {}` behind.
    expect(setOpenCodeToggle(withOne, "compaction.auto", null)).toBe("")
  })

  it("refuses a numeric value the published schema would reject", () => {
    // `tool_output.max_lines` is a PositiveInt; `subagent_depth` a
    // NonNegativeInt. Writing an out-of-range value would produce config that
    // fails OpenCode's own `$schema`.
    const base = '{"tool_output":{"max_lines":500}}'
    expect(setOpenCodeNumber(base, "tool_output.max_lines", 0)).toBe(base)
    expect(setOpenCodeNumber(base, "tool_output.max_lines", -1)).toBe(base)
    expect(setOpenCodeNumber(base, "tool_output.max_lines", 1.5)).toBe(base)
    expect(
      parse(setOpenCodeNumber(base, "tool_output.max_lines", 1))["tool_output"]
    ).toEqual({ max_lines: 1 })
    // Zero IS meaningful here: sub-agents may launch nothing.
    expect(
      parse(setOpenCodeNumber("{}", "subagent_depth", 0)).subagent_depth
    ).toBe(0)
  })

  it("returns an unparsable document unchanged", () => {
    const broken = "{ not json"
    expect(setOpenCodeShare(broken, "auto")).toBe(broken)
    expect(setOpenCodeToggle(broken, "snapshot", false)).toBe(broken)
    expect(setOpenCodeNumber(broken, "compaction.reserved", 1)).toBe(broken)
    expect(setOpenCodeDefaultAgent(broken, "plan")).toBe(broken)
    expect(setOpenCodeAutoUpdate(broken, "on")).toBe(broken)
  })

  it("round-trips everything the reader reports", () => {
    let text = "{}"
    text = setOpenCodeDefaultAgent(text, "plan")
    text = setOpenCodeShare(text, "auto")
    text = setOpenCodeAutoUpdate(text, "notify")
    text = setOpenCodeToggle(text, "snapshot", false)
    text = setOpenCodeToggle(text, "compaction.auto", false)
    text = setOpenCodeToggle(text, "compaction.prune", true)
    text = setOpenCodeNumber(text, "subagent_depth", 2)
    text = setOpenCodeNumber(text, "compaction.tail_turns", 4)
    text = setOpenCodeNumber(text, "tool_output.max_bytes", 2048)

    const view = readOpenCodeBehavior(text)
    expect(view.defaultAgent).toBe("plan")
    expect(view.share).toBe("auto")
    expect(view.autoupdate).toBe("notify")
    expect(view.toggles).toEqual({
      snapshot: false,
      "compaction.auto": false,
      "compaction.prune": true,
    })
    expect(view.numbers["subagent_depth"]).toBe(2)
    expect(view.numbers["compaction.tail_turns"]).toBe(4)
    expect(view.numbers["tool_output.max_bytes"]).toBe(2048)
  })
})

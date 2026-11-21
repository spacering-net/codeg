import { describe, expect, it } from "vitest"

import {
  accessOf,
  assistantColor,
  definitionFile,
  groupTools,
  repeatedHeadings,
  settingEntries,
  startersOf,
  toolGroup,
  toolName,
} from "./assistant"
import { normalizeItemDetail } from "./normalize"
import { DEFINITION_HASH, rawAssistantDetail } from "./test-fixtures"

describe("an assistant's tools", () => {
  it("are named without the pattern a tool can carry", () => {
    expect(toolName("Bash(git diff:*)")).toBe("Bash")
    expect(toolName("  Read ")).toBe("Read")
  })

  it("fall into the four groups the website shows, old names included", () => {
    expect(toolGroup("Grep")).toBe("read")
    expect(toolGroup("LS")).toBe("read")
    expect(toolGroup("MultiEdit")).toBe("edit")
    expect(toolGroup("Bash(npm test)")).toBe("run")
    expect(toolGroup("WebSearch")).toBe("web")
    expect(toolGroup("mcp__github__create_issue")).toBeNull()
    expect(toolGroup("TodoWrite")).toBeNull()
  })

  it("are grouped in the order the definition lists them", () => {
    expect(
      groupTools(["Edit", "Read", "mcp__x__*", "Glob", "WebFetch", "Agent"])
    ).toEqual({
      read: ["Read", "Glob"],
      edit: ["Edit"],
      run: [],
      web: ["WebFetch"],
      other: ["mcp__x__*", "Agent"],
    })
  })
})

describe("what an assistant may touch, worked out from its tools", () => {
  it("is everything when its tools are not limited", () => {
    expect(accessOf(null, [])).toEqual({
      read: true,
      edit: true,
      run: true,
      web: true,
      all: true,
    })
  })

  it("loses what it is denied, but not for a pattern that denies part of a tool", () => {
    expect(accessOf(null, ["WebFetch", "WebSearch", "Bash(rm:*)"])).toEqual({
      read: true,
      edit: true,
      run: true,
      web: false,
      all: false,
    })
  })

  it("is what its listed tools allow", () => {
    expect(accessOf(["Read", "Bash(git log:*)"], ["Bash"])).toEqual({
      read: true,
      edit: false,
      run: false,
      web: false,
      all: false,
    })
  })
})

describe("an assistant's colour", () => {
  it("is one of Claude Code's eight, or none", () => {
    expect(assistantColor("cyan")).toBe("cyan")
    expect(assistantColor("teal")).toBeNull()
    expect(assistantColor("#ff0000")).toBeNull()
    expect(assistantColor(null)).toBeNull()
  })
})

describe("an assistant's other settings", () => {
  it("are listed as written, JSON where they are not text", () => {
    expect(
      settingEntries({
        effort: "high",
        maxTurns: 15,
        memory: { scope: "project" },
        background: true,
      })
    ).toEqual([
      { key: "effort", value: "high" },
      { key: "maxTurns", value: "15" },
      { key: "memory", value: '{"scope":"project"}' },
      { key: "background", value: "true" },
    ])
  })

  it("are cut where a value runs long", () => {
    const [{ value }] = settingEntries({ initialPrompt: "x".repeat(400) })
    expect(Array.from(value)).toHaveLength(161)
    expect(value.endsWith("…")).toBe(true)
  })
})

describe("the starters worth offering", () => {
  it("leave out what an example already shows the user saying", () => {
    expect(
      startersOf({
        starters: ["Review my PR", "Explain this diff", "  "],
        examples: [
          {
            context: null,
            user: "Review my PR ",
            assistant: null,
            commentary: null,
          },
        ],
      })
    ).toEqual(["Explain this diff"])
  })
})

describe("the headings that repeat the page's title", () => {
  it("include the title with an agent's word after it", () => {
    expect(
      repeatedHeadings("XR Interface Architect", "XR Interface Architect")
    ).toContain("XR Interface Architect agent personality")
  })
})

describe("the definition's file", () => {
  const item = (assistant = {}, overrides = {}) =>
    normalizeItemDetail(rawAssistantDetail(assistant, overrides))

  it("is the one the version's file list names, with its hash", () => {
    expect(definitionFile(item())).toMatchObject({
      path: "silent-failure-hunter.md",
      sha256: DEFINITION_HASH,
    })
  })

  it("is none when the file list does not name it", () => {
    expect(definitionFile(item({ file: "elsewhere.md" }))).toBeNull()
    expect(definitionFile(item({ file: "" }))).toBeNull()
  })

  it("is none when its hash is not one the command takes", () => {
    const raw = rawAssistantDetail()
    const install = raw.install as Record<string, unknown>
    install.files = [
      { path: "silent-failure-hunter.md", sha256: "ABC", size: 1 },
    ]
    expect(definitionFile(normalizeItemDetail(raw))).toBeNull()
  })

  it("is none when the license keeps Harness from handing out copies", () => {
    const raw = rawAssistantDetail()
    ;(raw.install as Record<string, unknown>).archive = null
    expect(definitionFile(normalizeItemDetail(raw))).toBeNull()
  })
})

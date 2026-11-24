import { beforeEach, describe, expect, it } from "vitest"

import { draftFromDefinition, emptyDraft } from "./draft"
import {
  editorDrift,
  editorIssues,
  editorSignature,
  effectiveTargets,
  snapshotOf,
  type McpEditorInput,
} from "./editor"
import { DEFAULT_KEY_PATTERN, keyRulesOf, newKeyProblem } from "./keys"
import { buildModel } from "./model"
import { pasteChoicesOf, pasteIssue, pasteOps, pasteTargetsFor } from "./paste"
import { defaultCreateTargets } from "./targets"
import {
  agent,
  entry,
  inventory,
  remote,
  resetFingerprints,
  stdio,
} from "./test-fixtures"

beforeEach(() => resetFingerprints())

describe("key rules", () => {
  const rules = keyRulesOf(null)

  it.each([
    ["github", null],
    ["my_server-2", null],
    ["", "empty"],
    ["codeg-mcp", "reserved"],
    ["my.server", "invalid"],
    ["has space", "invalid"],
    ["a".repeat(65), "invalid"],
  ] as const)("%j → %s", (key, problem) => {
    expect(newKeyProblem(key, rules)).toBe(problem)
  })

  it("takes the rule and the reserved names from the inventory", () => {
    const custom = keyRulesOf({
      agents: [],
      reserved_keys: ["codeg-mcp", "other"],
      key_pattern: "^[a-z]+$",
    })
    expect(newKeyProblem("Abc", custom)).toBe("invalid")
    expect(newKeyProblem("other", custom)).toBe("reserved")
    // A pattern this engine cannot compile falls back to the usual one.
    expect(
      keyRulesOf({ agents: [], reserved_keys: [], key_pattern: "([" }).pattern
        .source
    ).toBe(new RegExp(DEFAULT_KEY_PATTERN).source)
  })
})

describe("default targets", () => {
  it("for a new server: installed agents that can hold its transport, and no others", () => {
    const model = buildModel(
      inventory([
        agent("claude_code"),
        agent("codex"),
        agent("kiro", [], { installed: false }),
        agent("grok", [], { installed: null }),
        agent("open_claw"),
        agent("cline", [], { config: { status: "unreadable", basis: null } }),
      ])
    )
    expect(defaultCreateTargets(model, "stdio")).toEqual([
      "claude_code",
      "codex",
    ])
    // Codex cannot hold SSE.
    expect(defaultCreateTargets(model, "sse")).toEqual(["claude_code"])
  })
})

describe("editing one of two definitions", () => {
  const sse = remote("sse", "https://a.test/sse")
  const http = remote("http", "https://a.test/mcp")
  const model = () =>
    buildModel(
      inventory([
        agent("claude_code", [entry("linear", sse)]),
        agent("codex", [entry("linear", http)]),
        agent("gemini", [entry("linear", sse)]),
      ])
    )

  function editing(letter: "A" | "B"): McpEditorInput {
    const server = model().server("linear")!
    const group = server.groups.find((entry) => entry.letter === letter)!
    return {
      mode: "edit",
      key: "linear",
      origin: { letter, snapshot: snapshotOf(group) },
      draft: draftFromDefinition(group.definition),
      json: null,
      targets: group.holders.map((holder) => holder.info.agent!),
    }
  }

  it("goes to that definition's agents only", () => {
    expect(effectiveTargets(editing("B"), model())).toEqual(["codex"])
    expect(effectiveTargets(editing("A"), model())).toEqual([
      "claude_code",
      "gemini",
    ])
  })

  it("leaves out an agent that cannot hold the transport, even when ticked", () => {
    const input = {
      ...editing("A"),
      targets: ["claude_code", "gemini", "codex"] as McpEditorInput["targets"],
    }
    // Definition A is SSE; Codex cannot hold it.
    expect(effectiveTargets(input, model())).toEqual(["claude_code", "gemini"])
  })

  it("notices the definition changing elsewhere, and only that", () => {
    const input = editing("B")
    // Codex now has another definition.
    const changed = buildModel(
      inventory([
        agent("claude_code", [entry("linear", sse)]),
        agent("codex", [entry("linear", remote("http", "https://b.test"))]),
        agent("gemini", [entry("linear", sse)]),
      ])
    )
    expect(editorDrift(input, changed.server("linear"))).toBe("changed")
    // Codex lost it.
    const removed = buildModel(
      inventory([agent("claude_code", [entry("linear", sse)]), agent("codex")])
    )
    expect(editorDrift(input, removed.server("linear"))).toBe("removed")
    // Another server in Codex's file changed: not this editor's business.
    const other = buildModel(
      inventory([
        agent("claude_code", [entry("linear", sse)]),
        agent("codex", [entry("linear", http), entry("new-one")], {
          config: { basis: "basis-codex-2" },
        }),
        agent("gemini", [entry("linear", sse)]),
      ])
    )
    expect(editorDrift(input, other.server("linear"))).toBeNull()
  })

  it("lets an existing key that breaks the rule be edited where it is", () => {
    const odd = buildModel(
      inventory([agent("claude_code", [entry("my.server")]), agent("gemini")])
    )
    const group = odd.server("my.server")!.groups[0]
    const input: McpEditorInput = {
      mode: "edit",
      key: "my.server",
      origin: { letter: null, snapshot: snapshotOf(group) },
      draft: draftFromDefinition(stdio("node")),
      json: null,
      targets: ["claude_code", "gemini"],
    }
    expect(editorIssues(input, odd)).toEqual([])
    // …but not created where it is not.
    expect(effectiveTargets(input, odd)).toEqual(["claude_code"])
  })
})

describe("what stops a new server", () => {
  const model = buildModel(inventory([agent("claude_code")]))
  const input = (patch: Partial<McpEditorInput>): McpEditorInput => ({
    mode: "create",
    key: "",
    origin: null,
    draft: emptyDraft(),
    json: null,
    targets: ["claude_code"],
    ...patch,
  })

  it("an empty, invalid or reserved name, and an empty command", () => {
    expect(editorIssues(input({}), model).map((issue) => issue.kind)).toEqual([
      "key",
      "draft",
    ])
    expect(
      editorIssues(
        input({ key: "codeg-mcp", draft: draftFromDefinition(stdio()) }),
        model
      )
    ).toEqual([{ kind: "key", problem: "reserved" }])
  })

  it("JSON that is not a definition, which the form cannot stand in for", () => {
    const issues = editorIssues(
      input({
        key: "ok",
        draft: draftFromDefinition(stdio()),
        json: { text: "{", problem: { kind: "syntax", detail: "x" } },
      }),
      model
    )
    expect(issues).toEqual([
      { kind: "json", problem: { kind: "syntax", detail: "x" } },
    ])
  })

  it("counts text in the JSON view that is not yet a definition as a change", () => {
    const base = input({ key: "ok", draft: draftFromDefinition(stdio()) })
    expect(editorSignature(base)).not.toBe(
      editorSignature({
        ...base,
        json: { text: "{", problem: { kind: "syntax", detail: "" } },
      })
    )
  })
})

describe("paste", () => {
  const model = buildModel(
    inventory([agent("claude_code"), agent("codex"), agent("gemini")])
  )
  const snippet = {
    format: "json_servers",
    servers: [
      {
        key: "local",
        definition: stdio(),
        extra: { disabled: true },
        problems: [],
      },
      { key: "events", definition: remote("sse"), extra: {}, problems: [] },
      {
        key: "codeg-mcp",
        definition: stdio(),
        extra: {},
        problems: [{ code: "key_reserved", field: "key" }],
      },
      {
        key: "broken",
        definition: null,
        extra: {},
        problems: [{ code: "missing_command_or_url" }],
      },
    ],
    problems: [],
  }

  it("ticks what is a server, and makes a reserved name be changed first", () => {
    const choices = pasteChoicesOf(snippet)
    expect(choices.map((choice) => choice.chosen)).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(pasteIssue(snippet, choices, 2, model)).toEqual({
      kind: "key",
      problem: "reserved",
    })
  })

  it("writes each server only to the chosen agents that can hold it", () => {
    const choices = pasteChoicesOf(snippet)
    choices[2] = { name: "companion", chosen: true }
    const ops = pasteOps(snippet, choices, ["claude_code", "codex"], model)
    expect(ops.map((op) => [op.agent, op.key])).toEqual([
      ["claude_code", "local"],
      ["codex", "local"],
      // Codex cannot hold SSE.
      ["claude_code", "events"],
      ["claude_code", "companion"],
      ["codex", "companion"],
    ])
    // The pasted entry's other fields are never sent.
    expect(ops[0]).toEqual({
      agent: "claude_code",
      key: "local",
      action: "set",
      definition: stdio(),
    })
  })

  it("skips an agent whose entry of that name takes no edits, until it is renamed", () => {
    const held = buildModel(
      inventory([
        agent("claude_code"),
        agent("codex", [
          entry("local", stdio("old"), {
            read_only: true,
            problems: [{ code: "duplicate_key", field: "env.TOKEN" }],
          }),
        ]),
      ])
    )
    const choices = pasteChoicesOf(snippet).map((choice, index) => ({
      ...choice,
      chosen: index === 0,
    }))
    expect(
      pasteTargetsFor(snippet, 0, "local", ["claude_code", "codex"], held)
    ).toEqual({
      agents: ["claude_code"],
      skipped: [
        {
          agent: "codex",
          block: {
            kind: "entry",
            reason: { kind: "duplicate", field: "env.TOKEN" },
          },
        },
      ],
    })
    expect(
      pasteOps(snippet, choices, ["claude_code", "codex"], held).map(
        (op) => op.agent
      )
    ).toEqual(["claude_code"])
    choices[0] = { name: "local-2", chosen: true }
    expect(
      pasteOps(snippet, choices, ["claude_code", "codex"], held).map(
        (op) => op.agent
      )
    ).toEqual(["claude_code", "codex"])
  })
})

describe("an entry that takes no edits, among the agents of a definition", () => {
  const shared = remote("http", "https://shared.test/mcp")
  const model = buildModel(
    inventory([
      agent("claude_code", [entry("shared", shared)]),
      agent("codex", [
        entry("shared", shared, {
          read_only: true,
          problems: [{ code: "duplicate_key" }],
        }),
      ]),
      agent("gemini"),
    ])
  )

  it("is left out of an edit, even when ticked", () => {
    const group = model.server("shared")!.groups[0]
    const input: McpEditorInput = {
      mode: "edit",
      key: "shared",
      origin: { letter: null, snapshot: snapshotOf(group) },
      draft: draftFromDefinition(shared),
      json: null,
      targets: ["claude_code", "codex", "gemini"],
    }
    expect(effectiveTargets(input, model)).toEqual(["claude_code", "gemini"])
  })

  it("is left out of a new server of that name", () => {
    const input: McpEditorInput = {
      mode: "create",
      key: " shared ",
      origin: null,
      draft: draftFromDefinition(shared),
      json: null,
      targets: ["claude_code", "codex", "gemini"],
    }
    expect(effectiveTargets(input, model)).toEqual(["claude_code", "gemini"])
  })
})

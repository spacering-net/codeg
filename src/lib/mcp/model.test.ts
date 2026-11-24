import { beforeEach, describe, expect, it } from "vitest"

import {
  agentServerState,
  buildModel,
  isFolded,
  isSkippedInSessions,
  switchOf,
} from "./model"
import {
  agent,
  entry,
  inventory,
  remote,
  resetFingerprints,
  stdio,
} from "./test-fixtures"

beforeEach(() => resetFingerprints())

describe("by server — nothing merged", () => {
  it("is one row per key, the same key in two agents being one row", () => {
    const model = buildModel(
      inventory([
        agent("claude_code", [
          entry("github", stdio()),
          entry("fs", stdio("fs")),
        ]),
        agent("codex", [entry("github", stdio())]),
      ])
    )
    expect(model.servers.map((server) => server.key)).toEqual(["fs", "github"])
    const github = model.server("github")!
    expect(github.holders.map((holder) => holder.info.id)).toEqual([
      "claude_code",
      "codex",
    ])
    expect(github.groups).toHaveLength(1)
    expect(github.groups[0].holders).toHaveLength(2)
  })

  it("keeps different definitions of one key apart, most widely held first", () => {
    const sse = remote("sse", "https://a.test/sse")
    const http = remote("http", "https://a.test/mcp")
    const model = buildModel(
      inventory([
        agent("claude_code", [entry("linear", sse)]),
        agent("codex", [entry("linear", http)]),
        agent("gemini", [entry("linear", sse)]),
      ])
    )
    const linear = model.server("linear")!
    expect(linear.groups.map((group) => group.letter)).toEqual(["A", "B"])
    expect(linear.groups[0].definition).toEqual(sse)
    expect(linear.groups[0].holders.map((holder) => holder.info.id)).toEqual([
      "claude_code",
      "gemini",
    ])
    expect(linear.groups[1].holders.map((holder) => holder.info.id)).toEqual([
      "codex",
    ])
    expect(linear.transports).toEqual(["http", "sse"])
  })

  it("lists an entry it cannot describe, with its problem, apart from the definitions", () => {
    const model = buildModel(
      inventory([
        agent("claude_code", [entry("x", stdio())]),
        agent("kiro", [
          entry("x", null, {
            problems: [{ code: "missing_command_or_url" }],
          }),
        ]),
      ])
    )
    const x = model.server("x")!
    expect(x.groups).toHaveLength(1)
    expect(x.undescribed.map((holder) => holder.info.id)).toEqual(["kiro"])
    expect(x.hasProblems).toBe(true)
  })

  it("does not call an entry in an older place of its file a problem", () => {
    const model = buildModel(
      inventory([
        agent("codex", [
          entry("old", stdio(), {
            legacy: true,
            problems: [{ code: "legacy_location" }],
          }),
        ]),
      ])
    )
    expect(model.server("old")!.hasProblems).toBe(false)
  })
})

describe("one agent, one server", () => {
  const model = buildModel(
    inventory([
      agent("claude_code", [entry("github", remote("sse"))]),
      agent("codex", [entry("github", remote("http"), { enabled: false })]),
      agent("gemini"),
      agent("zcode"),
      agent("cline", [], {
        config: {
          status: "unreadable",
          basis: null,
          reason: { code: "invalid_json", detail: "line 3" },
        },
      }),
      agent("open_claw", [entry("github", remote("sse"))]),
      agent("cursor", [
        entry("github", remote("sse"), {
          read_only: true,
          problems: [{ code: "duplicate_key", field: "env.TOKEN" }],
        }),
      ]),
    ])
  )
  const github = model.server("github")!
  const state = (id: string) =>
    agentServerState(github, model.agent(id)!, model.rules)

  it("says what each agent has", () => {
    expect(state("claude_code")).toMatchObject({
      kind: "present",
      readOnly: null,
    })
    expect(state("codex")).toMatchObject({ kind: "present", readOnly: null })
    expect(state("gemini")).toMatchObject({ kind: "absent", block: null })
    expect(state("cline")).toMatchObject({ kind: "unreadable" })
  })

  it("offers an agent only the definitions it can hold", () => {
    // Gemini holds both kinds; ZCode only local servers.
    expect(state("gemini")).toMatchObject({ choices: [0, 1] })
    expect(state("zcode")).toMatchObject({
      kind: "absent",
      choices: [],
      block: { kind: "transport", transports: ["http", "sse"] },
    })
  })

  it("says why an entry takes no edits", () => {
    expect(state("open_claw")).toMatchObject({
      readOnly: {
        kind: "agent",
        block: { kind: "file", reason: { code: "managed_by_agent" } },
      },
    })
    expect(state("cursor")).toMatchObject({
      readOnly: { kind: "duplicate", field: "env.TOKEN" },
    })
  })

  it("turns off with the agent's own flag where it has one, and by removing otherwise", () => {
    // Claude Code has no off flag: off means the entry goes.
    expect(switchOf(state("claude_code"))).toEqual({
      checked: true,
      action: { kind: "removeToDisable" },
    })
    // Codex's entry is off, and comes back on by its flag.
    expect(switchOf(state("codex"))).toEqual({
      checked: false,
      action: { kind: "enable" },
    })
    expect(switchOf(state("gemini"))).toEqual({
      checked: false,
      action: { kind: "add", choices: [0, 1] },
    })
  })

  it("does not let a read-only, unreadable or unsuitable agent be switched", () => {
    for (const id of ["open_claw", "cursor", "cline", "zcode"]) {
      expect(switchOf(state(id)).action).toBeNull()
    }
  })

  it("leaves a file's other agents editable when one file is unreadable", () => {
    expect(model.agent("cline")!.editBlock).toMatchObject({
      kind: "file",
      reason: { code: "invalid_json" },
    })
    expect(model.agent("gemini")!.editBlock).toBeNull()
    expect(model.agent("claude_code")!.editBlock).toBeNull()
  })
})

describe("a key that is there twice", () => {
  it("in the container: the whole file is read-only", () => {
    const model = buildModel(
      inventory([
        agent("kimi_code", [entry("a"), entry("b")], {
          config: {
            status: "read_only",
            reason: { code: "duplicate_key", detail: "mcpServers" },
          },
        }),
      ])
    )
    const info = model.agent("kimi_code")!
    expect(info.editBlock).toMatchObject({
      kind: "file",
      reason: { code: "duplicate_key" },
    })
    for (const key of ["a", "b"]) {
      const server = model.server(key)!
      expect(
        switchOf(agentServerState(server, info, model.rules)).action
      ).toBeNull()
    }
  })

  it("in one entry: only that entry is read-only", () => {
    const model = buildModel(
      inventory([
        agent("kimi_code", [
          entry("a", stdio(), {
            read_only: true,
            problems: [{ code: "duplicate_key" }],
          }),
          entry("b"),
        ]),
      ])
    )
    const info = model.agent("kimi_code")!
    const stateOf = (key: string) =>
      agentServerState(model.server(key)!, info, model.rules)
    expect(stateOf("a")).toMatchObject({
      readOnly: { kind: "duplicate", field: null },
    })
    expect(switchOf(stateOf("a")).action).toBeNull()
    expect(stateOf("b")).toMatchObject({ readOnly: null })
    expect(switchOf(stateOf("b")).action).toEqual({ kind: "disable" })
  })

  it("in a related settings.json: no edits, but the on/off switch still works", () => {
    const model = buildModel(
      inventory([
        agent("code_buddy", [entry("a")], {
          config: {
            related: [
              {
                role: "plugin_gate",
                path: "/home/u/.codebuddy/settings.json",
                reason: { code: "duplicate_key", detail: "enabledPlugins" },
              },
            ],
          },
        }),
      ])
    )
    const info = model.agent("code_buddy")!
    expect(info.editBlock).toMatchObject({ kind: "related" })
    expect(info.toggleBlock).toBeNull()
    const state = agentServerState(model.server("a")!, info, model.rules)
    expect(switchOf(state).action).toEqual({ kind: "disable" })
  })
})

describe("keys", () => {
  it("does not offer to create an existing key that breaks the rule for new ones", () => {
    const model = buildModel(
      inventory([agent("claude_code", [entry("my.server")]), agent("gemini")])
    )
    const server = model.server("my.server")!
    expect(
      agentServerState(server, model.agent("gemini")!, model.rules)
    ).toMatchObject({ block: { kind: "key", problem: "invalid" } })
    // Where it already is, it stays editable.
    expect(
      switchOf(
        agentServerState(server, model.agent("claude_code")!, model.rules)
      ).action
    ).toEqual({ kind: "removeToDisable" })
  })

  it("never offers to create the built-in server's name", () => {
    const model = buildModel(
      inventory([
        agent("claude_code", [
          entry("codeg-mcp", stdio(), {
            reserved: true,
            read_only: true,
            problems: [{ code: "reserved_key" }],
          }),
        ]),
        agent("gemini"),
      ])
    )
    const server = model.server("codeg-mcp")!
    expect(server.reserved).toBe(true)
    expect(
      agentServerState(server, model.agent("gemini")!, model.rules)
    ).toMatchObject({ block: { kind: "key", problem: "reserved" } })
    expect(
      agentServerState(server, model.agent("claude_code")!, model.rules)
    ).toMatchObject({ readOnly: { kind: "reserved" } })
  })
})

describe("agents this build does not know", () => {
  it("lists them, and offers nothing to do to them", () => {
    const model = buildModel(
      inventory([agent("claude_code"), agent("future_agent", [entry("x")])])
    )
    const info = model.agent("future_agent")!
    expect(info.agent).toBeNull()
    expect(info.editBlock).toEqual({ kind: "unknownAgent" })
    const state = agentServerState(model.server("x")!, info, model.rules)
    expect(switchOf(state).action).toBeNull()
  })
})

describe("folding and sessions", () => {
  it("folds an agent away only when it is not installed and holds nothing", () => {
    const model = buildModel(
      inventory([
        agent("kiro", [], { installed: false }),
        agent("trae", [entry("x")], { installed: false }),
        agent("grok", [], { installed: null }),
      ])
    )
    expect(isFolded(model.agent("kiro")!)).toBe(true)
    expect(isFolded(model.agent("trae")!)).toBe(false)
    // "Could not tell" is not "not installed".
    expect(isFolded(model.agent("grok")!)).toBe(false)
  })

  it("marks the remote servers an agent's sessions leave out", () => {
    const model = buildModel(
      inventory([
        agent(
          "claude_code",
          [entry("h", remote("http")), entry("s", remote("sse")), entry("l")],
          {
            session_capabilities: {
              http: true,
              sse: false,
              recorded_at: "2026-11-15T14:21:07Z",
            },
          }
        ),
        agent("cline", [entry("s", remote("sse"))]),
      ])
    )
    const claude = model.agent("claude_code")!
    const [h, s, l] = claude.inventory.entries
    expect(isSkippedInSessions(claude, h)).toBe(false)
    expect(isSkippedInSessions(claude, s)).toBe(true)
    expect(isSkippedInSessions(claude, l)).toBe(false)
    // An agent that reads its own file is not sent anything to skip.
    const cline = model.agent("cline")!
    expect(isSkippedInSessions(cline, cline.inventory.entries[0])).toBe(false)
  })
})

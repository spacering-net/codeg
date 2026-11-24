import { describe, expect, it } from "vitest"

import {
  chooseOption,
  defaultTargetsOf,
  initialInput,
  installArgsOf,
  installBlockersOf,
  installModeOf,
  keyProblemOf,
  parameterProblemOf,
  setInstallKey,
  setValue,
  targetRowsOf,
  toggleReplace,
  toggleTarget,
  type McpInstallRestate,
} from "./mcp-install"
import {
  NEW_STATE,
  rawInstalledAgent,
  rawParameter,
  rawInstalledItem,
  rawPlan,
  rawPlanAgent,
  rawPlanAgents,
  rawSnapshot,
  rawStdioOption,
  STATE,
} from "./mcp-install-fixtures"
import { normalizeMcpPlan } from "./mcp-install-normalize"

const plan = (overrides: Record<string, unknown> = {}) =>
  normalizeMcpPlan(rawPlan(overrides))

const REF = "acme.dev/notes"

describe("the install input", () => {
  it("starts on the plan's proposal: option, defaults, name, installed agents", () => {
    const current = plan()
    const input = initialInput(current)
    expect(input.optionId).toBe("official:package:0:stdio")
    expect(input.values).toEqual({
      "env.NOTES_TOKEN": "",
      "env.NOTES_DIR": "~/notes",
    })
    expect(input.key).toBe("notes")
    expect(input.agents).toEqual(["claude_code", "codex"])
    expect(input.replace).toEqual([])
    expect(input.acceptYanked).toBe(false)
  })

  it("never proposes an option that cannot be chosen, nor any for a blocked item", () => {
    const blockedOption = plan({
      options: [
        rawStdioOption({
          selectable: true,
          blocking: [{ code: "package_missing" }],
        }),
      ],
    })
    expect(blockedOption.options[0].selectable).toBe(false)
    expect(initialInput(blockedOption).optionId).toBeNull()

    const blockedItem = plan({ blocking: [{ code: "version_blocked" }] })
    expect(initialInput(blockedItem).optionId).toBeNull()
    expect(
      installBlockersOf(blockedItem, initialInput(blockedItem), null)
    ).toEqual([{ kind: "item" }])
  })

  it("leaves out agents that cannot take the option, and keeps their values per option", () => {
    const current = plan({
      options: [
        rawStdioOption(),
        rawStdioOption({
          id: "official:remote:0:sse",
          transport: "sse",
          source: "remote",
          parameters: [],
          default_targets: ["claude_code", "codex"],
        }),
      ],
    })
    let input = initialInput(current)
    input = setValue(input, "env.NOTES_TOKEN", "t-1")
    input = chooseOption(current, input, "official:remote:0:sse")
    // Codex cannot hold SSE.
    expect(input.agents).toEqual(["claude_code"])
    expect(input.values).toEqual({})
    input = chooseOption(current, input, "official:package:0:stdio")
    // Back: what was typed for it is there again only if still held — the
    // remote had no such field, so the token is the prefill again.
    expect(input.values["env.NOTES_DIR"]).toBe("~/notes")
  })

  it("does not tick for replacement anything that is not this item's own entry", () => {
    const current = plan({
      options: [rawStdioOption({ default_replace: ["claude_code"] })],
      agents: [
        rawPlanAgent("claude_code", { keys: ["notes"] }),
        rawPlanAgent("codex"),
      ],
      key: {
        name: "notes",
        default: "notes",
        pattern: "^[A-Za-z0-9_-]{1,64}$",
        conflicts: [
          {
            key: "notes",
            agent: "claude_code",
            owner: "elsewhere",
            item_id: null,
            item_ref: null,
            state: null,
            definition: { type: "stdio", command: "notes" },
            enabled: true,
          },
        ],
      },
    })
    const input = initialInput(current)
    expect(input.replace).toEqual([])
    expect(installBlockersOf(current, input, null)).toContainEqual({
      kind: "replace",
      agents: ["claude_code"],
    })
    const confirmed = toggleReplace(
      setValue(input, "env.NOTES_TOKEN", "t"),
      "claude_code",
      true
    )
    expect(installBlockersOf(current, confirmed, null)).toEqual([])
    expect(installArgsOf(REF, current, confirmed, null)?.replace).toEqual([
      "claude_code",
    ])
  })

  it("asks again for a new name, and checks it against the rule", () => {
    const current = plan({
      agents: [rawPlanAgent("claude_code", { keys: ["other"] })],
      options: [rawStdioOption({ default_targets: ["claude_code"] })],
    })
    let input = setValue(initialInput(current), "env.NOTES_TOKEN", "t")
    expect(keyProblemOf(current, "")).toBe("empty")
    expect(keyProblemOf(current, "codeg-mcp")).toBe("reserved")
    expect(keyProblemOf(current, "has space")).toBe("invalid")
    input = setInstallKey(current, input, "other")
    expect(installBlockersOf(current, input, null)).toEqual([
      { kind: "replace", agents: ["claude_code"] },
    ])
    input = setInstallKey(current, input, "notes-2")
    expect(installBlockersOf(current, input, null)).toEqual([])
    expect(installArgsOf(REF, current, input, null)?.key).toBe("notes-2")
  })

  it("checks values by kind, and lets a required one with a default stay empty", () => {
    const required = {
      key: "k",
      name: "k",
      location: "env",
      description: null,
      required: true,
      secret: false,
      kind: "integer",
      default: null,
      placeholder: null,
      choices: [] as string[],
      current: null,
    }
    expect(parameterProblemOf(required, "")).toBe("required")
    expect(parameterProblemOf({ ...required, default: "3" }, "")).toBeNull()
    expect(parameterProblemOf(required, "3.5")).toBe("integer")
    expect(parameterProblemOf({ ...required, kind: "number" }, "x")).toBe(
      "number"
    )
    expect(parameterProblemOf({ ...required, kind: "boolean" }, "yes")).toBe(
      "boolean"
    )
    expect(parameterProblemOf({ ...required, kind: "json" }, "{")).toBe("json")
    expect(parameterProblemOf({ ...required, kind: "json" }, "[1]")).toBeNull()
  })

  it("needs an explicit tick for a withdrawn version", () => {
    const current = plan({
      confirm: [{ code: "yanked" }],
      snapshot: rawSnapshot({ status: "yanked" }),
    })
    let input = setValue(initialInput(current), "env.NOTES_TOKEN", "t")
    expect(installBlockersOf(current, input, null)).toEqual([
      { kind: "yanked" },
    ])
    expect(installArgsOf(REF, current, input, null)).toBeNull()
    input = { ...input, acceptYanked: true }
    expect(installArgsOf(REF, current, input, null)?.acceptYanked).toBe(true)
  })
})

describe("the install call", () => {
  it("carries exactly the plan's revision, fingerprint and each target's basis", () => {
    const current = plan()
    const input = setValue(initialInput(current), "env.NOTES_TOKEN", "secret-1")
    expect(installArgsOf(REF, current, input, null)).toEqual({
      itemRef: REF,
      revision: 3,
      optionId: "official:package:0:stdio",
      values: { "env.NOTES_TOKEN": "secret-1", "env.NOTES_DIR": "~/notes" },
      key: "notes",
      agents: ["claude_code", "codex"],
      replace: [],
      stateSha256: STATE,
      basis: { claude_code: "basis-claude_code", codex: "basis-codex" },
      acceptYanked: false,
    })
  })

  it("leaves out values that are empty, and sends nothing while one is missing", () => {
    const current = plan()
    let input = initialInput(current)
    expect(installArgsOf(REF, current, input, null)).toBeNull()
    expect(installBlockersOf(current, input, null)[0]).toMatchObject({
      kind: "parameter",
      problem: "required",
    })
    input = setValue(
      setValue(input, "env.NOTES_TOKEN", "t"),
      "env.NOTES_DIR",
      " "
    )
    expect(installArgsOf(REF, current, input, null)?.values).toEqual({
      "env.NOTES_TOKEN": "t",
    })
  })

  it("never names an agent the plan read no basis for, even ticked by hand", () => {
    const current = plan()
    let input = setValue(initialInput(current), "env.NOTES_TOKEN", "t")
    input = toggleTarget(current, input, "cline", true)
    expect(input.agents).not.toContain("cline")
    input = { ...input, agents: [...input.agents, "cline"] }
    const args = installArgsOf(REF, current, input, null)
    expect(args?.agents).toEqual(["claude_code", "codex"])
    expect(args?.basis).not.toHaveProperty("cline")
  })

  it("after the catalog's account changed, confirms the new state", () => {
    const current = plan()
    const input = setValue(initialInput(current), "env.NOTES_TOKEN", "t")
    const restate: McpInstallRestate = {
      snapshot: normalizeMcpPlan(
        rawPlan({
          snapshot: rawSnapshot({ risk: "medium", stateSha256: NEW_STATE }),
        })
      ).snapshot,
      stateSha256: NEW_STATE,
      changes: [
        {
          code: "risk_changed",
          params: { from: "low", to: "medium" },
          detail: null,
        },
      ],
    }
    const args = installArgsOf(REF, current, input, restate)
    expect(args?.stateSha256).toBe(NEW_STATE)
    // The basis is still the plan's: no file was read again.
    expect(args?.basis).toEqual({
      claude_code: "basis-claude_code",
      codex: "basis-codex",
    })
  })
})

describe("an installed item", () => {
  const installed = (agents = [rawInstalledAgent("claude_code")]) =>
    plan({
      item: {
        id: "item-notes",
        ref: REF,
        kind: "mcp",
        title: { en: "Acme Notes" },
        revision: 4,
        version: "1.3.0",
        published_at: "2026-11-15T08:00:00.000Z",
      },
      installed: rawInstalledItem({ key: "acme-notes", agents }),
      options: [
        rawStdioOption({
          default_targets: ["claude_code"],
          default_replace: ["claude_code"],
          parameters: [
            rawParameter({
              current: {
                value: "kept-token",
                agents: ["claude_code"],
                conflicting: false,
              },
            }),
            rawParameter({
              key: "env.NOTES_DIR",
              name: "NOTES_DIR",
              required: false,
              secret: false,
              default: "~/notes",
              current: {
                value: "/data/notes",
                agents: ["claude_code"],
                conflicting: false,
              },
            }),
          ],
          recovery: { from: ["claude_code"], unmatched: [], lost: [] },
        }),
      ],
      agents: [
        rawPlanAgent("claude_code", { keys: ["acme-notes"] }),
        ...rawPlanAgents().slice(1),
      ],
      key: {
        name: "notes",
        default: "acme-notes",
        pattern: "^[A-Za-z0-9_-]{1,64}$",
        conflicts: [
          {
            key: "acme-notes",
            agent: "claude_code",
            owner: "this_item",
            item_id: "item-notes",
            item_ref: REF,
            state: "as_installed",
            definition: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@acme/notes-mcp@1.2.0"],
              env: { NOTES_TOKEN: "not-read-from-here", NOTES_DIR: "/x" },
            },
            enabled: true,
          },
        ],
      },
    })

  it("is an update, keeps its name, replaces its own entry, keeps the values it has", () => {
    const current = installed()
    expect(installModeOf(current)).toBe("update")
    const input = initialInput(current)
    expect(input.key).toBe("acme-notes")
    expect(input.replace).toEqual(["claude_code"])
    expect(input.values).toEqual({
      "env.NOTES_TOKEN": "kept-token",
      "env.NOTES_DIR": "/data/notes",
    })
    expect(setInstallKey(current, input, "other").key).toBe("acme-notes")
    expect(keyProblemOf(current, "other")).toBe("fixed")
    expect(installArgsOf(REF, current, input, null)).toMatchObject({
      key: "acme-notes",
      agents: ["claude_code"],
      replace: ["claude_code"],
      revision: 4,
    })
  })

  it("does not tick an agent the record has at a newer revision", () => {
    const current = installed([
      rawInstalledAgent("claude_code", { revision: 5, version: "1.4.0" }),
    ])
    expect(installModeOf(current)).toBe("manage")
    expect(defaultTargetsOf(current, current.options[0])).toEqual({
      agents: [],
      replace: [],
    })
  })
})

describe("what an installed item's entries hold", () => {
  const withCurrent = (
    current: { value: string; agents: string[]; conflicting: boolean },
    extra: Record<string, unknown> = {}
  ) =>
    plan({
      options: [
        rawStdioOption({
          parameters: [rawParameter({ current, ...extra })],
        }),
      ],
    })

  it("does not fill in a value the agents disagree on, and asks for one", () => {
    const current = withCurrent({
      value: "from-claude",
      agents: ["claude_code", "codex"],
      conflicting: true,
    })
    let input = initialInput(current)
    expect(input.values["env.NOTES_TOKEN"]).toBe("")
    expect(installBlockersOf(current, input, null)).toEqual([
      { kind: "disagree", parameter: current.options[0].parameters[0] },
    ])
    expect(installArgsOf(REF, current, input, null)).toBeNull()
    // Taking the first agent's value — or typing one — settles it.
    input = setValue(input, "env.NOTES_TOKEN", "from-claude")
    expect(installBlockersOf(current, input, null)).toEqual([])
    expect(installArgsOf(REF, current, input, null)?.values).toEqual({
      "env.NOTES_TOKEN": "from-claude",
    })
  })

  it("asks again about a disagreement whose value was dropped by switching ways of running it", () => {
    const current = plan({
      options: [
        rawStdioOption({
          parameters: [
            rawParameter({
              required: false,
              current: {
                value: "from-claude",
                agents: ["claude_code", "codex"],
                conflicting: true,
              },
            }),
          ],
        }),
        rawStdioOption({ id: "official:package:1:stdio", parameters: [] }),
      ],
    })
    let input = setValue(initialInput(current), "env.NOTES_TOKEN", "mine")
    expect(installBlockersOf(current, input, null)).toEqual([])
    input = chooseOption(current, input, "official:package:1:stdio")
    expect(input.decided).toEqual([])
    input = chooseOption(current, input, "official:package:0:stdio")
    expect(input.values["env.NOTES_TOKEN"]).toBe("")
    expect(installBlockersOf(current, input, null)).toEqual([
      { kind: "disagree", parameter: current.options[0].parameters[0] },
    ])
  })

  it("treats an answer that does not say whether the agents agree as a disagreement", () => {
    const current = normalizeMcpPlan(
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [rawParameter({ current: { value: "v", agents: [] } })],
          }),
        ],
      })
    )
    expect(current.options[0].parameters[0].current?.conflicting).toBe(true)
    expect(initialInput(current).values["env.NOTES_TOKEN"]).toBe("")
  })

  it("over a new plan, keeps what the user set and takes the rest afresh", () => {
    const first = withCurrent({
      value: "old",
      agents: ["claude_code"],
      conflicting: false,
    })
    const untouched = initialInput(first)
    const second = withCurrent({
      value: "new",
      agents: ["claude_code"],
      conflicting: false,
    })
    expect(initialInput(second, untouched).values["env.NOTES_TOKEN"]).toBe(
      "new"
    )
    const typed = setValue(untouched, "env.NOTES_TOKEN", "mine")
    expect(initialInput(second, typed).values["env.NOTES_TOKEN"]).toBe("mine")
  })

  it("takes only one of a parameter's choices", () => {
    const current = plan({
      options: [
        rawStdioOption({
          parameters: [
            rawParameter({
              key: "env.REGION",
              name: "REGION",
              secret: false,
              choices: ["eu", "us"],
              current: {
                value: "apac",
                agents: ["claude_code"],
                conflicting: false,
              },
            }),
          ],
        }),
      ],
    })
    const input = initialInput(current)
    // Filled in as it is, and said to be wrong — not dropped quietly.
    expect(input.values["env.REGION"]).toBe("apac")
    expect(installBlockersOf(current, input, null)[0]).toMatchObject({
      kind: "parameter",
      problem: "choice",
    })
    expect(
      installBlockersOf(current, setValue(input, "env.REGION", "eu"), null)
    ).toEqual([])
  })
})

describe("a name the user types", () => {
  it("is taken where an agent's entries say so, and needs the replace tick", () => {
    const current = plan({
      agents: [
        rawPlanAgent("claude_code", {
          entries: [
            {
              key: "team-notes",
              owner: "other_item",
              item_id: "x",
              item_ref: "someone.example/notes",
            },
          ],
        }),
        rawPlanAgent("codex", { transports: ["stdio", "http"] }),
      ],
    })
    let input = setValue(initialInput(current), "env.NOTES_TOKEN", "t")
    input = setInstallKey(current, input, "team-notes")
    const rows = targetRowsOf(current, current.options[0], "team-notes")
    expect(rows[0]).toMatchObject({
      existing: true,
      conflict: null,
      entry: { owner: "other_item", item_ref: "someone.example/notes" },
    })
    expect(rows[1].existing).toBe(false)
    expect(installBlockersOf(current, input, null)).toEqual([
      { kind: "replace", agents: ["claude_code"] },
    ])
    input = toggleReplace(input, "claude_code", true)
    expect(installArgsOf(REF, current, input, null)?.replace).toEqual([
      "claude_code",
    ])
  })
})

describe("a new plan over the same dialog", () => {
  it("keeps what the user put in wherever it still applies", () => {
    const first = plan()
    let input = initialInput(first)
    input = setValue(input, "env.NOTES_TOKEN", "typed")
    input = setInstallKey(first, input, "my-notes")
    input = toggleTarget(first, input, "codex", false)
    const second = plan({
      agents: [
        rawPlanAgent("claude_code", { basis: "basis-claude_code-2" }),
        rawPlanAgent("codex", { transports: ["stdio", "http"] }),
      ],
    })
    const kept = initialInput(second, input)
    expect(kept.values["env.NOTES_TOKEN"]).toBe("typed")
    expect(kept.key).toBe("my-notes")
    expect(kept.agents).toEqual(["claude_code"])
    // The new plan's basis is what goes out.
    expect(installArgsOf(REF, second, kept, null)?.basis).toEqual({
      claude_code: "basis-claude_code-2",
    })
  })

  it("drops a choice the new plan no longer allows", () => {
    const first = plan()
    const input = chooseOption(
      first,
      initialInput(first),
      "official:remote:0:http"
    )
    const second = plan({
      options: [
        rawStdioOption(),
        {
          ...(rawPlan().options as Record<string, unknown>[])[1],
          selectable: false,
          blocking: [
            { code: "remote_not_public", params: { host: "10.0.0.1" } },
          ],
        },
      ],
    })
    expect(initialInput(second, input).optionId).toBe(
      "official:package:0:stdio"
    )
  })
})

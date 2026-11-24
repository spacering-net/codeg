import { describe, expect, it } from "vitest"

import { normalizeInstalled } from "./mcp-install-normalize"
import { rawListedHost, rawListedPlugin } from "./plugin-install-fixtures"
import { normalizeListedPlugins } from "./plugin-install-normalize"
import type { HarnessListedPlugin } from "./plugin-install-types"
import type { SkillsAgent } from "@/lib/skills/types"
import {
  hookTrustKey,
  hostActionsOf,
  hostStateKey,
  lockedSkillPlugin,
  otherModesOf,
  pluginProvidersOf,
  pluginRowsOf,
  pluginSectionCount,
  pluginSkillInvocation,
  pluginSkillsEnabled,
  providersBySkill,
  providersWithReaders,
  skillInvocationOf,
} from "./plugin-list"
import { normalizeHarnessUpdates } from "./updates"

function listed(overrides: Record<string, unknown> = {}): HarnessListedPlugin {
  const [plugin] = normalizeListedPlugins([rawListedPlugin(overrides)])
  return plugin
}

function updatesWith(item: Record<string, unknown>) {
  return normalizeHarnessUpdates({
    enabled: true,
    checking: false,
    checked_at: "2026-11-22T00:00:00Z",
    attempted_at: "2026-11-22T00:00:00Z",
    error: null,
    items: [item],
  })
}

describe("an agent's state on a plugin", () => {
  it("reads each state, and one it does not know as unknown", () => {
    expect(hostStateKey({ kind: "active", reason: null })).toBe("active")
    expect(hostStateKey({ kind: "disabled_by_user", reason: null })).toBe(
      "disabled"
    )
    expect(hostStateKey({ kind: "suspended", reason: "yanked" })).toBe(
      "suspended"
    )
    expect(hostStateKey({ kind: "needs_repair", reason: null })).toBe(
      "needsRepair"
    )
    expect(hostStateKey({ kind: "something_new", reason: null })).toBe(
      "unknown"
    )
  })

  it("offers off for an agent that has it on, on for one the user turned off", () => {
    const [on] = listed().hosts
    expect(hostActionsOf(on)).toEqual({
      disable: true,
      enable: false,
      changeMode: true,
    })
    const off = { ...on, state: { kind: "disabled_by_user", reason: null } }
    expect(hostActionsOf(off)).toEqual({
      disable: false,
      enable: true,
      changeMode: true,
    })
  })

  it("offers nothing per agent where Codeg switched it off or it needs repair", () => {
    const [on] = listed().hosts
    for (const state of [
      { kind: "suspended", reason: "plugin_not_approved" },
      { kind: "needs_repair", reason: null },
      { kind: "brand_new", reason: null },
    ]) {
      expect(hostActionsOf({ ...on, state })).toEqual({
        disable: false,
        enable: false,
        changeMode: false,
      })
    }
  })

  it("offers nothing for a mode this build does not know", () => {
    const [on] = listed().hosts
    expect(hostActionsOf({ ...on, mode: "inline" })).toEqual({
      disable: false,
      enable: false,
      changeMode: false,
    })
    expect(otherModesOf({ ...on, mode: "inline" })).toEqual([])
  })

  it("changes a mode to the other one, or to none", () => {
    const [claude, gemini] = listed().hosts
    expect(otherModesOf(claude)).toEqual(["skills", "none"])
    expect(otherModesOf(gemini)).toEqual(["native", "none"])
  })
})

describe("the rows", () => {
  it("sorts by install name and says where an agent needs repair", () => {
    const plugins = normalizeListedPlugins([
      rawListedPlugin({ name: "zeta", item_id: "itm_z" }),
      rawListedPlugin({
        name: "alpha",
        item_id: "itm_a",
        hosts: [rawListedHost("claude_code", { state: "needs_repair" })],
      }),
    ])
    const rows = pluginRowsOf(plugins, null)
    expect(rows.map((row) => row.plugin.name)).toEqual(["alpha", "zeta"])
    expect(rows.map((row) => row.needsRepair)).toEqual([true, false])
  })

  it("marks an update to the plugin's target from the update check", () => {
    const [row] = pluginRowsOf(
      [listed()],
      updatesWith({
        id: "itm_superpowers",
        revision: 7,
        state: "update_available",
        update_available: true,
        latest: { revision: 9, version: "7.0.3" },
        ref: "obra/superpowers",
        plugin: {
          target: { revision: 8, version: "7.0.2" },
          needs_consent: false,
          suspended: false,
        },
      })
    )
    expect(row.remote.updateAvailable).toBe(true)
    expect(row.remote.remote).toBe("updateAvailable")
  })

  it("offers the update that turns on again a plugin Codeg switched off", () => {
    const [row] = pluginRowsOf(
      [
        listed({
          hosts: [
            rawListedHost("claude_code", {
              state: { suspended: { reason: "plugin_not_approved" } },
              suspended_reason: "plugin_not_approved",
            }),
          ],
        }),
      ],
      updatesWith({
        id: "itm_superpowers",
        revision: 7,
        state: "latest",
        update_available: true,
        latest: { revision: 7, version: "7.0.1" },
        ref: "obra/superpowers",
        plugin: {
          target: { revision: 7, version: "7.0.1" },
          needs_consent: true,
          suspended: true,
        },
      })
    )
    expect(row.suspended).toBe(true)
    expect(row.remote.updateAvailable).toBe(true)
  })

  it("says a plugin no longer on SRN, and one whose approval was withdrawn", () => {
    for (const [state, mark] of [
      ["gone", "gone"],
      ["unapproved", "unapproved"],
    ] as const) {
      const [row] = pluginRowsOf(
        [listed()],
        updatesWith({
          id: "itm_superpowers",
          revision: 7,
          state,
          update_available: false,
          latest: null,
          ref: null,
          plugin: { target: null, needs_consent: false, suspended: false },
        })
      )
      expect(row.remote.remote).toBe(mark)
      expect(row.remote.updateAvailable).toBe(false)
    }
  })

  it("goes by the listing's own copy of the check until there is one", () => {
    const [row] = pluginRowsOf(
      [
        listed({
          update: {
            id: "itm_superpowers",
            revision: 7,
            state: "yanked",
            update_available: false,
            latest: null,
            ref: null,
          },
        }),
      ],
      null
    )
    expect(row.remote.remote).toBe("yanked")
  })

  it("says nothing of updates where the catalog is switched off", () => {
    const [row] = pluginRowsOf(
      [
        listed({
          update: {
            id: "itm_superpowers",
            revision: 7,
            state: "gone",
            update_available: false,
            latest: null,
            ref: null,
          },
        }),
      ],
      normalizeHarnessUpdates({ enabled: false, items: [] })
    )
    expect(row.remote.remote).toBeNull()
  })
})

describe("the Plugins tab's count", () => {
  it("counts the plugins listed, and nothing before the host has said", () => {
    expect(pluginSectionCount(null)).toBeUndefined()
    expect(
      pluginSectionCount(
        normalizeInstalled({
          mcp: [],
          skills: [],
          plugins: [rawListedPlugin()],
        })
      )
    ).toBe(1)
    expect(
      pluginSectionCount(normalizeInstalled({ mcp: [], skills: [] }))
    ).toBe(0)
  })
})

describe("Codex's trust of the hooks", () => {
  it("says it in a word", () => {
    const hook = (state: string) => ({
      key: "k",
      event: "session_start",
      state,
    })
    expect(hookTrustKey({ hooks: [], problem: null })).toBe("none")
    expect(
      hookTrustKey({ hooks: [hook("trusted"), hook("trusted")], problem: null })
    ).toBe("trusted")
    expect(
      hookTrustKey({
        hooks: [hook("trusted"), hook("modified")],
        problem: null,
      })
    ).toBe("modified")
    expect(hookTrustKey({ hooks: [hook("untrusted")], problem: null })).toBe(
      "untrusted"
    )
    expect(
      hookTrustKey({
        hooks: [hook("trusted")],
        problem: { code: "plugin_hooks_unreadable", params: {}, detail: null },
      })
    ).toBe("unknown")
  })
})

describe("the name an agent sees a plugin's skill under", () => {
  it("is namespaced where Claude Code has the plugin whole", () => {
    expect(
      pluginSkillInvocation(
        { mode: "native", host_id: "claude", host_name: "superpowers" },
        "superpowers",
        "brainstorming"
      )
    ).toBe("superpowers:brainstorming")
  })

  it("uses the name the host knows the plugin by", () => {
    expect(
      pluginSkillInvocation(
        { mode: "native", host_id: "claude", host_name: "sp" },
        "superpowers",
        "brainstorming"
      )
    ).toBe("sp:brainstorming")
    expect(
      pluginSkillInvocation(
        { mode: "native", host_id: "claude", host_name: null },
        "superpowers",
        "brainstorming"
      )
    ).toBe("superpowers:brainstorming")
  })

  it("is the skill's own name with its skills only, and where the host does not namespace", () => {
    expect(
      pluginSkillInvocation(
        { mode: "skills", host_id: "claude", host_name: null },
        "superpowers",
        "brainstorming"
      )
    ).toBe("brainstorming")
    expect(
      pluginSkillInvocation(
        { mode: "native", host_id: "opencode", host_name: "superpowers" },
        "superpowers",
        "brainstorming"
      )
    ).toBe("brainstorming")
    expect(
      pluginSkillInvocation(
        { mode: "native", host_id: null, host_name: null },
        "superpowers",
        "brainstorming"
      )
    ).toBe("brainstorming")
  })
})

describe("which agent a plugin gives which skill", () => {
  it("gives a whole install its skill members, and a skills-only one what it has", () => {
    const providers = pluginProvidersOf([
      listed({
        hosts: [
          rawListedHost("claude_code"),
          rawListedHost("gemini", {
            host_id: null,
            mode: "skills",
            host_name: null,
            skills: ["brainstorming"],
          }),
        ],
      }),
    ])
    expect([...(providers.get("claude_code")?.keys() ?? [])]).toEqual([
      "brainstorming",
      "writing-plans",
    ])
    expect(providers.get("claude_code")?.get("brainstorming")).toEqual({
      plugin: "superpowers",
      itemId: "itm_superpowers",
      mode: "native",
      active: true,
      invocation: "superpowers:brainstorming",
    })
    expect([...(providers.get("gemini")?.keys() ?? [])]).toEqual([
      "brainstorming",
    ])
    expect(providers.get("gemini")?.get("brainstorming")?.invocation).toBe(
      "brainstorming"
    )
  })

  it("keeps the name for an agent that has it switched off, not as on", () => {
    const providers = pluginProvidersOf([
      listed({
        hosts: [rawListedHost("claude_code", { state: "disabled_by_user" })],
      }),
    ])
    expect(providers.get("claude_code")?.get("brainstorming")?.active).toBe(
      false
    )
    expect(providersBySkill(providers, "brainstorming")).toEqual({
      claude_code: "superpowers",
    })
    expect(providersBySkill(providers, "not-a-member")).toEqual({})
  })

  it("gives nothing for a mode this build does not know", () => {
    const providers = pluginProvidersOf([
      listed({ hosts: [rawListedHost("claude_code", { mode: "inline" })] }),
    ])
    expect(providers.size).toBe(0)
  })

  it("leaves a name two plugins would give to the first listed", () => {
    const providers = pluginProvidersOf([
      listed(),
      listed({ name: "other", item_id: "itm_other" }),
    ])
    expect(providers.get("claude_code")?.get("brainstorming")?.plugin).toBe(
      "superpowers"
    )
  })
})

describe("the chat's shortcuts to a plugin's skill", () => {
  const providers = pluginProvidersOf([
    listed({
      hosts: [
        rawListedHost("claude_code"),
        rawListedHost("codex", { state: "disabled_by_user" }),
      ],
    }),
  ])
  const claude = providers.get("claude_code") ?? new Map()
  const codex = providers.get("codex") ?? new Map()

  it("counts as enabled only where the agent has the plugin on", () => {
    expect(pluginSkillsEnabled(providers)).toEqual([
      ["claude_code", "brainstorming"],
      ["claude_code", "writing-plans"],
    ])
  })

  it("counts neither a skills-only member by the record nor one its host has off", () => {
    const more = pluginProvidersOf([
      listed({
        hosts: [
          rawListedHost("gemini", {
            host_id: null,
            mode: "skills",
            host_name: null,
            skills: ["brainstorming"],
            verify: null,
          }),
          rawListedHost("claude_code", {
            verify: { enabled: false, problems: [] },
          }),
        ],
      }),
    ])
    expect(pluginSkillsEnabled(more)).toEqual([])
    expect(more.get("claude_code")?.get("brainstorming")?.active).toBe(false)
    // A listing that could not check the host leaves it as the record says.
    const unchecked = pluginProvidersOf([
      listed({ hosts: [rawListedHost("claude_code", { verify: null })] }),
    ])
    expect(unchecked.get("claude_code")?.get("brainstorming")?.active).toBe(
      true
    )
  })

  it("invokes the name the agent sees, and the plain id otherwise", () => {
    expect(skillInvocationOf("brainstorming", claude)).toBe(
      "superpowers:brainstorming"
    )
    // Off there: the shortcut is locked, and would not be the plugin's.
    expect(skillInvocationOf("brainstorming", codex)).toBe("brainstorming")
    expect(skillInvocationOf("not-a-member", claude)).toBe("not-a-member")
  })

  it("sends a locked one to its plugin, never to the skill pack", () => {
    expect(lockedSkillPlugin("brainstorming", codex)).toEqual({
      plugin: "superpowers",
      itemId: "itm_superpowers",
    })
    expect(lockedSkillPlugin("brainstorming", claude)).toEqual({
      plugin: "superpowers",
      itemId: "itm_superpowers",
    })
    expect(lockedSkillPlugin("not-a-member", codex)).toBeNull()
  })
})

describe("the agents a plugin keeps an expert's name from", () => {
  const agent = (
    id: string,
    linkDir: string | null,
    sharedWith: string[] = []
  ): SkillsAgent => ({
    agent: id,
    dirs: linkDir
      ? [
          {
            path: linkDir,
            role: "shared",
            shared_with: sharedWith,
            exists: true,
          },
        ]
      : [],
    link_dir: linkDir,
    link_dir_shared: sharedWith.length > 0,
  })

  it("adds an agent whose link folder another one it is given to reads", () => {
    expect(
      providersWithReaders({ codex: "superpowers" }, [
        agent("codex", "/home/u/.codex/skills"),
        agent("kimi_code", "/home/u/.agents/skills", ["codex", "open_code"]),
        agent("open_code", "/home/u/.config/opencode/skills"),
        agent("pi", null),
      ])
    ).toEqual({ codex: "superpowers", kimi_code: "superpowers" })
  })

  it("adds nobody when no plugin gives the name", () => {
    expect(
      providersWithReaders({}, [agent("kimi_code", "/x", ["codex"])])
    ).toEqual({})
  })
})

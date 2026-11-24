import { describe, expect, it } from "vitest"

import { HarnessClientError } from "./errors"
import { normalizeInstalled } from "./mcp-install-normalize"
import {
  ACK_BRAINSTORMING,
  EXEC,
  EXPERTS_ACK,
  HOOK,
  NEW_EXEC,
  rawListedHost,
  rawListedPlugin,
  rawPlanHost,
  rawPluginPlan,
  rawRevision,
  rawUpdatePlan,
} from "./plugin-install-fixtures"
import {
  normalizeHookTrust,
  normalizeListedPlugins,
  normalizePluginUpdatePlan,
  normalizePluginInfo,
  normalizePluginInstallResult,
  normalizePluginPlan,
  normalizePluginUninstallResult,
  normalizeReleases,
  pluginHostState,
} from "./plugin-install-normalize"

describe("harness_plugin_plan's answer", () => {
  it("reads the plan as the backend sends it", () => {
    const plan = normalizePluginPlan(rawPluginPlan())
    expect(plan.item).toMatchObject({ ref: "obra/superpowers", kind: "plugin" })
    expect(plan.latest).toMatchObject({ revision: 8, approved: false })
    expect(plan.full).toMatchObject({
      revision: 7,
      version: "7.0.1",
      approved: true,
      exec_sha256: EXEC,
    })
    expect(plan.target).toBe(7)
    expect(plan.not_full).toBe("pending_review")
    expect(plan.members.map((member) => member.name)).toEqual([
      "brainstorming",
      "writing-plans",
    ])
    expect(plan.autorun).toEqual([
      {
        host: "claude",
        type: "hook",
        path: "hooks/hooks.json",
        event: "SessionStart",
        name: null,
        command: HOOK.command,
      },
    ])
    expect(plan.hosts[0]).toMatchObject({
      agent: "claude_code",
      host_id: "claude",
      offered: ["native", "skills", "none"],
      default: "native",
      planned: "native",
      detect: { found: true, supported: true, version: "2.1.0" },
    })
    expect(plan.hosts[1].skills?.links?.ops[0].ack).toBe(ACK_BRAINSTORMING)
    expect(plan.consent_required).toBe(true)
  })

  it("refuses an answer that is not a plan", () => {
    expect(() => normalizePluginPlan(null)).toThrow(HarnessClientError)
    expect(() => normalizePluginPlan({ item: {}, hosts: [] })).toThrow(
      HarnessClientError
    )
    expect(() =>
      normalizePluginPlan({ ...rawPluginPlan(), hosts: "claude_code" })
    ).toThrow(HarnessClientError)
  })

  it("makes nothing more permissive than it came", () => {
    const plan = normalizePluginPlan(
      rawPluginPlan({
        full: rawRevision(7, "7.0.1", { approved: "yes" }),
        consent_required: "true",
        hosts: [
          {
            agent: "claude_code",
            offered: ["native"],
            detect: { found: true, supported: "yes" },
            codex_hooks_need_trust: 1,
          },
        ],
      })
    )
    expect(plan.full?.approved).toBe(false)
    expect(plan.consent_required).toBe(false)
    const row = plan.hosts[0]
    // Not at all is always a choice; a missing default or plan is "none".
    expect(row.offered).toEqual(["native", "none"])
    expect(row.default).toBe("none")
    expect(row.planned).toBe("none")
    expect(row.detect?.supported).toBe(false)
    expect(row.codex_hooks_need_trust).toBe(false)
    expect(row.skills).toBeNull()
  })

  it("keeps an autorun part of a type it does not know: it still runs", () => {
    const plan = normalizePluginPlan(
      rawPluginPlan({
        autorun: [
          { host: "claude", type: "daemon", path: "bin/x" },
          { host: "codex" },
        ],
      })
    )
    expect(plan.autorun.map((part) => part.type)).toEqual(["daemon", "unknown"])
  })

  it("drops rows without an agent and reads an unreadable link preview as none", () => {
    const plan = normalizePluginPlan(
      rawPluginPlan({
        hosts: [
          { offered: ["skills"] },
          rawPlanHost("kiro", {
            skills: { agent: "kiro", links: { ops: [] } },
          }),
        ],
      })
    )
    expect(plan.hosts.map((row) => row.agent)).toEqual(["kiro"])
    expect(plan.hosts[0].skills?.links).toBeNull()
  })

  it("reads an installed entry's agents and their states", () => {
    const plan = normalizePluginPlan(
      rawPluginPlan({
        installed: {
          name: "superpowers",
          item_id: "itm_superpowers",
          ref: "obra/superpowers",
          revision: 7,
          version: "7.0.1",
          hosts: {
            claude_code: { mode: "native", state: "active", skills: [] },
            codex: {
              mode: "native",
              state: { suspended: { reason: "plugin_not_approved" } },
            },
          },
          consent: EXEC,
          installed_at: "2026-11-20T00:00:00Z",
        },
      })
    )
    expect(plan.installed?.hosts.claude_code.state).toEqual({
      kind: "active",
      reason: null,
    })
    expect(plan.installed?.hosts.codex.state).toEqual({
      kind: "suspended",
      reason: "plugin_not_approved",
    })
    expect(plan.installed?.consent).toBe(EXEC)
  })
})

describe("a host's state", () => {
  it("reads both of serde's shapes, and anything else as unknown", () => {
    expect(pluginHostState("needs_repair")).toEqual({
      kind: "needs_repair",
      reason: null,
    })
    expect(pluginHostState({ suspended: { reason: "yanked" } })).toEqual({
      kind: "suspended",
      reason: "yanked",
    })
    expect(pluginHostState(null)).toEqual({ kind: "unknown", reason: null })
    expect(pluginHostState({})).toEqual({ kind: "unknown", reason: null })
  })
})

describe("harness_plugin_install's answer", () => {
  it("reads every agent's step and what is left to repair", () => {
    const result = normalizePluginInstallResult({
      outcome: "failed",
      issues: [
        {
          code: "plugin_host_step_failed",
          params: { agent: "codex", step: "install" },
        },
      ],
      hosts: [
        { agent: "kiro", mode: "skills", status: "undone", issues: [] },
        { agent: "codex", mode: "native", status: "needs_repair" },
        { mode: "native" },
      ],
      needs_repair: ["codex"],
      skills: { kiro: { agent: "kiro", links: null } },
      experts_acks: { kiro: "aa", bad: 1 },
      revision: 7,
    })
    expect(result.outcome).toBe("failed")
    expect(result.issues[0].params).toEqual({ agent: "codex", step: "install" })
    expect(result.hosts.map((host) => host.agent)).toEqual(["kiro", "codex"])
    expect(result.needs_repair).toEqual(["codex"])
    expect(result.skills.kiro.links).toBeNull()
    expect(result.experts_acks).toEqual({ kiro: "aa" })
    expect(result.revision).toBe(7)
    expect(result.consent_required).toBe(false)
  })

  it("refuses an answer without an outcome", () => {
    expect(() => normalizePluginInstallResult({ hosts: [] })).toThrow(
      HarnessClientError
    )
  })
})

describe("harness_plugin_uninstall's answer", () => {
  it("reads the preflight with its ack and what each agent gives back", () => {
    const result = normalizePluginUninstallResult({
      outcome: "preflight",
      item_id: "itm_superpowers",
      name: "superpowers",
      removes: { kiro: { agent: "kiro", links: null } },
      experts: {
        kiro: [{ name: "brainstorming", path: "/p", agents: ["kiro"] }],
      },
      ack: "ab".repeat(32),
    })
    expect(result.ack).toBe("ab".repeat(32))
    expect(result.experts.kiro[0]).toEqual({
      name: "brainstorming",
      path: "/p",
      copy: false,
      agents: ["kiro"],
    })
  })
})

describe("an item's plugin part", () => {
  it("reads the install info's plugin, strictest where a field is off", () => {
    const info = normalizePluginInfo({
      name: "superpowers",
      hosts: [{ host: "claude", skills: 15, hooks: 1 }, { skills: 2 }],
      components: [{ kind: "skill", name: "brainstorming", path: "skills/b" }],
      autorun: [HOOK],
      autorunFiles: ["hooks/hooks.json"],
      mcpUnpinned: [],
      execSha256: EXEC,
      approved: "true",
      full: { revision: "7" },
      notFull: "pending_review",
    })
    expect(info?.hosts).toEqual([
      expect.objectContaining({
        host: "claude",
        skills: 15,
        hooks: 1,
        code: 0,
      }),
    ])
    expect(info?.approved).toBe(false)
    expect(info?.full).toBeNull()
    expect(info?.components[0].treeSha256).toBeNull()
    expect(normalizePluginInfo(undefined)).toBeNull()
  })
})

describe("harness_releases' answer", () => {
  it("reads the releases newest first, with what each changed", () => {
    const releases = normalizeReleases([
      {
        version: "7.0.2",
        tag: "v7.0.2",
        url: "https://github.com/obra/superpowers/releases/tag/v7.0.2",
        notes: "/api/harness/v1/items/obra/superpowers/releases/7.0.2/notes",
        publishedAt: "2026-11-20T00:00:00Z",
        revision: 8,
        changed: { added: ["x"], updated: ["brainstorming"], removed: [] },
      },
      { version: "7.0.1", changed: null },
      { tag: "no-version" },
    ])
    expect(releases.map((release) => release.version)).toEqual([
      "7.0.2",
      "7.0.1",
    ])
    expect(releases[0].changed?.updated).toEqual(["brainstorming"])
    expect(releases[1]).toMatchObject({
      revision: null,
      changed: null,
      url: null,
    })
  })

  it("refuses an answer that is not a list", () => {
    expect(() => normalizeReleases({ releases: [] })).toThrow(
      HarnessClientError
    )
  })
})

describe("harness_installed's plugins", () => {
  it("reads each row as the backend sends it", () => {
    const [plugin] = normalizeListedPlugins([rawListedPlugin()])
    expect(plugin).toMatchObject({
      name: "superpowers",
      item_id: "itm_superpowers",
      ref: "obra/superpowers",
      revision: 7,
      version: "7.0.1",
      consent: EXEC,
      update: null,
      problems: [],
    })
    expect(plugin.members.map((member) => member.name)).toEqual([
      "brainstorming",
      "writing-plans",
    ])
    expect(plugin.autorun).toEqual([
      expect.objectContaining({ host: "claude", type: "hook" }),
    ])
    expect(plugin.hosts[0]).toMatchObject({
      agent: "claude_code",
      host_id: "claude",
      mode: "native",
      state: { kind: "active", reason: null },
      host_name: "superpowers",
      verify: { enabled: true, problems: [] },
    })
    expect(plugin.hosts[1]).toMatchObject({
      agent: "gemini",
      mode: "skills",
      skills: ["brainstorming", "writing-plans"],
      verify: null,
    })
  })

  it("reads the states serde writes, with a suspension's reason and a repair note", () => {
    const [plugin] = normalizeListedPlugins([
      rawListedPlugin({
        hosts: [
          rawListedHost("claude_code", {
            state: { suspended: { reason: "yanked" } },
            suspended_reason: "yanked",
          }),
          rawListedHost("codex", {
            state: "needs_repair",
            repair: {
              was: "active",
              other_modes: ["skills"],
              uninstalling: true,
            },
            codex_hooks: true,
          }),
        ],
      }),
    ])
    expect(plugin.hosts[0].state).toEqual({
      kind: "suspended",
      reason: "yanked",
    })
    expect(plugin.hosts[0].suspended_reason).toBe("yanked")
    expect(plugin.hosts[1].repair).toEqual({
      was: { kind: "active", reason: null },
      other_modes: ["skills"],
      uninstalling: true,
      restored: false,
    })
    expect(plugin.hosts[1].codex_hooks).toBe(true)
  })

  it("reads the update check's word on a row", () => {
    const [plugin] = normalizeListedPlugins([
      rawListedPlugin({
        update: {
          id: "itm_superpowers",
          revision: 7,
          state: "unapproved",
          update_available: false,
          latest: { revision: 8, version: "7.0.2" },
          ref: "obra/superpowers",
          plugin: { target: null, needs_consent: false, suspended: false },
        },
      }),
    ])
    expect(plugin.update).toMatchObject({
      state: "unapproved",
      plugin: { target: null, suspended: false },
    })
  })

  it("drops a row without a name or an item, and a second row for one item", () => {
    expect(
      normalizeListedPlugins([
        rawListedPlugin({ name: "" }),
        rawListedPlugin({ item_id: "" }),
        rawListedPlugin(),
        rawListedPlugin({ name: "again" }),
        "nonsense",
      ]).map((plugin) => plugin.name)
    ).toEqual(["superpowers"])
    expect(normalizeListedPlugins(undefined)).toEqual([])
  })

  it("is part of harness_installed's answer, with its problem", () => {
    const installed = normalizeInstalled({
      mcp: [],
      skills: [],
      plugins: [rawListedPlugin()],
      plugins_problem: { code: "record_unreadable", params: {} },
    })
    expect(installed.plugins?.map((plugin) => plugin.name)).toEqual([
      "superpowers",
    ])
    expect(installed.plugins_problem?.code).toBe("record_unreadable")
    const older = normalizeInstalled({ mcp: [], skills: [] })
    expect(older.plugins).toEqual([])
    expect(older.plugins_problem).toBeNull()
  })
})

describe("harness_plugin_hook_trust's answer", () => {
  it("reads each hook, and a state not said as unknown", () => {
    expect(
      normalizeHookTrust({
        hooks: [
          { key: "a", event: "session_start", state: "trusted" },
          { key: "b", event: "session_start" },
          { event: "no key" },
        ],
        problem: null,
      })
    ).toEqual({
      hooks: [
        { key: "a", event: "session_start", state: "trusted" },
        { key: "b", event: "session_start", state: "unknown" },
      ],
      problem: null,
    })
  })

  it("refuses what is not one", () => {
    expect(() => normalizeHookTrust({ problem: null })).toThrow(
      HarnessClientError
    )
  })
})

describe("harness_plugin_plan_update's answer", () => {
  it("reads the plan as the backend sends it", () => {
    const plan = normalizePluginUpdatePlan(rawUpdatePlan())
    expect(plan).toMatchObject({
      target: 8,
      revision_from: 7,
      version_from: "7.0.1",
      version_to: "7.0.2",
      up_to_date: false,
      needs_consent: true,
      consent_exec: NEW_EXEC,
    })
    expect(plan.item?.ref).toBe("obra/superpowers")
    expect(plan.installed?.revision).toBe(7)
    expect(plan.latest?.revision).toBe(8)
    expect(plan.changed_members).toEqual([
      { kind: "skill", name: "brainstorming", change: "changed" },
      { kind: "skill", name: "writing-skills", change: "added" },
    ])
    expect(plan.hosts[1]).toMatchObject({
      agent: "gemini",
      mode: "skills",
      to_mode: "skills",
      action: "update",
      experts_ack: EXPERTS_ACK,
    })
    expect(plan.hosts[1].skills?.links?.ops[0].ack).toBe(ACK_BRAINSTORMING)
  })

  it("keeps an unknown target as none, and unknown members as not known", () => {
    const plan = normalizePluginUpdatePlan(
      rawUpdatePlan({ target: null, changed_members: null, latest: null })
    )
    expect(plan.target).toBeNull()
    expect(plan.changed_members).toBeNull()
    expect(plan.latest).toBeNull()
  })

  it("refuses what is not one", () => {
    expect(() => normalizePluginUpdatePlan({ target: 8 })).toThrow(
      HarnessClientError
    )
  })
})

import { describe, expect, it } from "vitest"

import {
  autorunFileOf,
  defaultPluginModes,
  initialPluginInput,
  offeredModes,
  pluginConsentGiven,
  pluginConsentNeeded,
  pluginInstallArgsOf,
  pluginInstallBlockersOf,
  pluginPreviewIsStale,
  pluginTargetOf,
  pluginTargetSnapshot,
  pluginVersionsOf,
  setPluginAcceptYanked,
  setPluginConsent,
  pluginRowsToSetAll,
  setPluginHostMode,
  setPluginModeForAll,
  type PluginInstallInput,
} from "./plugin-install"
import {
  ACK_BRAINSTORMING,
  EXEC,
  EXPERTS_ACK,
  FULL_STATE,
  LATEST_STATE,
  rawOwnedPlan,
  rawPlanHost,
  rawPluginPlan,
  rawRevision,
  rawSkillsOnlyPlan,
} from "./plugin-install-fixtures"
import { normalizePluginPlan } from "./plugin-install-normalize"
import { rawSnapshot } from "./mcp-install-fixtures"

type Json = Record<string, unknown>

const plan = (overrides: Json = {}) =>
  normalizePluginPlan(rawPluginPlan(overrides))
const skillsOnly = (overrides: Json = {}) =>
  normalizePluginPlan(rawSkillsOnlyPlan(overrides))

const agreed = (input: PluginInstallInput): PluginInstallInput => ({
  ...input,
  consentExec: EXEC,
})

describe("the modes each agent starts with", () => {
  it("takes each row's default from the plan", () => {
    expect(defaultPluginModes(plan())).toEqual({
      claude_code: "native",
      kiro: "skills",
    })
  })

  it("reads a default the row does not offer, or does not know, as not at all", () => {
    const planned = plan({
      hosts: [
        rawPlanHost("claude_code", { offered: ["skills", "none"] }),
        rawPlanHost("kiro", { default: "whole" }),
      ],
    })
    expect(defaultPluginModes(planned)).toEqual({
      claude_code: "none",
      kiro: "none",
    })
  })

  it("offers only the modes it knows, in its own order, never without not at all", () => {
    const planned = plan({
      hosts: [
        rawPlanHost("claude_code", { offered: ["skills", "native", "x"] }),
      ],
    })
    expect(offeredModes(planned.hosts[0])).toEqual(["native", "skills", "none"])
  })

  it("starts with nothing agreed to and the withdrawn version not accepted", () => {
    const input = initialPluginInput(plan())
    expect(input).toEqual({
      modes: { claude_code: "native", kiro: "skills" },
      consentExec: null,
      acceptYanked: false,
      touched: [],
    })
  })

  it("keeps the modes the user chose over a new plan, where they are still offered", () => {
    const first = plan()
    const chosen = setPluginHostMode(
      first,
      setPluginHostMode(
        first,
        initialPluginInput(first),
        "claude_code",
        "skills"
      ),
      "kiro",
      "none"
    )
    const next = plan({
      hosts: [
        rawPlanHost("claude_code", { planned: "skills" }),
        rawPlanHost("kiro", { offered: ["skills"] }),
      ],
    })
    // Kiro still offers "not at all": kept.
    expect(initialPluginInput(next, chosen).modes).toEqual({
      claude_code: "skills",
      kiro: "none",
    })
    const lost = plan({
      hosts: [
        rawPlanHost("claude_code", { offered: ["none"], default: "none" }),
        rawPlanHost("kiro"),
      ],
    })
    // Claude Code no longer offers "skills only": its default again.
    const input = initialPluginInput(lost, chosen)
    expect(input.modes.claude_code).toBe("none")
    expect(input.touched).toEqual(["kiro"])
  })

  it("only gives an agent a mode its row offers", () => {
    const planned = plan()
    const input = initialPluginInput(planned)
    expect(setPluginHostMode(planned, input, "kiro", "native")).toBe(input)
    expect(setPluginHostMode(planned, input, "cursor", "skills")).toBe(input)
    expect(
      setPluginHostMode(planned, input, "claude_code", "none").touched
    ).toEqual(["claude_code"])
  })

  it("sets every agent that offers a mode at once, and leaves the rest", () => {
    const planned = plan()
    const input = initialPluginInput(planned)
    // Kiro cannot have it as a plugin: only Claude Code would change, and
    // it already has.
    expect(pluginRowsToSetAll(planned, input, "native")).toEqual([])
    expect(setPluginModeForAll(planned, input, "native")).toBe(input)
    expect(pluginRowsToSetAll(planned, input, "skills")).toEqual([
      "claude_code",
    ])
    const none = setPluginModeForAll(planned, input, "none")
    expect(none.modes).toEqual({ claude_code: "none", kiro: "none" })
    expect(none.touched).toEqual(["claude_code", "kiro"])
    // Back to plugins: Kiro keeps "not at all".
    expect(setPluginModeForAll(planned, none, "native").modes).toEqual({
      claude_code: "native",
      kiro: "none",
    })
  })
})

describe("which revision is installed", () => {
  it("is the one to install whole when any agent has it as a plugin", () => {
    const planned = plan()
    const input = initialPluginInput(planned)
    expect(pluginTargetOf(planned, input.modes).revision).toBe(7)
    expect(pluginTargetSnapshot(planned, input.modes)?.stateSha256).toBe(
      FULL_STATE
    )
  })

  it("is the latest when every agent takes its skills only", () => {
    const planned = skillsOnly()
    const input = initialPluginInput(planned)
    const modes = { claude_code: "skills", kiro: "skills" } as const
    expect(pluginTargetOf(planned, modes).revision).toBe(8)
    expect(pluginTargetSnapshot(planned, modes)?.stateSha256).toBe(LATEST_STATE)
    expect(input.modes.claude_code).toBe("native")
  })

  it("is the latest when there is no revision to install whole", () => {
    const planned = plan({ full: null })
    expect(pluginTargetOf(planned, { claude_code: "native" }).revision).toBe(8)
  })

  it("asks for a new plan while the modes chosen are not the plan's", () => {
    const planned = plan()
    const input = initialPluginInput(planned)
    expect(pluginPreviewIsStale(planned, input)).toBe(false)
    const changed = setPluginHostMode(planned, input, "claude_code", "skills")
    expect(pluginPreviewIsStale(planned, changed)).toBe(true)
    expect(pluginInstallBlockersOf(planned, changed)).toContainEqual({
      kind: "planning",
    })
  })
})

describe("the two versions", () => {
  const latest = { revision: 8, version: "7.0.2" }

  it("says nothing when the latest may be installed whole", () => {
    expect(pluginVersionsOf(latest, latest, null)).toEqual({ kind: "same" })
  })

  it("names both when the one to install whole is behind", () => {
    expect(
      pluginVersionsOf(
        { revision: 7, version: "7.0.1" },
        latest,
        "pending_review"
      )
    ).toEqual({
      kind: "behind",
      full: "7.0.1",
      latest: "7.0.2",
      reason: "pending",
    })
    expect(
      pluginVersionsOf({ revision: 7, version: null }, latest, "mcp_unpinned")
    ).toEqual({
      kind: "behind",
      full: "#7",
      latest: "7.0.2",
      reason: "unpinned",
    })
  })

  it("says it waits for review when none may be installed whole — also for a reason it does not know", () => {
    expect(pluginVersionsOf(null, latest, "pending_review")).toEqual({
      kind: "none",
      reason: "pending",
    })
    expect(pluginVersionsOf(null, latest, "something_new")).toEqual({
      kind: "none",
      reason: "pending",
    })
  })
})

describe("the agreement to what runs on its own", () => {
  it("is needed for any agent as a plugin of a plugin that runs something", () => {
    const planned = plan()
    expect(pluginConsentNeeded(planned, initialPluginInput(planned))).toBe(true)
    expect(
      pluginConsentNeeded(planned, {
        ...initialPluginInput(planned),
        modes: { claude_code: "skills", kiro: "skills" },
      })
    ).toBe(false)
  })

  it("is needed by the autorun parts even when the plan does not say so", () => {
    const planned = plan({ consent_required: false })
    expect(pluginConsentNeeded(planned, initialPluginInput(planned))).toBe(true)
  })

  it("counts only for the plan's exec hash", () => {
    const planned = plan()
    const input = setPluginConsent(planned, initialPluginInput(planned), true)
    expect(input.consentExec).toBe(EXEC)
    expect(pluginConsentGiven(planned, input)).toBe(true)
    const moved = plan({ consent_exec: "ff".repeat(32) })
    expect(pluginConsentGiven(moved, input)).toBe(false)
    expect(pluginInstallBlockersOf(moved, input)).toContainEqual({
      kind: "consent",
    })
    expect(
      pluginConsentGiven(planned, setPluginConsent(planned, input, false))
    ).toBe(false)
  })

  it("cannot be given when the plan has no exec hash", () => {
    const planned = plan({ consent_exec: null })
    const input = setPluginConsent(planned, initialPluginInput(planned), true)
    expect(pluginConsentGiven(planned, input)).toBe(false)
  })

  it("reads an autorun part's file by its hash only from an archived package", () => {
    const planned = plan()
    const part = planned.autorun[0]
    expect(autorunFileOf(planned.full, part)?.sha256).toBe("11".repeat(32))
    const fromSource = normalizePluginPlan(
      rawPluginPlan({ full: rawRevision(7, "7.0.1", { archive: null }) })
    )
    expect(autorunFileOf(fromSource.full, part)).toBeNull()
    expect(autorunFileOf(null, part)).toBeNull()
  })
})

describe("what stands in the way", () => {
  it("is nothing once agreed, for the plan's own modes", () => {
    const planned = plan()
    expect(
      pluginInstallBlockersOf(planned, agreed(initialPluginInput(planned)))
    ).toEqual([])
  })

  it("is the item when the plan blocks it or it is installed", () => {
    const blocked = plan({ blocking: [{ code: "item_unavailable" }] })
    expect(
      pluginInstallBlockersOf(blocked, agreed(initialPluginInput(blocked)))
    ).toEqual([{ kind: "item" }])
    const installed = plan({
      installed: {
        name: "superpowers",
        item_id: "itm_superpowers",
        ref: "obra/superpowers",
        revision: 7,
        hosts: {},
        installed_at: "2026-11-20T00:00:00Z",
      },
    })
    expect(
      pluginInstallBlockersOf(installed, agreed(initialPluginInput(installed)))
    ).toContainEqual({ kind: "item" })
  })

  it("is no agent at all", () => {
    const planned = plan({
      hosts: [rawPlanHost("claude_code", { default: "none", planned: "none" })],
      consent_required: false,
      target: 8,
    })
    expect(
      pluginInstallBlockersOf(planned, initialPluginInput(planned))
    ).toEqual([{ kind: "noHosts" }])
  })

  it("is a missing install name or fingerprint", () => {
    const planned = plan({
      install_name: null,
      full: rawRevision(7, "7.0.1", { state_sha256: null }),
    })
    expect(
      pluginInstallBlockersOf(planned, agreed(initialPluginInput(planned)))
    ).toEqual([{ kind: "name" }, { kind: "state" }])
  })

  it("is the withdrawn version until it is accepted", () => {
    const planned = plan({
      snapshot_full: rawSnapshot({ revision: 7, status: "yanked" }),
    })
    const input = agreed(initialPluginInput(planned))
    expect(pluginInstallBlockersOf(planned, input)).toEqual([
      { kind: "yanked" },
    ])
    expect(
      pluginInstallBlockersOf(planned, setPluginAcceptYanked(input, true))
    ).toEqual([])
  })

  it("is a skills row whose skills cannot all go in, or whose preview cannot be read", () => {
    const planned = plan({
      hosts: [
        rawPlanHost("claude_code"),
        rawPlanHost("kiro", {
          skills: rawOwnedPlan("kiro", {
            held: [
              {
                name: "brainstorming",
                path: "/x",
                by: "custom",
                agents: ["kiro"],
              },
            ],
          }),
        }),
        rawPlanHost("cline", { skills: null }),
      ],
    })
    expect(
      pluginInstallBlockersOf(planned, agreed(initialPluginInput(planned)))
    ).toEqual([
      { kind: "agent", agent: "kiro", problem: "blocked" },
      { kind: "agent", agent: "cline", problem: "noPreview" },
    ])
  })
})

describe("the install call", () => {
  it("is not built while anything is open", () => {
    const planned = plan()
    expect(
      pluginInstallArgsOf(
        "obra/superpowers",
        planned,
        initialPluginInput(planned)
      )
    ).toBeNull()
  })

  it("carries the plan's revision, name, fingerprint and every row's mode", () => {
    const planned = plan()
    const args = pluginInstallArgsOf(
      "obra/superpowers",
      planned,
      agreed(initialPluginInput(planned))
    )
    expect(args).toEqual({
      itemRef: "obra/superpowers",
      revision: 7,
      installName: "superpowers",
      hosts: { claude_code: "native", kiro: "skills" },
      stateSha256: FULL_STATE,
      consentExec: EXEC,
      acks: { kiro: { brainstorming: ACK_BRAINSTORMING } },
      expertsAcks: {},
      acceptYanked: false,
    })
  })

  it("sends no agreement when nothing is installed as a plugin", () => {
    const planned = skillsOnly()
    const input: PluginInstallInput = {
      ...initialPluginInput(planned),
      modes: { claude_code: "skills", kiro: "skills" },
      consentExec: EXEC,
    }
    const args = pluginInstallArgsOf("obra/superpowers", planned, input)
    expect(args).toMatchObject({
      revision: 8,
      stateSha256: LATEST_STATE,
      consentExec: null,
      acks: {
        claude_code: { brainstorming: ACK_BRAINSTORMING },
        kiro: { brainstorming: ACK_BRAINSTORMING },
      },
    })
  })

  it("sends the Experts takeover's ack of every agent that has it, not of one set to not at all", () => {
    const planned = plan({
      hosts: [
        rawPlanHost("claude_code", {
          experts_to_take_over: [
            {
              name: "brainstorming",
              path: "/home/u/.claude/skills/brainstorming",
              copy: false,
              agents: ["claude_code", "cursor"],
            },
          ],
          experts_ack: EXPERTS_ACK,
        }),
        rawPlanHost("kiro", {
          default: "none",
          planned: "none",
          skills: null,
          experts_ack: "99".repeat(32),
        }),
      ],
    })
    const args = pluginInstallArgsOf(
      "obra/superpowers",
      planned,
      agreed(initialPluginInput(planned))
    )
    expect(args?.expertsAcks).toEqual({ claude_code: EXPERTS_ACK })
    expect(args?.hosts).toEqual({ claude_code: "native", kiro: "none" })
  })

  it("accepts the withdrawn version only where it was asked and ticked", () => {
    const planned = plan({
      full: rawRevision(7, "7.0.1", { confirm: [{ code: "yanked" }] }),
    })
    const input = setPluginAcceptYanked(
      agreed(initialPluginInput(planned)),
      true
    )
    expect(
      pluginInstallArgsOf("obra/superpowers", planned, input)?.acceptYanked
    ).toBe(true)
    const plain = plan()
    expect(
      pluginInstallArgsOf(
        "obra/superpowers",
        plain,
        setPluginAcceptYanked(agreed(initialPluginInput(plain)), true)
      )?.acceptYanked
    ).toBe(false)
  })
})

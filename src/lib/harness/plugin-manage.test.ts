import { describe, expect, it } from "vitest"

import {
  ACK_BRAINSTORMING,
  EXEC,
  EXPERTS_ACK,
  LATEST_STATE,
  NEW_EXEC,
  rawOwnedPlan,
  rawUpdateHost,
  rawUpdatePlan,
} from "./plugin-install-fixtures"
import {
  normalizePluginInstallResult,
  normalizePluginUpdatePlan,
} from "./plugin-install-normalize"
import {
  EMPTY_UPDATE_INPUT,
  pluginChangeBlockersOf,
  pluginChangeCallOf,
  pluginChangePreflightOf,
  pluginUpdateArgsOf,
  pluginUpdateBlockersOf,
  skillsPlanAcks,
  skillsPlanProblemOf,
  updateTargetOf,
} from "./plugin-manage"

const plan = (overrides: Record<string, unknown> = {}) =>
  normalizePluginUpdatePlan(rawUpdatePlan(overrides))

describe("the update", () => {
  it("goes to the plan's target", () => {
    expect(updateTargetOf(plan())?.revision).toBe(8)
    expect(updateTargetOf(plan({ target: null }))).toBeNull()
  })

  it("needs the agreement to the target's exec, and only that one", () => {
    const shown = plan()
    expect(pluginUpdateBlockersOf(shown, EMPTY_UPDATE_INPUT)).toEqual([
      { kind: "consent" },
    ])
    expect(
      pluginUpdateArgsOf("itm_superpowers", shown, {
        consentExec: EXEC,
        acceptYanked: false,
      })
    ).toBeNull()
    expect(
      pluginUpdateArgsOf("itm_superpowers", shown, {
        consentExec: NEW_EXEC,
        acceptYanked: false,
      })
    ).toEqual({
      itemId: "itm_superpowers",
      revision: 8,
      stateSha256: LATEST_STATE,
      consentExec: NEW_EXEC,
      acks: { gemini: { brainstorming: ACK_BRAINSTORMING } },
      expertsAcks: { gemini: EXPERTS_ACK },
      acceptYanked: false,
    })
  })

  it("sends no agreement where the plan asks none", () => {
    const args = pluginUpdateArgsOf(
      "itm_superpowers",
      plan({ needs_consent: false }),
      { consentExec: NEW_EXEC, acceptYanked: false }
    )
    expect(args?.consentExec).toBeNull()
  })

  it("asks for nothing when every agent is up to date", () => {
    const blockers = pluginUpdateBlockersOf(
      plan({ up_to_date: true, needs_consent: false }),
      EMPTY_UPDATE_INPUT
    )
    expect(blockers).toEqual([{ kind: "upToDate" }])
  })

  it("is held by a blocked plan, a missing target or fingerprint", () => {
    const blockers = pluginUpdateBlockersOf(
      plan({
        blocking: [{ code: "item_unavailable", params: {} }],
        target: null,
        state_sha256: null,
        needs_consent: false,
      }),
      EMPTY_UPDATE_INPUT
    )
    expect(blockers.map((blocker) => blocker.kind)).toEqual([
      "item",
      "target",
      "state",
    ])
  })

  it("asks to confirm a withdrawn target, and sends the tick only then", () => {
    const yanked = plan({
      needs_consent: false,
      full: null,
      latest: {
        ...(rawUpdatePlan().latest as Record<string, unknown>),
        confirm: [{ code: "yanked", params: {} }],
      },
    })
    expect(pluginUpdateBlockersOf(yanked, EMPTY_UPDATE_INPUT)).toEqual([
      { kind: "yanked" },
    ])
    expect(
      pluginUpdateArgsOf("itm_superpowers", yanked, {
        consentExec: null,
        acceptYanked: true,
      })?.acceptYanked
    ).toBe(true)
    expect(
      pluginUpdateArgsOf("itm_superpowers", plan({ needs_consent: false }), {
        consentExec: null,
        acceptYanked: true,
      })?.acceptYanked
    ).toBe(false)
  })

  it("is held by an agent whose links cannot go in", () => {
    const held = plan({
      needs_consent: false,
      hosts: [
        rawUpdateHost("gemini", {
          mode: "skills",
          to_mode: "skills",
          skills: rawOwnedPlan("gemini", {
            held: [{ name: "brainstorming", path: "/x", by: "custom" }],
          }),
        }),
      ],
    })
    expect(pluginUpdateBlockersOf(held, EMPTY_UPDATE_INPUT)).toEqual([
      { kind: "agent", agent: "gemini", problem: "blocked" },
    ])
  })
})

describe("a links preview", () => {
  it("gives its acks by member", () => {
    const update = plan()
    expect(skillsPlanAcks(update.hosts[1].skills)).toEqual({
      brainstorming: ACK_BRAINSTORMING,
    })
    expect(skillsPlanAcks(null)).toEqual({})
  })

  it("says when it cannot be read, or something is in the way", () => {
    const update = plan()
    expect(skillsPlanProblemOf(update.hosts[1].skills)).toBeNull()
    expect(skillsPlanProblemOf(null)).toBeNull()
    const unread = normalizePluginUpdatePlan(
      rawUpdatePlan({
        hosts: [
          rawUpdateHost("gemini", {
            skills: rawOwnedPlan("gemini", { links: null }),
          }),
        ],
      })
    )
    expect(skillsPlanProblemOf(unread.hosts[0].skills)).toBe("noPreview")
  })
})

describe("a change for one agent", () => {
  const preflight = (overrides: Record<string, unknown> = {}) =>
    normalizePluginInstallResult({
      outcome: "preflight",
      issues: [],
      skills: { gemini: rawOwnedPlan("gemini") },
      experts_acks: { gemini: EXPERTS_ACK },
      state_sha256: LATEST_STATE,
      consent_required: false,
      consent_exec: null,
      ...overrides,
    })

  it("asks first with preflight, and nothing else", () => {
    expect(
      pluginChangePreflightOf("itm_superpowers", {
        kind: "mode",
        agent: "gemini",
        mode: "native",
      })
    ).toEqual({
      command: "set_host",
      args: {
        itemId: "itm_superpowers",
        agent: "gemini",
        mode: "native",
        preflight: true,
        stateSha256: null,
        consentExec: null,
        acks: {},
        expertsAck: null,
      },
    })
    expect(
      pluginChangePreflightOf("itm_superpowers", {
        kind: "repair",
        agent: null,
      })
    ).toMatchObject({ command: "repair", args: { preflight: true } })
  })

  it("sends the preflight's acks and fingerprint with a change of mode", () => {
    expect(
      pluginChangeCallOf(
        "itm_superpowers",
        { kind: "mode", agent: "gemini", mode: "skills" },
        preflight(),
        { consentExec: null }
      )
    ).toEqual({
      command: "set_host",
      args: {
        itemId: "itm_superpowers",
        agent: "gemini",
        mode: "skills",
        preflight: false,
        stateSha256: LATEST_STATE,
        consentExec: null,
        acks: { brainstorming: ACK_BRAINSTORMING },
        expertsAck: EXPERTS_ACK,
      },
    })
  })

  it("needs the agreement where the preflight asks it", () => {
    const asks = preflight({ consent_required: true, consent_exec: NEW_EXEC })
    const action = {
      kind: "mode" as const,
      agent: "claude_code",
      mode: "native" as const,
    }
    expect(pluginChangeBlockersOf(action, asks, { consentExec: null })).toEqual(
      [{ kind: "consent" }]
    )
    expect(
      pluginChangeCallOf("itm_superpowers", action, asks, {
        consentExec: EXEC,
      })
    ).toBeNull()
    expect(
      pluginChangeCallOf("itm_superpowers", action, asks, {
        consentExec: NEW_EXEC,
      })?.args
    ).toMatchObject({ consentExec: NEW_EXEC })
  })

  it("cannot install whole without the catalog's fingerprint", () => {
    expect(
      pluginChangeBlockersOf(
        { kind: "mode", agent: "claude_code", mode: "native" },
        preflight({ state_sha256: null }),
        { consentExec: null }
      )
    ).toEqual([{ kind: "state" }])
  })

  it("does nothing after a refused preflight", () => {
    const refused = preflight({ outcome: "refused" })
    expect(
      pluginChangeCallOf(
        "itm_superpowers",
        { kind: "enabled", agent: "gemini", enabled: false },
        refused,
        { consentExec: null }
      )
    ).toBeNull()
  })

  it("switches one agent off with its own acks", () => {
    expect(
      pluginChangeCallOf(
        "itm_superpowers",
        { kind: "enabled", agent: "gemini", enabled: false },
        preflight(),
        { consentExec: null }
      )
    ).toEqual({
      command: "set_enabled",
      args: {
        itemId: "itm_superpowers",
        agent: "gemini",
        enabled: false,
        preflight: false,
        acks: { brainstorming: ACK_BRAINSTORMING },
        expertsAck: EXPERTS_ACK,
      },
    })
  })

  it("repairs with every agent's acks", () => {
    expect(
      pluginChangeCallOf(
        "itm_superpowers",
        { kind: "repair", agent: null },
        preflight(),
        { consentExec: null }
      )
    ).toEqual({
      command: "repair",
      args: {
        itemId: "itm_superpowers",
        agent: null,
        preflight: false,
        acks: { gemini: { brainstorming: ACK_BRAINSTORMING } },
        expertsAcks: { gemini: EXPERTS_ACK },
      },
    })
  })
})

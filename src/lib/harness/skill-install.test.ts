import { describe, expect, it } from "vitest"

import { normalizeVersionState } from "./mcp-install-normalize"
import {
  grownSince,
  initialSkillInput,
  keptAgents,
  setKeepAllowedTools,
  setSkillInstallName,
  skillInstallArgsOf,
  skillInstallBlockersOf,
  skillInstallModeOf,
  skillNameProblemOf,
  toggleSkillAgent,
} from "./skill-install"
import {
  ACK_CODEX,
  ACK_CODEX_RENAMED,
  NEW_STATE,
  rawInstalledSkill,
  rawLinks,
  rawSkillPlan,
  rawSkillSnapshot,
  STATE,
} from "./skill-install-fixtures"
import { normalizeSkillPlan } from "./skill-install-normalize"
import { normalizeApplyResult } from "@/lib/skills/normalize"

const plan = (overrides = {}, asked?: string[]) =>
  normalizeSkillPlan(rawSkillPlan(overrides, asked))

describe("what the dialog starts with", () => {
  it("proposes the plan's name and its linkable default agents, and drops allowed-tools", () => {
    const planned = plan({
      skill: { name: "pdf", allowed_tools: ["Bash(git:*)"] },
      default_agents: ["claude_code", "codex", "kiro"],
    })
    const input = initialSkillInput(planned)
    expect(input).toMatchObject({
      name: "pdf",
      // Kiro has no folder to link into.
      agents: ["claude_code", "codex"],
      keepAllowedTools: false,
      acceptYanked: false,
    })
    expect(skillInstallModeOf(planned)).toBe("install")
  })

  it("keeps an installed skill's name and its agents, and asks again for allowed-tools", () => {
    const planned = plan({
      item: {
        id: "item-pdf",
        ref: "anthropics/pdf",
        kind: "skill",
        title: { en: "PDF Tools" },
        revision: 4,
        version: "1.3.0",
        published_at: "2026-11-15T08:00:00.000Z",
      },
      skill: { name: "pdf", allowed_tools: ["Read"] },
      install_name: {
        name: "pdf",
        default: "pdf-anthropics",
        taken: [],
        pattern: "",
      },
      default_agents: ["codex"],
      installed: rawInstalledSkill({
        name: "pdf-anthropics",
        agents: ["codex"],
        rewrites: { allowed_tools: "kept" },
      }),
    })
    expect(skillInstallModeOf(planned)).toBe("update")
    const input = initialSkillInput(planned)
    expect(input.name).toBe("pdf-anthropics")
    expect(input.agents).toEqual(["codex"])
    // Kept at the last install, but the new version's tools are asked
    // about afresh.
    expect(input.keepAllowedTools).toBe(false)
    const ticked = setKeepAllowedTools(planned, input, true)
    expect(initialSkillInput(planned, ticked).keepAllowedTools).toBe(true)
    expect(keptAgents(planned)).toEqual(["codex"])
    // An agent that sees it keeps it: unticking it does nothing.
    expect(toggleSkillAgent(planned, input, "codex", false)).toBe(input)
    // Nor can the name change.
    expect(setSkillInstallName(planned, input, "other")).toBe(input)
  })

  it("installs the installed revision again as a reinstall", () => {
    expect(skillInstallModeOf(plan({ installed: rawInstalledSkill() }))).toBe(
      "reinstall"
    )
  })
})

describe("the one call the dialog makes", () => {
  it("carries exactly the plan's revision, fingerprint and the acks of the links it showed", () => {
    const planned = plan()
    const input = initialSkillInput(planned)
    expect(
      skillInstallArgsOf(
        "anthropics/pdf",
        planned,
        input,
        null,
        ["claude_code", "codex"],
        null
      )
    ).toEqual({
      itemRef: "anthropics/pdf",
      revision: 3,
      installName: "pdf",
      agents: ["claude_code", "codex"],
      keepAllowedTools: false,
      stateSha256: STATE,
      acks: { codex: ACK_CODEX },
      acceptYanked: false,
    })
  })

  it("is not made while the links shown are not those of the agents ticked", () => {
    const planned = plan()
    const input = toggleSkillAgent(
      planned,
      initialSkillInput(planned),
      "gemini",
      true
    )
    expect(input.agents).toEqual(["claude_code", "codex", "gemini"])
    const asked = ["claude_code", "codex"]
    expect(
      skillInstallArgsOf("anthropics/pdf", planned, input, null, asked, null)
    ).toBeNull()
    expect(
      skillInstallBlockersOf(planned, input, null, asked).map((b) => b.kind)
    ).toEqual(["links"])
  })

  it("sends no ack of the proposed name's links for a name the user typed — only those the install sent back for it", () => {
    const planned = plan()
    const asked = ["claude_code", "codex"]
    const input = setSkillInstallName(
      planned,
      initialSkillInput(planned),
      "pdf-mine"
    )
    expect(
      skillInstallArgsOf("anthropics/pdf", planned, input, null, asked, null)
        ?.acks
    ).toEqual({})
    const relinks = {
      links: normalizeApplyResult(rawLinks(asked, "pdf-mine")),
      name: "pdf-mine",
      agents: asked,
    }
    expect(
      skillInstallArgsOf("anthropics/pdf", planned, input, null, asked, relinks)
        ?.acks
    ).toEqual({ codex: ACK_CODEX_RENAMED })
  })

  it("keeps allowed-tools only where SKILL.md declares it and the user ticked it", () => {
    const declared = plan({ skill: { name: "pdf", allowed_tools: ["Read"] } })
    const asked = ["claude_code", "codex"]
    const input = initialSkillInput(declared)
    const args = (value: typeof input, p = declared) =>
      skillInstallArgsOf("anthropics/pdf", p, value, null, asked, null)
    expect(args(input)?.keepAllowedTools).toBe(false)
    const kept = setKeepAllowedTools(declared, input, true)
    expect(args(kept)?.keepAllowedTools).toBe(true)
    // Nothing declared: nothing to keep, whatever the input says.
    const plain = plan()
    expect(setKeepAllowedTools(plain, initialSkillInput(plain), true)).toEqual(
      initialSkillInput(plain)
    )
    expect(args({ ...kept }, plain)?.keepAllowedTools).toBe(false)
  })

  it("asks for a withdrawn version to be accepted, and sends that only then", () => {
    const yanked = plan({
      confirm: [{ code: "yanked" }],
      snapshot: rawSkillSnapshot({ status: "yanked" }),
    })
    const asked = ["claude_code", "codex"]
    const input = initialSkillInput(yanked)
    expect(
      skillInstallBlockersOf(yanked, input, null, asked).map((b) => b.kind)
    ).toEqual(["yanked"])
    expect(
      skillInstallArgsOf("anthropics/pdf", yanked, input, null, asked, null)
    ).toBeNull()
    expect(
      skillInstallArgsOf(
        "anthropics/pdf",
        yanked,
        { ...input, acceptYanked: true },
        null,
        asked,
        null
      )?.acceptYanked
    ).toBe(true)
    // Ticked, but not asked for: not sent.
    const plain = plan()
    expect(
      skillInstallArgsOf(
        "anthropics/pdf",
        plain,
        { ...initialSkillInput(plain), acceptYanked: true },
        null,
        asked,
        null
      )?.acceptYanked
    ).toBe(false)
  })

  it("confirms the state the catalog reported since, once it was shown", () => {
    const planned = plan()
    const restate = {
      snapshot: normalizeVersionState(rawSkillSnapshot({ risk: "high" })),
      stateSha256: NEW_STATE,
      changes: [],
    }
    expect(
      skillInstallArgsOf(
        "anthropics/pdf",
        planned,
        initialSkillInput(planned),
        restate,
        ["claude_code", "codex"],
        null
      )?.stateSha256
    ).toBe(NEW_STATE)
  })

  it("is not made for an item that cannot be installed, or without a state to confirm", () => {
    const asked = ["claude_code", "codex"]
    const blocked = plan({ blocking: [{ code: "version_blocked" }] })
    expect(
      skillInstallArgsOf(
        "anthropics/pdf",
        blocked,
        initialSkillInput(blocked),
        null,
        asked,
        null
      )
    ).toBeNull()
    const stateless = plan({ state_sha256: null })
    expect(
      skillInstallBlockersOf(
        stateless,
        initialSkillInput(stateless),
        null,
        asked
      ).map((b) => b.kind)
    ).toEqual(["state"])
  })
})

describe("the install name", () => {
  it("checks the rule, and what the plan found holding a name", () => {
    const planned = plan({
      install_name: {
        name: "pdf",
        default: "pdf-anthropics",
        taken: [
          {
            name: "pdf",
            by: "custom",
            pack: null,
            item_id: null,
            item_ref: null,
            path: "/s/pdf",
            agents: [],
          },
          {
            name: "pdf-x",
            by: "agent_dir",
            pack: null,
            item_id: null,
            item_ref: null,
            path: "/a/pdf-x",
            agents: ["codex"],
          },
        ],
        pattern: "^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$",
      },
    })
    expect(skillNameProblemOf(planned, "")).toBe("empty")
    expect(skillNameProblemOf(planned, "PDF")).toBe("invalid")
    expect(skillNameProblemOf(planned, "a--b")).toBe("invalid")
    expect(skillNameProblemOf(planned, "-a")).toBe("invalid")
    expect(skillNameProblemOf(planned, "pdf")).toBe("taken")
    // Something in one agent's folder does not refuse it: that agent is
    // just not linked.
    expect(skillNameProblemOf(planned, "pdf-x")).toBeNull()
    expect(skillNameProblemOf(planned, "pdf-anthropics")).toBeNull()
  })

  it("falls back to Codeg's own rule when the plan's pattern cannot be compiled", () => {
    const planned = plan({
      install_name: { name: "pdf", default: "pdf", taken: [], pattern: "(" },
    })
    expect(skillNameProblemOf(planned, "ok-name")).toBeNull()
    expect(skillNameProblemOf(planned, "Not_OK")).toBe("invalid")
  })
})

describe("what an update asks for that the installed version did not", () => {
  const state = (overrides = {}) =>
    normalizeVersionState(rawSkillSnapshot(overrides))

  it("lists a higher risk and every permission added", () => {
    const before = state({ risk: "low" })
    const after = state({
      risk: "medium",
      permissions: {
        declared: { network: ["api.acme.example", "cdn.acme.example"] },
        detected: { runsCode: ["python"] },
      },
    })
    const growth = grownSince(before, after)
    expect(growth?.complete).toBe(true)
    expect(growth?.grown).toEqual([
      {
        code: "risk_changed",
        params: { from: "low", to: "medium" },
        detail: null,
      },
      {
        code: "permission_added",
        params: {
          profile: "declared",
          field: "network",
          value: "cdn.acme.example",
        },
        detail: null,
      },
      {
        code: "permission_added",
        params: { profile: "detected", field: "runsCode", value: "python" },
        detail: null,
      },
    ])
  })

  it("does not call a lower risk growth, and cannot tell without both states", () => {
    expect(
      grownSince(state({ risk: "high" }), state({ risk: "low" }))?.grown
    ).toEqual([])
    expect(grownSince(null, state())).toBeNull()
    expect(
      grownSince(state({ permissions: undefined }), state())?.complete
    ).toBe(false)
  })
})

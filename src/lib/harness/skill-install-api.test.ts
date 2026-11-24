import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
}))

import { harnessFailureOf, HarnessClientError } from "./errors"
import { harnessInstalled } from "./mcp-install-api"
import {
  harnessSkillInstall,
  harnessSkillPlan,
  harnessSkillUninstall,
} from "./skill-install-api"
import {
  rawInstalledSkill,
  rawSkillInstallResult,
  rawSkillPlan,
  rawSkillUninstallResult,
  STATE,
} from "./skill-install-fixtures"
import {
  normalizeSkillInstallResult,
  normalizeSkillPlan,
  normalizeSkillUninstallResult,
} from "./skill-install-normalize"
import { normalizeInstalled } from "./mcp-install-normalize"

beforeEach(() => {
  mocks.call.mockReset()
})

describe("the skill install commands", () => {
  it("names each command and its arguments as the backend reads them", async () => {
    mocks.call.mockResolvedValue(rawSkillPlan())
    await harnessSkillPlan("anthropics/pdf")
    await harnessSkillPlan("anthropics/pdf", 2, ["claude_code", "codex"])
    mocks.call.mockResolvedValue(rawSkillInstallResult("installed"))
    await harnessSkillInstall({
      itemRef: "anthropics/pdf",
      revision: 3,
      installName: "pdf",
      agents: ["claude_code"],
      keepAllowedTools: false,
      stateSha256: STATE,
      acks: {},
      acceptYanked: false,
    })
    mocks.call.mockResolvedValue(rawSkillUninstallResult("preflight"))
    await harnessSkillUninstall({ itemId: "item-pdf", preflight: true })
    await harnessSkillUninstall({ itemId: "item-pdf", ack: "ab" })
    expect(mocks.call.mock.calls).toEqual([
      [
        "harness_skill_plan",
        { itemRef: "anthropics/pdf", revision: null, agents: null },
      ],
      [
        "harness_skill_plan",
        {
          itemRef: "anthropics/pdf",
          revision: 2,
          agents: ["claude_code", "codex"],
        },
      ],
      [
        "harness_skill_install",
        {
          itemRef: "anthropics/pdf",
          revision: 3,
          installName: "pdf",
          agents: ["claude_code"],
          keepAllowedTools: false,
          stateSha256: STATE,
          acks: {},
          acceptYanked: false,
        },
      ],
      [
        "harness_skill_uninstall",
        { itemId: "item-pdf", preflight: true, ack: null },
      ],
      [
        "harness_skill_uninstall",
        { itemId: "item-pdf", preflight: false, ack: "ab" },
      ],
    ])
  })

  it("refuses an address that cannot be one before it leaves", async () => {
    await expect(harnessSkillPlan("not an address")).rejects.toBeInstanceOf(
      HarnessClientError
    )
    await expect(
      harnessSkillInstall({
        itemRef: "../x",
        revision: 1,
        installName: "x",
        agents: [],
        keepAllowedTools: false,
        stateSha256: "s",
        acks: {},
        acceptYanked: false,
      })
    ).rejects.toBeInstanceOf(HarnessClientError)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("tells an older Codeg without the commands apart: update it", async () => {
    mocks.call.mockRejectedValue("Command harness_skill_plan not found")
    const failure =
      await harnessSkillPlan("anthropics/pdf").catch(harnessFailureOf)
    expect(failure).toEqual({ kind: "unsupported", detail: "" })
  })
})

describe("reading the plan", () => {
  it("keeps what it says, and makes nothing more reassuring", () => {
    const plan = normalizeSkillPlan(
      rawSkillPlan({
        snapshot: { revision: 3, status: "frozen", stateSha256: STATE },
        blocking: [{ code: "something_new", params: { a: "1" } }],
        agents: [
          { agent: "claude_code", link_dir: "/a" },
          { agent: "codex", link_dir: null, installed: "yes" },
          { link_dir: "/nobody" },
        ],
        skill: { name: "pdf", allowed_tools: ["Bash(git:*)", 7] },
      })
    )
    // An unknown status stays as it came; what was left out stays out.
    expect(plan.snapshot).toMatchObject({
      status: "frozen",
      risk: null,
      reviewed: null,
      permissions: null,
      checks: null,
    })
    expect(plan.blocking).toEqual([
      { code: "something_new", params: { a: "1" }, detail: null },
    ])
    // An agent without a name is dropped; one not said to be installed is
    // not taken for one; unsure is "shared" (others may see it).
    expect(plan.agents).toEqual([
      {
        agent: "claude_code",
        installed: null,
        link_dir: "/a",
        link_dir_shared: true,
        sees: false,
        default: false,
      },
      {
        agent: "codex",
        installed: null,
        link_dir: null,
        link_dir_shared: true,
        sees: false,
        default: false,
      },
    ])
    expect(plan.skill.allowed_tools).toEqual(["Bash(git:*)"])
    expect(plan.skill.description).toBe("")
  })

  it("reads an installed skill, its files and its rewrites", () => {
    const plan = normalizeSkillPlan(
      rawSkillPlan({
        installed: rawInstalledSkill({
          state: "changed_locally",
          files: { changed: ["SKILL.md"], added: ["notes.md"], missing: [] },
          rewrites: { name: { from: "pdf", to: "pdf-anthropics" } },
        }),
      })
    )
    expect(plan.installed).toMatchObject({
      name: "pdf",
      state: "changed_locally",
      files: { changed: ["SKILL.md"], added: ["notes.md"], missing: [] },
      rewrites: {
        name: { from: "pdf", to: "pdf-anthropics" },
        allowedTools: null,
      },
    })
  })

  it("refuses an answer it could not show, as invalidResponse", () => {
    for (const value of [
      null,
      [],
      { item: {} },
      rawSkillPlan({ links: "nope" }),
      rawSkillPlan({ install_name: null }),
    ]) {
      expect(() => normalizeSkillPlan(value)).toThrow(HarnessClientError)
    }
  })
})

describe("reading the results", () => {
  it("reads an install's links, skipped links, copies and steps", () => {
    const result = normalizeSkillInstallResult(
      rawSkillInstallResult("installed", {
        links: { outcome: "applied", ok: true, ops: [], issues: [] },
        links_skipped: [
          {
            index: 1,
            skill: "pdf",
            agent: "codex",
            action: "enable",
            status: "blocked",
            issues: [{ code: "target_occupied" }],
          },
          { nonsense: true },
        ],
        copies: { refreshed: ["/c/pdf"], kept_changed: [7], problems: [] },
        phases: [{ phase: "download", status: "done" }, { status: "x" }],
        rewrites: { allowed_tools: "removed" },
      })
    )
    expect(result.links?.outcome).toBe("applied")
    expect(result.links_skipped).toHaveLength(1)
    expect(result.links_skipped[0].issues).toEqual([
      { code: "target_occupied" },
    ])
    expect(result.copies).toEqual({
      refreshed: ["/c/pdf"],
      kept_changed: [],
      problems: [],
    })
    expect(result.phases).toEqual([
      { phase: "download", status: "done", detail: null },
    ])
    expect(result.rewrites).toEqual({ name: null, allowedTools: "removed" })
    expect(() => normalizeSkillInstallResult({ issues: [] })).toThrow(
      HarnessClientError
    )
  })

  it("says the folder is kept wherever it cannot be sure it is not", () => {
    const keptByFiles = normalizeSkillUninstallResult({
      outcome: "preflight",
      files: { changed: ["SKILL.md"] },
    })
    expect(keptByFiles.keeps_folder).toBe(true)
    const unreadable = normalizeSkillUninstallResult({
      outcome: "preflight",
      files_unreadable: "permission denied",
      keeps_folder: false,
    })
    expect(unreadable.keeps_folder).toBe(true)
    const deleted = normalizeSkillUninstallResult(
      rawSkillUninstallResult("preflight")
    )
    expect(deleted.keeps_folder).toBe(false)
    expect(deleted.ack).toBe("ab".repeat(32))
  })
})

describe("harness_installed, part by part", () => {
  it("lists the skills beside the MCP servers, each part with its problem", async () => {
    mocks.call.mockResolvedValue({
      mcp: [],
      skills: [rawInstalledSkill(), { id: "no-name" }],
      mcp_problem: {
        code: "record_unreadable",
        detail: "~/.codeg/harness/mcp.json: expected value at line 1",
      },
      skills_problem: null,
    })
    const installed = await harnessInstalled()
    expect(installed.skills).toHaveLength(1)
    expect(installed.skills[0]).toMatchObject({
      id: "item-pdf",
      name: "pdf",
      state: "as_installed",
      agents: ["claude_code"],
    })
    expect(installed.mcp_problem).toEqual({
      code: "record_unreadable",
      params: {},
      detail: "~/.codeg/harness/mcp.json: expected value at line 1",
    })
    expect(installed.skills_problem).toBeNull()
  })

  it("reads an older Codeg's listing, MCP servers only, as no skills and no problems", () => {
    expect(normalizeInstalled({ mcp: [] })).toEqual({
      mcp: [],
      skills: [],
      mcp_problem: null,
      skills_problem: null,
      plugins: [],
      plugins_problem: null,
    })
  })

  it("keeps a problem it cannot read as a problem", () => {
    expect(
      normalizeInstalled({ mcp: [], skills: [], skills_problem: "broken" })
        .skills_problem
    ).toEqual({ code: "record_unreadable", params: {}, detail: null })
  })
})

import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  SKILLS_ISSUE_CODES,
  SKILLS_OP_STATUSES,
  SKILLS_ORIGINS,
  SKILLS_OWNERS,
} from "@/components/harness/skills/use-skills-labels"
import { freeCopyId, freeId, skillIdProblem } from "./ids"
import { buildModel, cellView, parentOf } from "./model"
import { skillsFailureOf } from "./errors"
import {
  agentSkillFacts,
  normalizeApplyResult,
  normalizeDeleteResult,
  normalizeInventory,
} from "./normalize"
import { deltaOps, mustReview, needsPlanning, opsWithAcks } from "./ops"
import { createEngine, SHARED_DIR, type CellSpec } from "./test-fixtures"
import type { SkillsApplyResult } from "./types"

function world(cells: Record<string, CellSpec>) {
  const engine = createEngine({
    agents: [
      { agent: "claude_code" },
      { agent: "codex", shared: true },
      { agent: "gemini", shared: true },
      { agent: "custom:shared-only", own: false, shared: true },
      { agent: "bare", own: false },
    ],
    skills: [{ id: "x", cells }],
  })
  return buildModel(engine.inventory())
}

const view = (cell: CellSpec, agent = "claude_code", ready = true) => {
  const model = world({ [agent]: cell })
  return cellView(model.cell("x", agent), model.agent(agent), ready)
}

describe("cellView — what a cell is, and what its switch may do", () => {
  it("turns a link in the agent's own folder off without planning", () => {
    expect(view("linked")).toMatchObject({
      kind: "on",
      on: true,
      toggle: "disable",
      check: false,
    })
  })

  it("plans turning off a link seen through a shared folder, and offers 'only for'", () => {
    expect(view("through", "codex")).toMatchObject({
      kind: "through",
      on: true,
      toggle: "disable",
      check: true,
      only: true,
    })
    // An agent with no folder of its own has nowhere to move it.
    expect(view("through", "custom:shared-only")).toMatchObject({ only: false })
  })

  it("plans turning on an agent whose only folder is shared", () => {
    expect(view("off", "custom:shared-only")).toMatchObject({
      toggle: "enable",
      check: true,
    })
    expect(view("off", "codex")).toMatchObject({
      toggle: "enable",
      check: false,
    })
  })

  it("tells copies apart: current, outdated, changed on the agent's side", () => {
    expect(view("copy")).toMatchObject({
      kind: "copy",
      on: true,
      toggle: "disable",
    })
    expect(view("copyOutdated")).toMatchObject({
      kind: "copyOutdated",
      toggle: "disable",
    })
    // The engine never takes a changed copy away: no switch to flip.
    expect(view("copyChanged")).toMatchObject({
      kind: "copyChanged",
      on: true,
      toggle: null,
    })
  })

  it("switches nothing over something in the way, and offers to repair Codeg's broken link", () => {
    expect(view("blocked")).toMatchObject({ kind: "blocked", toggle: null })
    expect(view("elsewhere")).toMatchObject({ kind: "elsewhere", toggle: null })
    expect(view("brokenOther")).toMatchObject({
      kind: "brokenOther",
      brokenPath: null,
    })
    expect(view("broken").brokenPath).toBe("/home/u/.claude_code/skills/x")
  })

  it("says why an off cell cannot be switched on", () => {
    expect(view("off", "bare")).toMatchObject({
      toggle: null,
      why: "noDirectory",
    })
    expect(view("off", "claude_code", false)).toMatchObject({
      toggle: null,
      why: "notReady",
    })
  })

  it("reads a state it does not know as unknown, and never offers to switch it", () => {
    expect(view({ state: "quantum" })).toMatchObject({
      kind: "unknown",
      toggle: null,
    })
  })
})

describe("deltaOps — the fewest ops for a batch", () => {
  it("skips cells already there, and those that cannot be switched", () => {
    const model = world({
      claude_code: "linked",
      codex: "off",
      gemini: "blocked",
      bare: "off",
    })
    const targets = ["claude_code", "codex", "gemini", "bare"].map((agent) => ({
      skill: "x",
      agent,
    }))
    expect(deltaOps(model, targets, true)).toEqual([
      { skill: "x", agent: "codex", action: "enable" },
    ])
    expect(deltaOps(model, targets, false)).toEqual([
      { skill: "x", agent: "claude_code", action: "disable" },
    ])
    // A skill that is not ready is turned on nowhere.
    expect(deltaOps(model, targets, true, () => false)).toEqual([])
  })

  it("never turns off a copy changed on the agent's side", () => {
    const model = world({ claude_code: "copyChanged" })
    expect(
      deltaOps(model, [{ skill: "x", agent: "claude_code" }], false)
    ).toEqual([])
  })

  it("plans whatever may reach another agent", () => {
    const model = world({ codex: "through" })
    expect(
      needsPlanning(model, [{ skill: "x", agent: "codex", action: "disable" }])
    ).toBe(true)
    expect(
      needsPlanning(model, [
        { skill: "x", agent: "claude_code", action: "enable" },
      ])
    ).toBe(false)
    expect(
      needsPlanning(model, [{ skill: "x", agent: "codex", action: "only" }])
    ).toBe(true)
  })
})

describe("acks", () => {
  const plan = (acks: (string | null)[]): SkillsApplyResult => ({
    outcome: "preflight",
    ok: true,
    issues: [],
    ops: acks.map((ack, index) => ({
      index,
      skill: "x",
      agent: "codex",
      action: "disable",
      status: ack ? "needs_ack" : "ready",
      creates: [],
      removes: [],
      moves: [],
      gains: [],
      loses: ack ? ["gemini"] : [],
      touches: [],
      ack,
      issues: [],
      warnings: [],
    })),
  })

  it("carries each op's ack from the plan that was shown, and no other", () => {
    expect(
      opsWithAcks(
        [
          { skill: "x", agent: "codex", action: "disable", ack: "made-up" },
          {
            skill: "y",
            agent: "claude_code",
            action: "refresh",
            replace_modified: true,
          },
        ],
        plan(["shown", null])
      )
    ).toEqual([
      { skill: "x", agent: "codex", action: "disable", ack: "shown" },
      {
        skill: "y",
        agent: "claude_code",
        action: "refresh",
        replace_modified: true,
      },
    ])
  })

  it("shows a plan that reaches others, or stops at something", () => {
    expect(mustReview(plan([null]))).toBe(false)
    expect(mustReview(plan(["shown"]))).toBe(true)
    expect(mustReview({ ...plan([null]), ok: false })).toBe(true)
    expect(mustReview({ ...plan([null]), outcome: "something_new" })).toBe(true)
  })
})

describe("reading answers defensively", () => {
  it("keeps what a newer backend added as unknown strings", () => {
    const inventory = normalizeInventory({
      store: "/s",
      agents: [
        {
          agent: "codex",
          dirs: [
            {
              path: SHARED_DIR,
              role: "new_role",
              shared_with: [],
              exists: true,
            },
          ],
          link_dir: null,
          link_dir_shared: false,
        },
      ],
      skills: [
        {
          id: "x",
          origin: "galaxy",
          path: "/s/x",
          name: "",
          cells: [
            {
              agent: "codex",
              state: "quantum",
              codeg: true,
              entries: [{ path: "/p", kind: "wormhole" }],
            },
          ],
        },
      ],
      extra_field: true,
    })
    expect(inventory.skills[0]).toMatchObject({
      origin: "galaxy",
      name: "x",
      backups: 0,
    })
    expect(inventory.skills[0].cells[0]).toMatchObject({
      state: "quantum",
      copy_matches: null,
    })
    expect(inventory.skills[0].cells[0].entries[0].kind).toBe("wormhole")
    expect(inventory.name_taken).toEqual([])
  })

  it("refuses an answer it cannot work with", () => {
    expect(() => normalizeInventory({ skills: [] })).toThrow()
    expect(() => normalizeApplyResult({ ops: [] })).toThrow()
  })

  it("refuses a delete's answer that says nothing of what it deletes", () => {
    expect(() => normalizeDeleteResult(null)).toThrow()
    expect(
      normalizeDeleteResult({
        deleted: false,
        path: "/p",
        kind: "folder",
        shared_with: ["codex", "codex", "gemini"],
        ack: "a",
      })
    ).toEqual({
      deleted: false,
      path: "/p",
      kind: "folder",
      shared_with: ["codex", "gemini"],
      ack: "a",
    })
  })

  it("reads the agents a refusal names, not as a detail", () => {
    const refusal = (code: string, detail: string) =>
      new Error(
        JSON.stringify({
          code: "invalid_input",
          message: "x",
          i18n_params: { code, detail },
        })
      )
    expect(
      skillsFailureOf(refusal("no_own_directory", "codex, gemini"))
    ).toEqual({
      kind: "coded",
      code: "no_own_directory",
      detail: "",
      agents: ["codex", "gemini"],
    })
    expect(skillsFailureOf(refusal("effects_changed", "cline")).agents).toEqual(
      ["cline"]
    )
    // Any other code keeps its detail as it is.
    expect(skillsFailureOf(refusal("io_error", "denied"))).toMatchObject({
      detail: "denied",
    })
  })

  it("reads an owner it does not know as no owner, keeping the word", () => {
    const facts = agentSkillFacts({ id: "x", owner: "mystery" } as never)
    expect(facts).toMatchObject({
      owner: null,
      ownerRaw: "mystery",
      codegCopy: false,
    })
  })
})

describe("the inventory's problems", () => {
  it("ties a problem to the skill whose folder it is about, and keeps the rest apart", () => {
    const engine = createEngine({
      agents: [{ agent: "claude_code" }],
      skills: [{ id: "writing-plans", origin: "custom" }],
      problems: [
        {
          code: "ownership_unresolved",
          path: "/home/u/.codeg/skills/writing-plans/",
          detail: "experts",
        },
        { code: "manifest_unreadable", path: "/home/u/.codeg/skills/.m.json" },
      ],
    })
    const model = buildModel(engine.inventory())
    expect(model.problemsOf("writing-plans").map((p) => p.code)).toEqual([
      "ownership_unresolved",
    ])
    expect(model.looseProblems.map((p) => p.code)).toEqual([
      "manifest_unreadable",
    ])
    expect(model.unresolved("experts", "writing-plans")?.detail).toBe("experts")
    expect(model.unresolved("science", "writing-plans")).toBeUndefined()
  })
})

describe("names", () => {
  it("follows the backend's rule for a skill's name", () => {
    expect(skillIdProblem("")).toBe("empty")
    expect(skillIdProblem("good-name_1.2")).toBeNull()
    for (const bad of [".hidden", "a/b", "a..b", "white space", "ünï"]) {
      expect(skillIdProblem(bad)).toBe("invalid")
    }
  })

  it("finds a free name", () => {
    expect(freeCopyId("x", new Set())).toBe("x-copy")
    expect(freeCopyId("x", new Set(["x-copy", "x-copy-2"]))).toBe("x-copy-3")
    expect(freeId("x-restored", new Set(["x-restored"]))).toBe("x-restored-2")
  })

  it("cuts a path at its folder, Windows ones included", () => {
    expect(parentOf("/home/u/.claude/skills/x")).toBe("/home/u/.claude/skills")
    expect(parentOf("C:\\Users\\me\\.claude\\skills\\x")).toBe(
      "C:\\Users\\me\\.claude\\skills"
    )
  })
})

describe("wording", () => {
  const skills = enMessages.Harness.skills as Record<string, unknown>
  const words = (group: string) => skills[group] as Record<string, string>

  it("has a message for every code the engine reports", () => {
    for (const code of SKILLS_ISSUE_CODES) {
      expect(words("issues")[code], code).toBeTruthy()
    }
    expect(words("issues").unknown).toBeTruthy()
  })

  it("has words for every status, origin and owner", () => {
    for (const status of SKILLS_OP_STATUSES) {
      expect(words("status")[status], status).toBeTruthy()
    }
    for (const origin of SKILLS_ORIGINS) {
      expect(words("origins")[origin], origin).toBeTruthy()
    }
    for (const owner of SKILLS_OWNERS) {
      expect(words("owners")[owner], owner).toBeTruthy()
    }
  })
})

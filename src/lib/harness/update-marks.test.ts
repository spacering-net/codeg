import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"
import { showOptions as mcpShowOptions } from "@/components/harness/mcp/mcp-toolbar"
import { showOptions as skillsShowOptions } from "@/components/harness/skills/skills-toolbar"
import {
  MCP_HARNESS_REMOTE_STATES,
  marksOf,
  type McpHarnessSeam,
} from "./mcp-marks"
import { normalizeInstalled } from "./mcp-install-normalize"
import { rawInstalledItem } from "./mcp-install-fixtures"
import { rawInstalledSkill } from "./skill-install-fixtures"
import {
  SKILLS_HARNESS_STATES,
  skillMarksOf,
  skillStateOf,
  type SkillsHarnessSeam,
} from "./skills-marks"
import { normalizeHarnessUpdates } from "./updates"

function updates(items: Record<string, unknown>[]) {
  return normalizeHarnessUpdates({
    enabled: true,
    checking: false,
    checked_at: "2026-11-17T09:00:00.000Z",
    attempted_at: "2026-11-17T09:00:00.000Z",
    error: null,
    items,
    count: 0,
  })
}

const entry = (
  id: string,
  revision: number,
  state: string,
  latest: number | null = null
) => ({
  id,
  revision,
  state,
  update_available: latest !== null && latest > revision,
  latest:
    latest === null ? null : { revision: latest, version: `${latest}.0.0` },
  ref: `acme/${id}`,
})

describe("the MCP section's marks", () => {
  const installed = normalizeInstalled({
    mcp: [
      rawInstalledItem({ id: "a", key: "alpha", revision: 3 }),
      rawInstalledItem({ id: "b", key: "beta", revision: 3 }),
      rawInstalledItem({ id: "c", key: "gamma", revision: 3 }),
      rawInstalledItem({ id: "d", key: "delta", revision: 5 }),
    ],
    skills: [],
    mcp_problem: null,
    skills_problem: null,
  })

  it("take the update check's state, and say nothing before there is one", () => {
    const before = marksOf(installed)
    expect([...before.values()].map((mark) => mark.remote)).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect([...before.values()].some((mark) => mark.updateAvailable)).toBe(
      false
    )

    const marks = marksOf(
      installed,
      updates([
        entry("a", 3, "latest", 3),
        entry("b", 3, "update_available", 4),
        entry("c", 3, "yanked", 5),
        // the answer is about the revision before the update the record
        // already shows: no stale "update available"
        entry("d", 4, "update_available", 5),
      ])
    )
    expect(marks.get("alpha")).toMatchObject({
      remote: "latest",
      updateAvailable: false,
    })
    expect(marks.get("beta")).toMatchObject({
      remote: "updateAvailable",
      updateAvailable: true,
    })
    expect(marks.get("gamma")).toMatchObject({
      remote: "yanked",
      updateAvailable: true,
    })
    expect(marks.get("delta")).toMatchObject({
      remote: null,
      updateAvailable: false,
    })
  })

  it("say an item no longer on SRN is gone, with nothing to update to", () => {
    const marks = marksOf(installed, updates([entry("a", 3, "gone")]))
    expect(marks.get("alpha")).toMatchObject({
      remote: "gone",
      updateAvailable: false,
    })
    // asked about another revision than the listing shows (a record kept
    // for an agent this Codeg does not list)
    const other = marksOf(installed, updates([entry("d", 3, "gone")]))
    expect(other.get("delta")).toMatchObject({
      remote: "gone",
      updateAvailable: false,
    })
  })

  it("offer the filter only when something has an update", () => {
    const seam = (marks: McpHarnessSeam["marks"]): McpHarnessSeam => ({
      marks,
      problem: null,
      catalog: true,
    })
    expect(mcpShowOptions(seam(marksOf(installed)))).not.toContain("updates")
    expect(
      mcpShowOptions(
        seam(marksOf(installed, updates([entry("c", 3, "yanked", 5)])))
      )
    ).toContain("updates")
    // switched off: the check says nothing, and nothing is offered
    expect(
      mcpShowOptions(
        seam(
          marksOf(installed, {
            ...updates([entry("b", 3, "update_available", 4)]),
            enabled: false,
          })
        )
      )
    ).not.toContain("updates")
  })
})

describe("the Skills section's marks", () => {
  const skills = normalizeInstalled({
    mcp: [],
    skills: [
      rawInstalledSkill({ id: "s1", name: "one", revision: 2 }),
      rawInstalledSkill({
        id: "s2",
        name: "two",
        revision: 2,
        state: "changed_locally",
      }),
      rawInstalledSkill({ id: "s3", name: "three", revision: 2 }),
    ],
    mcp_problem: null,
    skills_problem: null,
  }).skills

  it("take the update check's state, the folder's own first", () => {
    const marks = skillMarksOf(
      skills,
      updates([
        entry("s1", 2, "update_available", 3),
        entry("s2", 2, "update_available", 3),
        entry("s3", 2, "removed_by_harness"),
      ])
    )
    expect(skillStateOf(marks.get("one")!)).toBe("updateAvailable")
    // changed here says more, and the update is still found by the filter
    expect(skillStateOf(marks.get("two")!)).toBe("changedLocally")
    expect(marks.get("two")!.updateAvailable).toBe(true)
    expect(skillStateOf(marks.get("three")!)).toBe("removedByHarness")
    expect(marks.get("three")!.updateAvailable).toBe(false)

    // no longer on SRN; a folder changed here still says more
    const gone = skillMarksOf(
      skills,
      updates([entry("s2", 2, "gone"), entry("s3", 2, "gone")])
    )
    expect(skillStateOf(gone.get("three")!)).toBe("gone")
    expect(gone.get("three")!.updateAvailable).toBe(false)
    expect(skillStateOf(gone.get("two")!)).toBe("changedLocally")

    const seam: SkillsHarnessSeam = {
      states: new Map(),
      marks,
      problem: null,
      catalog: true,
    }
    expect(skillsShowOptions(true, seam)).toContain("updates")
    expect(
      skillsShowOptions(true, { ...seam, marks: skillMarksOf(skills) })
    ).not.toContain("updates")
  })
})

describe("the marks' labels", () => {
  it("have one for every state a mark can show", () => {
    for (const messages of [enMessages, zhCnMessages]) {
      const mcp: Record<string, string> = messages.Harness.mcp.harness.states
      const skills: Record<string, string> =
        messages.Harness.skills.harnessStates
      for (const state of MCP_HARNESS_REMOTE_STATES) {
        expect(mcp[state], state).toBeTruthy()
      }
      for (const state of SKILLS_HARNESS_STATES) {
        expect(skills[state], state).toBeTruthy()
      }
    }
    expect(enMessages.Harness.mcp.harness.states.gone).toBe("No longer on SRN")
    expect(zhCnMessages.Harness.skills.harnessStates.gone).toBe(
      "SRN 上已没有这一项"
    )
  })
})

import { describe, expect, it } from "vitest"

import type { AgentSkillItem, AvailableCommandInfo } from "@/lib/types"

import {
  buildKnownInvocations,
  commandInputHint,
  commandInvocationToken,
  commandToReference,
  diskSkillTrigger,
  skillMarkedCommands,
  skillsForMenu,
  skillToReference,
} from "./invocation-reference"
import { referenceToMarkdown } from "./reference-text"

const cmd = (name: string): AvailableCommandInfo => ({
  name,
  description: `${name} command`,
})

const skill = (id: string, name: string): AgentSkillItem =>
  ({
    id,
    name,
    scope: "project",
    layout: "markdown_file",
    path: `/skills/${id}.md`,
    description: "desc",
    read_only: false,
  }) as AgentSkillItem

describe("commandToReference", () => {
  it("builds a skill-kind reference that serializes to /name", () => {
    const ref = commandToReference(cmd("build"))
    expect(ref).toEqual({
      refType: "skill",
      id: "build",
      label: "build",
      uri: null,
      meta: { invocationPrefix: "/" },
    })
    expect(referenceToMarkdown(ref)).toBe("/build")
  })

  it("moves the `$` of a Codex skill-as-command into the prefix", () => {
    // codex-acp advertises Codex skills as commands NAMED `$<skill>`; the `$`
    // is the trigger, so the badge must serialize to `$deploy` — never the
    // `/$deploy` a verbatim name+`/` would produce (Codex rejects that form).
    const ref = commandToReference(cmd("$deploy"))
    expect(ref).toEqual({
      refType: "skill",
      id: "deploy",
      label: "deploy",
      uri: null,
      meta: { invocationPrefix: "$" },
    })
    expect(referenceToMarkdown(ref)).toBe("$deploy")
  })
})

describe("commandInvocationToken", () => {
  it("renders `/name` for ordinary commands and the bare `$name` for Codex skills", () => {
    expect(commandInvocationToken("review")).toBe("/review")
    expect(commandInvocationToken("$deploy")).toBe("$deploy")
  })
})

describe("skillToReference", () => {
  it("uses the `$` prefix for a Codex skill and keeps the friendly label", () => {
    const ref = skillToReference(skill("deploy", "Deploy"), "$")
    expect(ref).toMatchObject({
      refType: "skill",
      id: "deploy",
      label: "Deploy",
      uri: null,
      meta: { invocationPrefix: "$", scope: "project" },
    })
    // Serialization uses the id, not the label.
    expect(referenceToMarkdown(ref)).toBe("$deploy")
  })

  it("uses the `/` prefix for a non-Codex skill", () => {
    expect(referenceToMarkdown(skillToReference(skill("x", "X"), "/"))).toBe(
      "/x"
    )
  })

  it("falls back to the id when the skill has no name", () => {
    expect(skillToReference(skill("only-id", ""), "/").label).toBe("only-id")
  })
})

describe("buildKnownInvocations", () => {
  it("keys commands and skills by the token they are sent as", () => {
    const known = buildKnownInvocations(
      [cmd("review"), cmd("$deploy")],
      [skill("ship", "Ship")],
      "$"
    )
    expect([...known].sort()).toEqual(["$deploy", "$ship", "/review"])
  })

  it("uses `/` for skills when no Codex prefix is given", () => {
    expect([...buildKnownInvocations(null, [skill("ship", "Ship")])]).toEqual([
      "/ship",
    ])
  })

  it("is empty for an agent that has advertised nothing yet", () => {
    expect(buildKnownInvocations(null).size).toBe(0)
    expect(buildKnownInvocations([]).size).toBe(0)
  })
})

describe("diskSkillTrigger", () => {
  it("lists Codex's disk skills under its own `$` syntax", () => {
    expect(diskSkillTrigger("codex")).toBe("$")
  })

  // Antigravity's server advertises only /plan, /logout and /usage, so its
  // skills can only come from disk.
  it("lists Antigravity's disk skills under `/`", () => {
    expect(diskSkillTrigger("antigravity")).toBe("/")
  })

  it("scans nothing for an agent that advertises its skills as commands", () => {
    for (const agent of ["claude_code", "kimi_code", "gemini", "custom:x"]) {
      expect(diskSkillTrigger(agent)).toBeNull()
    }
    expect(diskSkillTrigger(null)).toBeNull()
    expect(diskSkillTrigger(undefined)).toBeNull()
  })
})

describe("skillsForMenu", () => {
  const skills = [skill("plan", "Plan"), skill("ship", "Ship")]

  it("leaves out a `/` skill an advertised command shadows", () => {
    expect(
      skillsForMenu(skills, [cmd("plan"), cmd("usage")], "/").map((s) => s.id)
    ).toEqual(["ship"])
  })

  it("keeps every `$` skill, which shares no menu with the commands", () => {
    // Codex advertises a skill as a command named `$ship`, listed under `/`.
    expect(skillsForMenu(skills, [cmd("plan"), cmd("$ship")], "$")).toBe(skills)
  })

  it("keeps every skill while there are no commands to collide with", () => {
    expect(skillsForMenu(skills, [], "/")).toBe(skills)
  })
})

describe("commandInputHint", () => {
  it("returns the agent's argument hint, trimmed", () => {
    expect(
      commandInputHint({ ...cmd("review-branch"), input_hint: " branch name " })
    ).toBe("branch name")
  })

  it("is null when the command advertises nothing to type after it", () => {
    expect(commandInputHint(cmd("compact"))).toBeNull()
    expect(commandInputHint({ ...cmd("compact"), input_hint: null })).toBeNull()
    // The backend maps an input kind it does not know to an empty hint.
    expect(commandInputHint({ ...cmd("compact"), input_hint: "  " })).toBeNull()
  })
})

// claude-agent-acp 0.99.1 marks skills in two passes: the list `session/new`
// sends marks only the ones with a SKILL.md it found on disk, and the list it
// sends once Claude Code's own skill list is read marks them all, the bundled
// ones without a path. Lists recorded live, trimmed.
describe("skillMarkedCommands", () => {
  const userSkill: AvailableCommandInfo = {
    name: "user-skill",
    description: "User skill probe (user)",
    skill: true,
    skill_path: "/home/u/.claude/skills/user-skill/SKILL.md",
  }
  const compact = cmd("compact")

  it("marks every skill of a list made from Claude Code's skill list", () => {
    const read: AvailableCommandInfo[] = [
      userSkill,
      {
        name: "plug:pskill",
        description: "(plug) Plugin skill probe",
        skill: true,
        skill_path: "/home/u/plugins/plug/skills/pskill/SKILL.md",
      },
      { name: "simplify", description: "Review the changed code", skill: true },
      compact,
    ]
    expect([...skillMarkedCommands(read)]).toEqual([
      "user-skill",
      "plug:pskill",
      "simplify",
    ])
  })

  it("marks nothing in a list made before that read", () => {
    const first: AvailableCommandInfo[] = [
      userSkill,
      cmd("plug:pskill"),
      cmd("simplify"),
      compact,
    ]
    expect(skillMarkedCommands(first).size).toBe(0)
  })

  it("marks nothing where no command is marked at all", () => {
    expect(skillMarkedCommands([compact, cmd("review")]).size).toBe(0)
    expect(skillMarkedCommands([]).size).toBe(0)
  })

  it("does not count a path-less entry that is not a skill", () => {
    expect(
      skillMarkedCommands([userSkill, { ...compact, skill: false }]).size
    ).toBe(0)
  })
})

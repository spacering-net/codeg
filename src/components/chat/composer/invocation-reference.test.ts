import { describe, expect, it } from "vitest"

import type { AgentSkillItem, AvailableCommandInfo } from "@/lib/types"

import {
  buildKnownInvocations,
  commandInvocationToken,
  commandToReference,
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

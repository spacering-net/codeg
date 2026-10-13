import { beforeEach, describe, expect, it, vi } from "vitest"

const { getSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getDelegationSettings: (...args: unknown[]) => getSettingsMock(...args),
}))

import type { AcpAgentInfo } from "@/lib/types"

import {
  extractMentionedAgentTypes,
  findBlockedAgentMentions,
  mentionedAgentTypesFromBlocks,
} from "./agent-mention-hint"

describe("extractMentionedAgentTypes", () => {
  it("returns empty for text without agent mentions", () => {
    expect(
      extractMentionedAgentTypes("plain @text and [a link](file://x)")
    ).toEqual([])
  })

  it("does not fire on free-standing @label prose without a routing uri", () => {
    expect(extractMentionedAgentTypes("ask @codex about it")).toEqual([])
  })

  it("extracts the agent_type from a serialized mention", () => {
    expect(
      extractMentionedAgentTypes("请 [@Codex](codeg://agent/codex) 看看")
    ).toEqual(["codex"])
  })

  it("deduplicates repeat mentions and keeps order of first appearance", () => {
    const text = [
      "[@Codex](codeg://agent/codex)",
      "[@Antigravity](codeg://agent/antigravity)",
      "[@Codex again](codeg://agent/codex)",
    ].join(" then ")
    expect(extractMentionedAgentTypes(text)).toEqual(["codex", "antigravity"])
  })

  it("matches the wire form embedded in larger prose", () => {
    expect(
      extractMentionedAgentTypes(
        "see [@Claude](codeg://agent/claude_code) and [@pi](codeg://agent/pi)"
      )
    ).toEqual(["claude_code", "pi"])
  })

  it("scans only text blocks when reading prompt blocks", () => {
    expect(
      mentionedAgentTypesFromBlocks([
        { type: "text", text: "check [@Codex](codeg://agent/codex)" },
        { type: "image", data: "codeg://agent/fake", mime_type: "image/png" },
        { type: "resource", uri: "codeg://agent/also-fake" },
      ])
    ).toEqual(["codex"])
  })
})

describe("findBlockedAgentMentions", () => {
  // Only the shape the classifier reads; the registry snapshot is supplied by
  // the caller (`useAcpAgents`), never fetched here.
  const AGENTS = [
    { agent_type: "codex", name: "Codex", enabled: true },
    { agent_type: "qoder", name: "Qoder", enabled: false },
  ] as unknown as AcpAgentInfo[]

  beforeEach(() => {
    vi.clearAllMocks()
    getSettingsMock.mockResolvedValue({ enabled: true })
  })

  it("short-circuits without mentions and never calls the backend", async () => {
    const blocked = await findBlockedAgentMentions([], AGENTS)
    expect(blocked).toEqual({ delegationOff: false, disabledAgents: [] })
    expect(getSettingsMock).not.toHaveBeenCalled()
  })

  it("reports delegationOff alone when multi-agent delegation is disabled", async () => {
    getSettingsMock.mockResolvedValue({ enabled: false })
    const blocked = await findBlockedAgentMentions(["qoder", "codex"], AGENTS)
    expect(blocked.delegationOff).toBe(true)
    expect(blocked.disabledAgents).toEqual([])
  })

  it("lists only the mentioned agents that are disabled", async () => {
    const blocked = await findBlockedAgentMentions(["qoder", "codex"], AGENTS)
    expect(blocked).toEqual({
      delegationOff: false,
      disabledAgents: [{ type: "qoder", label: "Qoder" }],
    })
  })

  it("returns nothing when every mentioned agent is enabled", async () => {
    const blocked = await findBlockedAgentMentions(["codex"], AGENTS)
    expect(blocked).toEqual({ delegationOff: false, disabledAgents: [] })
  })

  it("re-reads the delegation toggle on every call, so flipping it on stops the hint immediately", async () => {
    getSettingsMock.mockResolvedValueOnce({ enabled: false })
    expect(
      (await findBlockedAgentMentions(["codex"], AGENTS)).delegationOff
    ).toBe(true)
    // The user opened the deep link and turned the switch on. The very next
    // send must not repeat the warning — no TTL window may hide the new value.
    expect(
      (await findBlockedAgentMentions(["codex"], AGENTS)).delegationOff
    ).toBe(false)
    expect(getSettingsMock).toHaveBeenCalledTimes(2)
  })

  it("reports nothing disabled against a cold/empty registry snapshot", async () => {
    const blocked = await findBlockedAgentMentions(["qoder"], [])
    expect(blocked).toEqual({ delegationOff: false, disabledAgents: [] })
  })
})

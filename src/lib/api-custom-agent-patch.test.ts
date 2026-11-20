import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `acp_save_custom_agent` is a FULL REPLACE: a declaration the payload leaves
 * out is cleared, not preserved. So a caller that changes one declaration has
 * to send every other one back — which makes the payload only as fresh as
 * whatever the caller holds.
 *
 * That matters because the custom-agent settings page renders several
 * independent cards over the SAME definition (skills, MCP), each loaded once on
 * mount. A card sending its own snapshot would revert whatever another card
 * saved after it mounted — turn MCP off, flip a skills switch, and codeg-mcp is
 * injected again, which is exactly the failure the MCP toggle exists to fix.
 *
 * `acpPatchCustomAgent` closes that by re-reading the definition immediately
 * before the write and applying only the caller's patch to it. These tests pin
 * both halves: the read-then-write ordering, and the field list (a declaration
 * added to `CustomAgentInfo` without being forwarded here is silently wiped).
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: vi.fn() }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { acpPatchCustomAgent, type CustomAgentInfo } from "@/lib/api"

const STORED: CustomAgentInfo = {
  registryId: "qwen-code",
  agentType: "custom:qwen-code",
  name: "Qwen Code",
  description: "Alibaba's Qwen coding assistant",
  version: "0.21.0",
  distributionKind: "npx",
  spec: { npx: { package: "@qwen-code/qwen-code@0.21.0", cmd: "qwen" } },
  iconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  skillsSharedStore: false,
  skillsDir: "/opt/qwen/skills",
  source: "manual",
  versionProbe: "qwen --version",
  supportsMcp: true,
  modelEnv: { baseUrl: "OPENAI_BASE_URL" },
  launchable: true,
  problem: null,
}

/** Everything the backend replaces wholesale, and must therefore be resent. */
const REPLACED_FIELDS = [
  "name",
  "description",
  "version",
  "distributionKind",
  "spec",
  "iconUrl",
  "skillsSharedStore",
  "skillsDir",
  "source",
  "versionProbe",
  "supportsMcp",
  "modelEnv",
] as const

/**
 * Stand-in for the backend: one stored row, replaced wholesale on save, plus
 * the payloads it received. Mirrors `acp_save_custom_agent`, including
 * `supportsMcp` preserving the stored value when the payload omits it.
 */
function fakeBackend(initial: CustomAgentInfo = STORED) {
  const state = { row: { ...initial }, saves: [] as Record<string, unknown>[] }
  mocks.call.mockImplementation(async (command: string, args: unknown) => {
    if (command === "acp_list_custom_agents") return [{ ...state.row }]
    if (command === "acp_save_custom_agent") {
      const params = (args as { params: Record<string, unknown> }).params
      state.saves.push(params)
      state.row = {
        ...state.row,
        ...(params as Partial<CustomAgentInfo>),
        supportsMcp:
          params.supportsMcp === undefined
            ? state.row.supportsMcp
            : Boolean(params.supportsMcp),
      }
      return undefined
    }
    throw new Error(`unexpected command ${command}`)
  })
  return state
}

describe("acpPatchCustomAgent", () => {
  beforeEach(() => {
    mocks.call.mockReset()
  })

  it("resends every stored declaration, not just the patched one", async () => {
    const backend = fakeBackend()
    await acpPatchCustomAgent("qwen-code", { skillsSharedStore: true })

    expect(backend.saves).toHaveLength(1)
    const params = backend.saves[0]
    expect(params.registryId).toBe("qwen-code")
    // The patch applies...
    expect(params.skillsSharedStore).toBe(true)
    // ...and nothing else moves.
    for (const field of REPLACED_FIELDS) {
      if (field === "skillsSharedStore") continue
      expect(params[field]).toEqual(STORED[field])
    }
  })

  it("reads the definition before writing it, not at mount time", async () => {
    fakeBackend()
    await acpPatchCustomAgent("qwen-code", { supportsMcp: false })
    const commands = mocks.call.mock.calls.map(([command]) => command)
    expect(commands).toEqual([
      "acp_list_custom_agents",
      "acp_save_custom_agent",
    ])
  })

  it("does not let a skills save revert an MCP opt-out made after it loaded", async () => {
    // The exact settings-page sequence: both cards mount over the same
    // definition (supportsMcp: true), the MCP card turns it off, and then the
    // skills card — still holding its pre-toggle view — saves a skills change.
    const backend = fakeBackend()
    await acpPatchCustomAgent("qwen-code", { supportsMcp: false })
    expect(backend.row.supportsMcp).toBe(false)

    await acpPatchCustomAgent("qwen-code", { skillsSharedStore: true })

    expect(backend.row.supportsMcp).toBe(false)
    expect(backend.saves[1].supportsMcp).toBe(false)
    expect(backend.row.skillsSharedStore).toBe(true)
  })

  it("does not let an MCP save revert a skills change made after it loaded", async () => {
    // The mirror image, for the same reason.
    const backend = fakeBackend()
    await acpPatchCustomAgent("qwen-code", { skillsDir: "/srv/skills" })
    expect(backend.row.skillsDir).toBe("/srv/skills")

    await acpPatchCustomAgent("qwen-code", { supportsMcp: false })

    expect(backend.row.skillsDir).toBe("/srv/skills")
    expect(backend.saves[1].skillsDir).toBe("/srv/skills")
    expect(backend.row.supportsMcp).toBe(false)
  })

  it("fails instead of re-creating a definition deleted while the card was open", async () => {
    mocks.call.mockImplementation(async (command: string) => {
      if (command === "acp_list_custom_agents") return []
      throw new Error(`unexpected command ${command}`)
    })
    await expect(
      acpPatchCustomAgent("qwen-code", { supportsMcp: false })
    ).rejects.toThrow(/no longer exists/)
    const commands = mocks.call.mock.calls.map(([command]) => command)
    expect(commands).not.toContain("acp_save_custom_agent")
  })
})

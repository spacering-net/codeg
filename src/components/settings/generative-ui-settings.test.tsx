import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { GenerativeUiSkillInfo } from "@/lib/api"
import type {
  AcpAgentInfo,
  AgentType,
  ExpertInstallStatus,
  ExpertLinkState,
  LinkOp,
  LinkOpResult,
} from "@/lib/types"

const skillInfo = vi.fn<() => Promise<GenerativeUiSkillInfo>>()
const listAgents = vi.fn<() => Promise<AcpAgentInfo[]>>()
const listStatuses = vi.fn<() => Promise<ExpertInstallStatus[]>>()
const applyLinks = vi.fn<(ops: LinkOp[]) => Promise<LinkOpResult[]>>()
const readContent = vi.fn<() => Promise<string>>()
const invalidateSkills = vi.fn()

vi.mock("@/lib/api", () => ({
  generativeUiSkillInfo: () => skillInfo(),
  acpListAgents: () => listAgents(),
  generativeUiListAllInstallStatuses: () => listStatuses(),
  generativeUiApplyLinks: (ops: LinkOp[]) => applyLinks(ops),
  generativeUiReadContent: () => readContent(),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: (agent?: AgentType) => invalidateSkills(agent),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { GenerativeUiBody } from "./generative-ui-settings"

const t = enMessages.GenerativeUiSettings

function agent(
  agentType: AgentType,
  name: string,
  skillsCapable = true
): AcpAgentInfo {
  return {
    agent_type: agentType,
    name,
    skills_capable: skillsCapable,
    env: {},
  } as unknown as AcpAgentInfo
}

function status(agentType: AgentType, state: ExpertLinkState) {
  return {
    expertId: "ui-render",
    agentType,
    state,
    linkPath: "",
    targetPath: null,
    expectedTargetPath: "",
    copyMode: false,
  }
}

/** What is linked on disk: reads return it and applies change it. */
let linked: Map<AgentType, ExpertLinkState>

function renderBody(onRegisterRefresh?: (refresh: () => void) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GenerativeUiBody onRegisterRefresh={onRegisterRefresh} />
    </NextIntlClientProvider>
  )
}

const cell = (agentName: string, state: string) =>
  screen.findByRole("switch", {
    name: `${t.skillName}, ${agentName}: ${state}`,
  })

beforeEach(() => {
  vi.clearAllMocks()
  linked = new Map<AgentType, ExpertLinkState>([
    ["claude_code", "linked_to_codeg"],
    ["codex", "not_linked"],
  ])
  skillInfo.mockResolvedValue({ id: "ui-render", conflict: false })
  listAgents.mockResolvedValue([
    agent("claude_code", "Claude Code"),
    agent("codex", "Codex"),
    agent("custom:no-store", "No Store", false),
  ])
  listStatuses.mockImplementation(async () =>
    Array.from(linked, ([agentType, state]) => status(agentType, state))
  )
  applyLinks.mockImplementation(async (ops) =>
    ops.map((op) => {
      linked.set(op.agentType, op.enable ? "linked_to_codeg" : "not_linked")
      return {
        expertId: op.expertId,
        agentType: op.agentType,
        ok: true,
        status: null,
        error: null,
      }
    })
  )
  readContent.mockResolvedValue("---\nname: ui-render\n---\n# Show it as UI\n")
})

describe("the UI tab", () => {
  it("is one ui-render row with a column per agent that has skills", async () => {
    renderBody()
    expect(await cell("Claude Code", "Enabled")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(await cell("Codex", "Not enabled")).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(screen.queryByRole("switch", { name: /No Store/ })).toBeNull()
    expect(screen.getByText(t.category)).toBeInTheDocument()
    expect(screen.getByText(t.usage)).toBeInTheDocument()
    // One row: nothing to search.
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("enables the skill for one agent with a click", async () => {
    renderBody()
    fireEvent.click(await cell("Codex", "Not enabled"))

    await waitFor(() =>
      expect(applyLinks).toHaveBeenCalledWith([
        { expertId: "ui-render", agentType: "codex", enable: true },
      ])
    )
    expect(await cell("Codex", "Enabled")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(invalidateSkills).toHaveBeenCalledWith("codex")
  })

  it("locks every cell while a skill of the user's holds the name", async () => {
    skillInfo.mockResolvedValue({ id: "ui-render", conflict: true })
    linked = new Map<AgentType, ExpertLinkState>([
      ["claude_code", "not_linked"],
      ["codex", "not_linked"],
    ])
    renderBody()

    await cell("Codex", "Not enabled")
    const cells = screen.getAllByRole("switch")
    expect(cells).toHaveLength(2)
    for (const each of cells) {
      expect(each).toBeDisabled()
      fireEvent.click(each)
    }
    // Nor through the Bulk menu.
    await userEvent.click(
      screen.getByRole("button", {
        name: enMessages.SkillMatrix.everything.label,
      })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: enMessages.SkillMatrix.everything.enable,
      })
    )
    expect(applyLinks).not.toHaveBeenCalled()
    expect(screen.getByText(t.conflict)).toBeInTheDocument()
    expect(screen.getByText(t.badges.nameTaken)).toBeInTheDocument()
  })

  it("says why when it cannot load", async () => {
    skillInfo.mockRejectedValue(new Error("backend unreachable"))
    renderBody()

    expect(await screen.findByText(/backend unreachable/)).toBeInTheDocument()
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("reloads when the hub's Refresh asks it to", async () => {
    let refresh: (() => void) | undefined
    renderBody((fn) => {
      refresh = fn
    })
    await cell("Codex", "Not enabled")
    expect(skillInfo).toHaveBeenCalledTimes(1)

    linked.set("codex", "linked_to_codeg")
    await act(async () => refresh?.())
    expect(await cell("Codex", "Enabled")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(skillInfo).toHaveBeenCalledTimes(2)
  })

  it("keeps a newer load when an earlier one fails late", async () => {
    let refresh: (() => void) | undefined
    renderBody((fn) => {
      refresh = fn
    })
    await cell("Codex", "Not enabled")

    // The first Refresh hangs, a second one answers, then the first fails.
    let failFirst: (err: Error) => void = () => {}
    skillInfo.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failFirst = reject
        })
    )
    await act(async () => refresh?.())
    linked.set("codex", "linked_to_codeg")
    await act(async () => refresh?.())
    expect(await cell("Codex", "Enabled")).toBeInTheDocument()

    await act(async () => failFirst(new Error("stale failure")))
    expect(screen.queryByText(/stale failure/)).toBeNull()
    expect(await cell("Codex", "Enabled")).toBeInTheDocument()
  })

  it("previews the skill the agents get", async () => {
    renderBody()
    fireEvent.click(await screen.findByRole("button", { name: t.skillName }))

    expect(await screen.findByText("Show it as UI")).toBeInTheDocument()
    expect(readContent).toHaveBeenCalledTimes(1)
  })
})

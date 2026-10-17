import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Sparkles } from "lucide-react"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

import { toast } from "sonner"
import enMessages from "@/i18n/messages/en.json"
import {
  SkillAgentMatrix,
  computeLinkDelta,
  statusKey,
  type MatrixSkill,
  type SkillAgentMatrixProps,
} from "./skill-agent-matrix"
import type {
  AcpAgentInfo,
  AgentType,
  ExpertInstallStatus,
  ExpertLinkState,
} from "@/lib/types"

function makeStatus(
  expertId: string,
  agentType: AgentType,
  state: ExpertLinkState
): ExpertInstallStatus {
  return {
    expertId,
    agentType,
    state,
    linkPath: "",
    targetPath: null,
    expectedTargetPath: "",
    copyMode: false,
  }
}

function makeMap(
  statuses: ExpertInstallStatus[]
): Map<string, ExpertInstallStatus> {
  const m = new Map<string, ExpertInstallStatus>()
  for (const s of statuses) m.set(statusKey(s.expertId, s.agentType), s)
  return m
}

const enableable = () => true

describe("computeLinkDelta", () => {
  it("emits only cells that actually change when enabling", () => {
    const statuses = makeMap([
      makeStatus("a", "claude_code", "linked_to_codeg"), // already on
      makeStatus("a", "codex", "not_linked"), // needs enabling
    ])
    const ops = computeLinkDelta(
      [
        { skillId: "a", agentType: "claude_code" },
        { skillId: "a", agentType: "codex" },
      ],
      true,
      statuses,
      enableable
    )
    expect(ops).toEqual([{ expertId: "a", agentType: "codex", enable: true }])
  })

  it("returns [] when nothing needs to change (idempotent)", () => {
    const statuses = makeMap([makeStatus("a", "codex", "linked_to_codeg")])
    expect(
      computeLinkDelta(
        [{ skillId: "a", agentType: "codex" }],
        true,
        statuses,
        enableable
      )
    ).toEqual([])
  })

  it("skips not-ready skills and blocked cells when enabling", () => {
    const statuses = makeMap([
      makeStatus("ready", "codex", "not_linked"),
      makeStatus("blocked", "codex", "blocked_by_real_directory"),
      makeStatus("foreign", "codex", "linked_elsewhere"),
    ])
    const isReady = (id: string) => id !== "notsynced"
    const ops = computeLinkDelta(
      [
        { skillId: "ready", agentType: "codex" },
        { skillId: "blocked", agentType: "codex" },
        { skillId: "foreign", agentType: "codex" },
        { skillId: "notsynced", agentType: "codex" },
      ],
      true,
      statuses,
      isReady
    )
    expect(ops).toEqual([
      { expertId: "ready", agentType: "codex", enable: true },
    ])
  })

  it("disabling only emits currently-enabled cells", () => {
    const statuses = makeMap([
      makeStatus("a", "claude_code", "linked_to_codeg"),
      makeStatus("a", "codex", "not_linked"),
      makeStatus("a", "gemini", "blocked_by_real_directory"),
    ])
    const ops = computeLinkDelta(
      [
        { skillId: "a", agentType: "claude_code" },
        { skillId: "a", agentType: "codex" },
        { skillId: "a", agentType: "gemini" },
      ],
      false,
      statuses,
      enableable
    )
    expect(ops).toEqual([
      { expertId: "a", agentType: "claude_code", enable: false },
    ])
  })
})

// ─── Component ─────────────────────────────────────────────────────────

function agent(agentType: AgentType, name: string): AcpAgentInfo {
  return { agent_type: agentType, name } as unknown as AcpAgentInfo
}

const SKILLS: MatrixSkill[] = [
  {
    id: "brainstorming",
    category: "discovery",
    displayName: "Brainstorming",
    description: "desc",
    icon: Sparkles,
    ready: true,
  },
]

const AGENTS = [agent("claude_code", "Claude Code"), agent("codex", "Codex")]

function renderMatrix(overrides: Partial<SkillAgentMatrixProps> = {}) {
  const props: SkillAgentMatrixProps = {
    skills: SKILLS,
    agents: AGENTS,
    categoryOrder: { discovery: 1 },
    translateCategory: (c) => c,
    translateState: (s) => s,
    loadAllStatuses: vi
      .fn()
      .mockResolvedValue([
        makeStatus("brainstorming", "claude_code", "not_linked"),
        makeStatus("brainstorming", "codex", "not_linked"),
      ]),
    applyLinks: vi.fn().mockResolvedValue([
      {
        expertId: "brainstorming",
        agentType: "claude_code",
        ok: true,
        status: makeStatus("brainstorming", "claude_code", "linked_to_codeg"),
        error: null,
      },
    ]),
    loadContent: vi.fn().mockResolvedValue("# Brainstorming"),
    ...overrides,
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SkillAgentMatrix {...props} />
    </NextIntlClientProvider>
  )
  return props
}

describe("SkillAgentMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("toggles a single cell through applyLinks then reconciles", async () => {
    const props = renderMatrix()
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    fireEvent.click(cell)

    await waitFor(() => {
      expect(props.applyLinks).toHaveBeenCalledTimes(1)
    })
    expect(props.applyLinks).toHaveBeenCalledWith([
      { expertId: "brainstorming", agentType: "claude_code", enable: true },
    ])
    // Mount load + post-batch reconcile.
    await waitFor(() => {
      expect(props.loadAllStatuses).toHaveBeenCalledTimes(2)
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it("notifies onApplied with the touched agents", async () => {
    const onApplied = vi.fn()
    renderMatrix({ onApplied })
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    fireEvent.click(cell)
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledWith(["claude_code"])
    })
  })

  it("shows a single partial-failure toast when an op fails", async () => {
    const applyLinks = vi.fn().mockResolvedValue([
      {
        expertId: "brainstorming",
        agentType: "claude_code",
        ok: false,
        status: null,
        error: "name collision",
      },
    ])
    renderMatrix({ applyLinks })
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    fireEvent.click(cell)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("does not toggle a blocked cell", async () => {
    const applyLinks = vi.fn()
    renderMatrix({
      applyLinks,
      loadAllStatuses: vi
        .fn()
        .mockResolvedValue([
          makeStatus(
            "brainstorming",
            "claude_code",
            "blocked_by_real_directory"
          ),
          makeStatus("brainstorming", "codex", "not_linked"),
        ]),
    })
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: blocked_by_real_directory",
    })
    expect(cell).toBeDisabled()
    fireEvent.click(cell)
    expect(applyLinks).not.toHaveBeenCalled()
  })

  it("disables cells for a not-ready (un-synced) skill", async () => {
    const applyLinks = vi.fn()
    renderMatrix({
      applyLinks,
      skills: [{ ...SKILLS[0], ready: false }],
    })
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    expect(cell).toBeDisabled()
    fireEvent.click(cell)
    expect(applyLinks).not.toHaveBeenCalled()
  })

  it("shows the search box unless told not to", async () => {
    renderMatrix({ searchPlaceholder: "Find a skill" })
    expect(await screen.findByPlaceholderText("Find a skill")).toBeVisible()
  })

  it("leaves the search box out when not searchable", async () => {
    renderMatrix({ searchPlaceholder: "Find a skill", searchable: false })
    await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    expect(screen.queryByPlaceholderText("Find a skill")).toBeNull()
    expect(screen.getByRole("button", { name: /Bulk/ })).toBeVisible()
  })
})

// The optional authoring slots the Custom pack injects. The three curated packs
// pass none of these, so they must be inert unless provided.
describe("SkillAgentMatrix authoring slots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders toolbarActions in the toolbar", async () => {
    renderMatrix({ toolbarActions: <button>SLOT-TOOLBAR</button> })
    expect(await screen.findByText("SLOT-TOOLBAR")).toBeInTheDocument()
  })

  it("appends rowActions inside a row's batch menu", async () => {
    renderMatrix({
      rowActions: (skill) => (
        <DropdownMenuItem>ROW-SLOT-{skill.id}</DropdownMenuItem>
      ),
    })
    // The injected item only exists once the row's ⋯ menu is opened.
    expect(screen.queryByText("ROW-SLOT-brainstorming")).not.toBeInTheDocument()
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Batch actions for Brainstorming",
      })
    )
    expect(
      await screen.findByText("ROW-SLOT-brainstorming")
    ).toBeInTheDocument()
  })

  it("renders bulkActions with the selected ids once a skill is selected", async () => {
    renderMatrix({
      bulkActions: (ids) => <button>BULK-SLOT-{ids.length}</button>,
    })
    // The bulk bar (and its slot) only appears after a selection.
    expect(screen.queryByText(/^BULK-SLOT/)).not.toBeInTheDocument()
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select Brainstorming" })
    )
    expect(await screen.findByText("BULK-SLOT-1")).toBeInTheDocument()
  })

  it("renders no authoring UI when no slots are provided", async () => {
    renderMatrix()
    await screen.findByRole("switch", {
      name: "Brainstorming, Claude Code: not_linked",
    })
    expect(screen.queryByText(/SLOT/)).not.toBeInTheDocument()
  })
})

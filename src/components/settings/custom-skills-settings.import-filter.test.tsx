import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { GenerativeUiSkillInfo } from "@/lib/api"
import type { AcpAgentInfo, AgentSkillItem } from "@/lib/types"

const generativeUiSkillInfo = vi.fn<() => Promise<GenerativeUiSkillInfo>>()

function skill(id: string): AgentSkillItem {
  return {
    id,
    name: id,
    scope: "global",
    layout: "skill_directory",
    path: `/home/me/.claude/skills/${id}`,
    description: null,
    read_only: false,
  } as AgentSkillItem
}

vi.mock("@/lib/api", () => ({
  customList: async () => [],
  customListAllInstallStatuses: async () => [],
  customApplyLinks: async () => [],
  customReadSkill: async () => "",
  customCreateSkill: vi.fn(),
  customDeleteSkills: vi.fn(),
  customDuplicateSkill: vi.fn(),
  customImportFromAgent: vi.fn(),
  customImportSkill: vi.fn(),
  customSaveSkill: vi.fn(),
  acpListAgents: async () =>
    [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        skills_capable: true,
        env: {},
      },
    ] as unknown as AcpAgentInfo[],
  // What Claude's skill folder holds: Codeg's own `ui-render` and an expert
  // (both linked in from the central store), and one skill of the user's.
  acpListAgentSkills: async () => ({
    supported: true,
    message: null,
    locations: [],
    skills: [skill("ui-render"), skill("brainstorming"), skill("my-notes")],
  }),
  expertsList: async () => [{ metadata: { id: "brainstorming" } }],
  scienceList: async () => [],
  officecliListSkills: async () => [],
  generativeUiSkillInfo: () => generativeUiSkillInfo(),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const t = enMessages.CustomSkillsSettings

/** A fresh copy of the module each time: it caches the reserved ids for the
 *  rest of the session. next-intl comes fresh with it, so the provider and the
 *  component share one context. */
async function openImportFromAgent() {
  vi.resetModules()
  const [{ CustomSkillsBody }, { NextIntlClientProvider }] = await Promise.all([
    import("./custom-skills-settings"),
    import("next-intl"),
  ])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CustomSkillsBody />
    </NextIntlClientProvider>
  )
  const button = await screen.findByRole("button", {
    name: t.actions.importFromAgent,
  })
  await vi.waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await screen.findByText("my-notes", { selector: "span" })
}

beforeEach(() => {
  generativeUiSkillInfo.mockReset()
})

describe("importing skills from an agent", () => {
  it("leaves out Codeg's own ui-render, like the other packs' skills", async () => {
    generativeUiSkillInfo.mockResolvedValue({
      id: "ui-render",
      conflict: false,
    })
    await openImportFromAgent()

    expect(screen.queryByText("ui-render", { selector: "span" })).toBeNull()
    expect(screen.queryByText("brainstorming", { selector: "span" })).toBeNull()
  })

  it("still leaves out the other packs' skills when ui-render cannot be asked about", async () => {
    generativeUiSkillInfo.mockRejectedValue(new Error("offline"))
    await openImportFromAgent()

    expect(screen.queryByText("brainstorming", { selector: "span" })).toBeNull()
  })
})

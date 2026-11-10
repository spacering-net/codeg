import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpSaveAgentSkill } from "@/lib/api"
import type { AgentType } from "@/lib/types"
import { SkillsSettings } from "./skills-settings"

const LOCATION = "C:\\Agent Home\\skills"

const state = vi.hoisted(() => ({ agentType: "zcode" as string }))

vi.mock("@/lib/api", () => ({
  acpListAgents: async () => [
    {
      agent_type: state.agentType,
      name: "Agent",
      enabled: true,
      skills_capable: true,
      env: {},
      sort_order: 0,
    },
  ],
  loadFolderHistory: async () => [],
  acpListAgentSkills: async () => ({
    supported: true,
    message: null,
    locations: [{ scope: "global", path: LOCATION, exists: false }],
    skills: [],
  }),
  acpSaveAgentSkill: vi.fn(async () => ({
    id: "new-skill",
    name: "new-skill",
    scope: "global",
    layout: "skill_directory",
    path: `${LOCATION}\\new-skill`,
    read_only: false,
    description: null,
  })),
  acpReadAgentSkill: async () => ({
    skill: {
      id: "new-skill",
      name: "new-skill",
      scope: "global",
      layout: "skill_directory",
      path: `${LOCATION}\\new-skill`,
      read_only: false,
      description: null,
    },
    content: "---\nname: new-skill\ndescription: Test\n---\nbody",
  }),
  acpDeleteAgentSkill: vi.fn(),
  openFolder: vi.fn(),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizableHandle: () => null,
}))

const t = enMessages.SkillsSettings

async function draftNewSkill(agentType: AgentType) {
  state.agentType = agentType
  const user = userEvent.setup()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SkillsSettings />
    </NextIntlClientProvider>
  )
  const create = await screen.findByRole("button", {
    name: t.actions.newSkill,
  })
  await user.click(create)
  await user.type(
    screen.getByPlaceholderText(t.skillIdPlaceholder),
    "new-skill"
  )
  return user
}

describe("new skill authoring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("previews and saves a ZCode directory bundle rather than an unused flat file", async () => {
    const user = await draftNewSkill("zcode")
    expect(
      await screen.findByText(/C:\\Agent Home\\skills\\new-skill\\SKILL\.md/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: t.actions.save }))
    await waitFor(() => {
      expect(acpSaveAgentSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "zcode",
          scope: "global",
          skillId: "new-skill",
          layout: "skill_directory",
        })
      )
      expect(toast.success).toHaveBeenCalledWith(t.toasts.created)
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  // These stores take only `<id>/SKILL.md` bundles, so the backend writes one
  // whatever layout is sent; the preview has to name that same file.
  it.each(["trae", "kimi_code", "command_code", "custom:my-agent"] as const)(
    "previews the bundle %s actually gets",
    async (agentType) => {
      await draftNewSkill(agentType)
      expect(
        await screen.findByText(/C:\\Agent Home\\skills\\new-skill\\SKILL\.md/)
      ).toBeInTheDocument()
    }
  )

  it("keeps pi's flat-file default", async () => {
    await draftNewSkill("pi")
    expect(
      await screen.findByText(/C:\\Agent Home\\skills\\new-skill\.md/)
    ).toBeInTheDocument()
  })
})

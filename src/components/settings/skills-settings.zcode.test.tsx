import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpSaveAgentSkill } from "@/lib/api"
import { SkillsSettings } from "./skills-settings"

vi.mock("@/lib/api", () => ({
  acpListAgents: async () => [
    {
      agent_type: "zcode",
      name: "ZCode",
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
    locations: [
      { scope: "global", path: "C:\\Native ZCode\\skills", exists: false },
    ],
    skills: [],
  }),
  acpSaveAgentSkill: vi.fn(async () => ({
    id: "new-skill",
    name: "new-skill",
    scope: "global",
    layout: "skill_directory",
    path: "C:\\Native ZCode\\skills\\new-skill",
    read_only: false,
    description: null,
  })),
  acpReadAgentSkill: async () => ({
    skill: {
      id: "new-skill",
      name: "new-skill",
      scope: "global",
      layout: "skill_directory",
      path: "C:\\Native ZCode\\skills\\new-skill",
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

describe("ZCode Skills authoring", () => {
  it("previews and saves a directory bundle rather than an unused flat file", async () => {
    const user = userEvent.setup()
    const t = enMessages.SkillsSettings
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
    expect(
      await screen.findByText(/C:\\Native ZCode\\skills\\new-skill\\SKILL\.md/)
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
})

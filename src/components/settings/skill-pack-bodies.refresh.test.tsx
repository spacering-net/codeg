import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentType } from "react"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AcpAgentInfo } from "@/lib/types"

// Each body lists its pack's skills; the first answer of each is held back
// when a test asks for it.
const lists = vi.hoisted(() => ({
  experts: vi.fn(),
  science: vi.fn(),
  custom: vi.fn(),
}))

const metadata = (id: string, name: string) => ({
  id,
  category: "planning",
  icon: null,
  sort_order: 0,
  featured: false,
  accent: null,
  needs_key: false,
  needs_env: false,
  display_name: { en: name },
  description: { en: "" },
  bundled_hash: "",
})

vi.mock("@/lib/api", () => ({
  acpListAgents: async () =>
    [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        skills_capable: true,
        env: {},
      },
    ] as unknown as AcpAgentInfo[],
  expertsList: () => lists.experts(),
  expertsListAllInstallStatuses: async () => [],
  expertsApplyLinks: async () => [],
  expertsReadContent: async () => "",
  scienceList: () => lists.science(),
  scienceListAllInstallStatuses: async () => [],
  scienceApplyLinks: async () => [],
  scienceReadContent: async () => "",
  customList: () => lists.custom(),
  customListAllInstallStatuses: async () => [],
  customApplyLinks: async () => [],
  customReadSkill: async () => "",
  customCreateSkill: vi.fn(),
  customDeleteSkills: vi.fn(),
  customDuplicateSkill: vi.fn(),
  customImportFromAgent: vi.fn(),
  customImportSkill: vi.fn(),
  customSaveSkill: vi.fn(),
  acpListAgentSkills: vi.fn(),
  officecliListSkills: async () => [],
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

import { CustomSkillsBody } from "./custom-skills-settings"
import { ExpertsBody } from "./experts-settings"
import { ScienceBody } from "./science-settings"

type Body = ComponentType<{ onRegisterRefresh?: (fn: () => void) => void }>

const PACKS: {
  name: string
  Body: Body
  list: Mock
  item: (name: string) => unknown
}[] = [
  {
    name: "Experts",
    Body: ExpertsBody,
    list: lists.experts,
    item: (name) => ({
      metadata: metadata(name.toLowerCase(), name),
      installed_centrally: true,
      user_modified: false,
      central_path: "",
    }),
  },
  {
    name: "Science",
    Body: ScienceBody,
    list: lists.science,
    item: (name) => ({
      metadata: metadata(name.toLowerCase(), name),
      installed_centrally: true,
      user_modified: false,
      central_path: "",
    }),
  },
  {
    name: "Custom",
    Body: CustomSkillsBody,
    list: lists.custom,
    item: (name) => ({
      id: name.toLowerCase(),
      name,
      description: null,
      central_path: "",
    }),
  },
]

beforeEach(() => {
  for (const list of Object.values(lists)) list.mockReset()
})

describe.each(PACKS)("the $name tab", ({ Body, list, item }) => {
  it("keeps a newer load when an earlier one fails late", async () => {
    list.mockResolvedValue([item("Original")])
    let refresh: (() => void) | undefined
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Body
          onRegisterRefresh={(fn) => {
            refresh = fn
          }}
        />
      </NextIntlClientProvider>
    )
    await screen.findByText("Original")

    // The first Refresh hangs, a second one answers, then the first fails.
    let failFirst: (err: Error) => void = () => {}
    list.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failFirst = reject
        })
    )
    await act(async () => refresh?.())
    list.mockResolvedValue([item("Newer")])
    await act(async () => refresh?.())
    expect(await screen.findByText("Newer")).toBeInTheDocument()

    await act(async () => failFirst(new Error("stale failure")))
    expect(screen.queryByText(/stale failure/)).toBeNull()
    expect(await screen.findByText("Newer")).toBeInTheDocument()
  })
})

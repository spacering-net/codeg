import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  routes: [] as string[],
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.call,
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      const set = mocks.listeners.get(event) ?? new Set()
      set.add(handler)
      mocks.listeners.set(event, set)
      return () => set.delete(handler)
    },
  }),
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openUrl: async () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))
vi.mock("@/lib/api", () => ({ openSettingsWindow: async () => {} }))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({
    setRoute: (route: string) => mocks.routes.push(route),
  }),
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { __resetHarnessStatusForTests } from "@/lib/harness/status"
import { rawInstalledItem } from "@/lib/harness/mcp-install-fixtures"
import {
  rawInstalledSkill,
  rawSkillPlan,
} from "@/lib/harness/skill-install-fixtures"
import { rawDetail } from "@/lib/harness/test-fixtures"
import {
  agent,
  entry,
  inventory,
  resetFingerprints,
  stdio,
} from "@/lib/mcp/test-fixtures"
import { DiscoverSection } from "../discover/discover-section"
import { McpSection } from "../mcp/mcp-section"
import { HarnessInstallDialogs } from "./harness-install-dialogs"

type Args = Record<string, unknown> | undefined
let backend: Record<string, (args: Args) => unknown>
const callsOf = (command: string) =>
  mocks.call.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>)

type View = ReturnType<typeof useHarnessView>
let view: View
function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function Harness({ section }: { section: "discover" | "mcp" }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        {section === "discover" ? <DiscoverSection /> : <McpSection />}
        <HarnessInstallDialogs />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

const publisher = {
  handle: "anthropics",
  name: "Anthropic",
  kind: "github",
  verified: true,
  unclaimed: false,
  avatar: null,
}

const skillItem = (overrides: Record<string, unknown> = {}) =>
  rawDetail({
    id: "item-pdf",
    ref: "anthropics/pdf",
    name: "pdf",
    kind: "skill",
    title: { en: "PDF Tools" },
    readme: null,
    publisher,
    latest: {
      revision: 3,
      version: "1.2.0",
      publishedAt: "2026-11-10T08:00:00.000Z",
    },
    ...overrides,
  })

const mcpItem = () =>
  rawDetail({
    id: "item-notes",
    ref: "acme.dev/notes",
    name: "notes",
    kind: "mcp",
    title: { en: "Acme Notes" },
    readme: null,
    publisher: { ...publisher, handle: "acme.dev", name: "Acme" },
    latest: {
      revision: 3,
      version: "1.2.0",
      publishedAt: "2026-11-10T08:00:00.000Z",
    },
  })

beforeEach(() => {
  localStorage.clear()
  mocks.listeners.clear()
  mocks.routes.length = 0
  resetFingerprints()
  __resetHarnessStatusForTests()
  backend = {
    harness_status: () => ({ enabled: true, origin: "https://spacering.net" }),
    harness_item: () => skillItem(),
    harness_versions: () => [],
    harness_skill_plan: (args) =>
      rawSkillPlan({}, (args?.agents as string[] | null) ?? null),
    harness_installed: () => ({ mcp: [], skills: [] }),
  }
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
})

async function openItem(itemRef: string) {
  render(<Harness section="discover" />)
  act(() => {
    view.open({ section: "discover", itemRef })
  })
  return screen.findByRole("article")
}

describe("Installing a skill from Discover", () => {
  it("offers Install on a skill's detail, which opens the dialog and installs nothing", async () => {
    const user = userEvent.setup()
    await openItem("anthropics/pdf")
    await user.click(await screen.findByRole("button", { name: "Install" }))
    expect(
      await screen.findByRole("heading", { name: "Install PDF Tools" })
    ).toBeInTheDocument()
    expect(callsOf("harness_skill_plan")[0]).toEqual({
      itemRef: "anthropics/pdf",
      revision: null,
      agents: null,
    })
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })

  it("for an installed skill, offers Update when a newer revision is out, and Manage agents in Skills", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      skillItem({
        latest: {
          revision: 4,
          version: "1.3.0",
          publishedAt: "2026-11-15T08:00:00.000Z",
        },
      })
    backend.harness_installed = () => ({
      mcp: [],
      skills: [rawInstalledSkill({ name: "pdf-anthropics" })],
    })
    await openItem("anthropics/pdf")
    await screen.findByRole("button", { name: "Update" })
    expect(screen.getByText("Installed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Manage agents" }))
    // The Skills section, on the skill under its install name.
    expect(mocks.routes).toContain("harness")
    expect(view.section).toBe("skills")
    expect(view.pendingTarget).toEqual({
      section: "skills",
      skillId: "pdf-anthropics",
    })
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })

  it("keeps to Manage agents where no newer revision is out", async () => {
    backend.harness_installed = () => ({
      mcp: [],
      skills: [rawInstalledSkill()],
    })
    await openItem("anthropics/pdf")
    await screen.findByRole("button", { name: "Manage agents" })
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()
  })
})

describe("A record that cannot be read, part by part", () => {
  const SKILLS_PROBLEM = {
    code: "record_unreadable",
    detail: "/home/u/.codeg/skills/.manifest.harness.json: EOF",
  }
  const MCP_PROBLEM = {
    code: "record_unreadable",
    detail: "/home/u/.codeg/harness/mcp.json: EOF",
  }

  it("says so on a skill's detail, while the MCP servers still show as installed", async () => {
    backend.harness_installed = () => ({
      mcp: [rawInstalledItem()],
      skills: [],
      mcp_problem: null,
      skills_problem: SKILLS_PROBLEM,
    })
    await openItem("anthropics/pdf")
    expect(
      await screen.findByText(
        /Codeg could not read its record of the skills it installed from SRN Harness/
      )
    ).toBeInTheDocument()
    expect(screen.getByText(SKILLS_PROBLEM.detail)).toBeInTheDocument()
    // The MCP part is listed as usual.
    backend.harness_item = () => mcpItem()
    act(() => {
      view.open({ section: "discover", itemRef: "acme.dev/notes" })
    })
    expect(
      await screen.findByRole("button", { name: "Manage agents" })
    ).toBeInTheDocument()
    expect(screen.getByText("Installed")).toBeInTheDocument()
    expect(
      screen.queryByText(/could not read its record of the skills/)
    ).toBeNull()
  })

  it("says so on an MCP server's detail, while the skills still show as installed", async () => {
    backend.harness_installed = () => ({
      mcp: [],
      skills: [rawInstalledSkill()],
      mcp_problem: MCP_PROBLEM,
      skills_problem: null,
    })
    backend.harness_item = () => mcpItem()
    await openItem("acme.dev/notes")
    expect(
      await screen.findByText(
        /Codeg could not read its record of the MCP servers it installed from SRN Harness/
      )
    ).toBeInTheDocument()
    backend.harness_item = () => skillItem()
    act(() => {
      view.open({ section: "discover", itemRef: "anthropics/pdf" })
    })
    expect(
      await screen.findByRole("button", { name: "Manage agents" })
    ).toBeInTheDocument()
  })

  it("says so over the MCP section's list, which is still listed", async () => {
    backend.harness_installed = () => ({
      mcp: [],
      skills: [],
      mcp_problem: MCP_PROBLEM,
      skills_problem: null,
    })
    backend.mcp_inventory = () =>
      inventory([agent("claude_code", [entry("files", stdio("files-mcp"))])])
    render(<Harness section="mcp" />)
    expect(
      await screen.findByText(
        /Codeg could not read its record of the MCP servers/
      )
    ).toBeInTheDocument()
    expect(screen.getByText(MCP_PROBLEM.detail)).toBeInTheDocument()
    expect(
      await screen.findByRole("button", { name: /files/ })
    ).toBeInTheDocument()
  })

  it("from an older Codeg that rejects the whole listing, says the MCP part's problem", async () => {
    backend.harness_installed = () => {
      throw {
        code: "harness_error",
        message: "record unreadable",
        detail: "mcp.json: EOF",
        i18n_key: "Harness.errors.recordUnreadable",
      }
    }
    backend.mcp_inventory = () =>
      inventory([agent("claude_code", [entry("files", stdio("files-mcp"))])])
    render(<Harness section="mcp" />)
    expect(
      await screen.findByText(
        /Codeg could not read its record of the MCP servers/
      )
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText("mcp.json: EOF")).toBeInTheDocument()
    )
    expect(within(document.body).queryByText(/of the skills/)).toBeNull()
  })
})

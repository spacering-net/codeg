import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  handle: null as
    | null
    | ((command: string, args?: Record<string, unknown>) => unknown),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: async (command: string, args?: Record<string, unknown>) =>
      mocks.handle?.(command, args),
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      const set = mocks.listeners.get(event) ?? new Set()
      set.add(handler)
      mocks.listeners.set(event, set)
      return () => set.delete(handler)
    },
    onReconnect: () => () => {},
  }),
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => true,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  isLocalDesktop: () => true,
  revealItemInDir: async () => {},
  openUrl: async () => {},
  subscribe: async () => () => {},
  onTransportReconnect: () => () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { SKILLS_SELECTED } from "@/lib/harness/skills-state"
import {
  rawInstalledSkill,
  rawSkillPlan,
  rawSkillUninstallResult,
} from "@/lib/harness/skill-install-fixtures"
import { createEngine, type Engine } from "@/lib/skills/test-fixtures"
import { HarnessInstallDialogs } from "../install/harness-install-dialogs"
import { SkillsSection } from "./skills-section"

type Args = Record<string, unknown> | undefined

type View = ReturnType<typeof useHarnessView>
let view: View
function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function Harness({ discoverEnabled = true }: { discoverEnabled?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider discoverEnabled={discoverEnabled}>
        <Capture />
        <SkillsSection />
        <HarnessInstallDialogs />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

let engine: Engine
let harness: Record<string, (args: Args) => unknown>
const calls: { command: string; args: Args }[] = []
const callsOf = (command: string) =>
  calls.filter((call) => call.command === command).map((call) => call.args)

beforeEach(() => {
  localStorage.clear()
  mocks.listeners.clear()
  calls.length = 0
  engine = createEngine({
    agents: [
      { agent: "claude_code" },
      { agent: "codex", shared: true },
      { agent: "gemini", shared: true },
    ],
    skills: [
      {
        id: "my-flow",
        origin: "custom",
        name: "My flow",
        cells: { claude_code: "linked" },
      },
      {
        id: "pdf",
        origin: "harness",
        name: "PDF tools",
        harness: { ref: "anthropics/pdf", version: "1.2.0" },
        cells: { claude_code: "linked" },
      },
    ],
  })
  harness = {
    harness_installed: () => ({
      mcp: [],
      skills: [
        rawInstalledSkill({
          state: "changed_locally",
          files: { changed: ["SKILL.md"], added: [], missing: [] },
        }),
        rawInstalledSkill({
          id: "item-gone",
          ref: "acme/gone",
          name: "gone",
          version: "0.3.0",
          state: "missing",
          agents: [],
          files: { changed: [], added: [], missing: ["SKILL.md"] },
        }),
      ],
      mcp_problem: null,
      skills_problem: null,
    }),
    harness_skill_plan: (args) =>
      rawSkillPlan({}, (args?.agents as string[] | null) ?? null),
    harness_skill_uninstall: () => rawSkillUninstallResult("preflight"),
  }
  mocks.handle = (command, args) => {
    calls.push({ command, args })
    const handler = harness[command]
    if (handler) return handler(args)
    return engine.handle(command, args)
  }
})

afterEach(() => {
  mocks.handle = null
})

async function openSkill(name: string) {
  await userEvent.click(await screen.findByRole("button", { name }))
  return screen.findByRole("article")
}

describe("SkillsSection — skills from Harness", () => {
  it("marks a Harness skill with its version and how its folder stands", async () => {
    render(<Harness />)
    expect(
      (await screen.findAllByText("SRN Harness 1.2.0")).length
    ).toBeGreaterThan(0)
    expect(await screen.findByText("Changed here")).toBeInTheDocument()
    const article = await openSkill("PDF tools")
    expect(article).toHaveTextContent("Version 1.2.0, revision 3")
    expect(article).toHaveTextContent("SKILL.md")
    expect(article).toHaveTextContent(
      "An update or an uninstall keeps your changes in Codeg's backups."
    )
    expect(
      within(article).getByRole("button", { name: "Update…" })
    ).toBeInTheDocument()
    expect(
      within(article).getByRole("button", { name: "Uninstall…" })
    ).toBeInTheDocument()
  })

  it("Update opens the install dialog on the newest revision, which only plans", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const article = await openSkill("PDF tools")
    await user.click(within(article).getByRole("button", { name: "Update…" }))
    expect(
      await screen.findByRole("heading", { name: /PDF Tools/ })
    ).toBeInTheDocument()
    expect(callsOf("harness_skill_plan")[0]).toEqual({
      itemRef: "anthropics/pdf",
      revision: null,
      agents: null,
    })
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })

  it("Uninstall asks what it would do first, and removes nothing yet", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const article = await openSkill("PDF tools")
    await user.click(
      within(article).getByRole("button", { name: "Uninstall…" })
    )
    expect(
      await screen.findByRole("heading", { name: "Uninstall pdf" })
    ).toBeInTheDocument()
    expect(callsOf("harness_skill_uninstall")).toEqual([
      { itemId: "item-pdf", preflight: true, ack: null },
    ])
  })

  it("lists a Harness skill whose folder is gone, still to be updated or uninstalled", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const list = await screen.findByRole("region", {
      name: "From SRN Harness, folder missing",
    })
    await user.click(within(list).getByRole("button", { name: /gone/ }))
    const article = await screen.findByRole("article")
    expect(article).toHaveTextContent("Its folder is gone from Codeg's store.")
    expect(
      within(article).getByRole("button", { name: "Uninstall…" })
    ).toBeInTheDocument()
    expect(
      within(article).getByRole("button", { name: "Update…" })
    ).toBeInTheDocument()
  })

  it("says the record cannot be read where the marks would be, and the rest still works", async () => {
    harness.harness_installed = () => ({
      mcp: [],
      skills: [],
      mcp_problem: null,
      skills_problem: {
        code: "record_unreadable",
        detail: "/home/u/.codeg/skills/.manifest.harness.json: EOF",
      },
    })
    render(<Harness />)
    expect(
      await screen.findByText(
        /Codeg could not read its record of the skills it installed from SRN Harness/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("/home/u/.codeg/skills/.manifest.harness.json: EOF")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "My flow" })).toBeInTheDocument()
    const article = await openSkill("PDF tools")
    expect(
      within(article).queryByRole("button", { name: "Update…" })
    ).toBeNull()
  })

  it("where Harness is switched off, offers uninstalling but not updating", async () => {
    render(<Harness discoverEnabled={false} />)
    const article = await openSkill("PDF tools")
    expect(
      within(article).getByRole("button", { name: "Uninstall…" })
    ).toBeInTheDocument()
    expect(
      within(article).queryByRole("button", { name: "Update…" })
    ).toBeNull()
    expect(article).toHaveTextContent(
      "SRN Harness is switched off on this host: it can be uninstalled, not updated."
    )
  })

  it("from a Codeg that cannot list what it installed, shows no Harness actions", async () => {
    harness.harness_installed = () => {
      throw "Command harness_installed not found"
    }
    render(<Harness />)
    const article = await openSkill("PDF tools")
    await waitFor(() => expect(callsOf("harness_installed").length).toBe(1))
    expect(article).toHaveTextContent(
      "Installed from SRN Harness, and read only"
    )
    expect(
      within(article).queryByRole("button", { name: "Update…" })
    ).toBeNull()
    expect(
      within(article).queryByRole("button", { name: "Uninstall…" })
    ).toBeNull()
  })

  it("opens a skill asked for by its install name", async () => {
    render(<Harness />)
    await screen.findByRole("button", { name: "My flow" })
    act(() => {
      view.open({ section: "skills", skillId: "pdf" })
    })
    await waitFor(() => expect(view.slots.get(SKILLS_SELECTED)).toBe("pdf"))
    expect(await screen.findByRole("article")).toHaveTextContent("PDF tools")
  })
})

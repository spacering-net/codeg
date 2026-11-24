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
import {
  rawApply,
  rawInstalledAgent,
  rawInstalledItem,
  rawPlan,
} from "@/lib/harness/mcp-install-fixtures"
import { rawSkillPlan } from "@/lib/harness/skill-install-fixtures"
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
const last = <T,>(list: T[]): T => list[list.length - 1]
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

function Harness({
  section,
  discoverEnabled = true,
}: {
  section: "discover" | "mcp"
  discoverEnabled?: boolean
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider discoverEnabled={discoverEnabled}>
        <Capture />
        {section === "discover" ? <DiscoverSection /> : <McpSection />}
        <HarnessInstallDialogs />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

const mcpItem = (overrides: Record<string, unknown> = {}) =>
  rawDetail({
    id: "item-notes",
    ref: "acme.dev/notes",
    name: "notes",
    kind: "mcp",
    title: { en: "Acme Notes" },
    readme: null,
    publisher: {
      handle: "acme.dev",
      name: "Acme",
      kind: "github",
      verified: false,
      unclaimed: false,
      avatar: null,
    },
    latest: {
      revision: 3,
      version: "1.2.0",
      publishedAt: "2026-11-10T08:00:00.000Z",
    },
    ...overrides,
  })

beforeEach(() => {
  localStorage.clear()
  mocks.listeners.clear()
  mocks.routes.length = 0
  resetFingerprints()
  __resetHarnessStatusForTests()
  backend = {
    harness_status: () => ({ enabled: true, origin: "https://spacering.net" }),
    harness_item: () => mcpItem(),
    harness_versions: () => [],
    harness_mcp_plan: () => rawPlan(),
    harness_installed: () => ({ mcp: [] }),
  }
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
})

// ─── Discover ─────────────────────────────────────────────────────────

describe("Installing from Discover", () => {
  it("offers Install on an MCP server's detail, which opens the dialog and installs nothing", async () => {
    const user = userEvent.setup()
    render(<Harness section="discover" />)
    act(() => {
      view.open({ section: "discover", itemRef: "acme.dev/notes" })
    })
    await user.click(await screen.findByRole("button", { name: "Install" }))
    expect(
      await screen.findByRole("heading", { name: "Install Acme Notes" })
    ).toBeInTheDocument()
    expect(callsOf("harness_mcp_plan")).toEqual([
      { itemRef: "acme.dev/notes", revision: null },
    ])
    expect(callsOf("harness_mcp_install")).toHaveLength(0)
  })

  it('an "Open in Codeg" link opens the dialog over the detail, and never installs', async () => {
    render(<Harness section="discover" />)
    act(() => {
      view.open({
        section: "discover",
        itemRef: "acme.dev/notes",
        intent: "install",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Install Acme Notes" })
    ).toBeInTheDocument()
    // Once, though StrictMode-like double applying is allowed for.
    expect(callsOf("harness_mcp_plan")).toHaveLength(1)
    expect(callsOf("harness_mcp_install")).toHaveLength(0)
  })

  it("a link to install a skill opens the skill's own dialog, which only plans", async () => {
    backend.harness_skill_plan = () => rawSkillPlan()
    backend.harness_item = () =>
      rawDetail({
        id: "item-skill",
        readme: null,
        publisher: {
          handle: "acme",
          name: "Acme",
          kind: "github",
          verified: false,
          unclaimed: true,
          avatar: null,
        },
      })
    render(<Harness section="discover" />)
    act(() => {
      view.open({
        section: "discover",
        itemRef: "acme/pdf-tools",
        intent: "install",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Install PDF Tools" })
    ).toBeInTheDocument()
    expect(callsOf("harness_skill_plan")).toHaveLength(1)
    expect(callsOf("harness_mcp_plan")).toHaveLength(0)
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })

  it("for an installed item, offers Update when a newer revision is out, and Manage agents", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      mcpItem({
        latest: {
          revision: 4,
          version: "1.3.0",
          publishedAt: "2026-11-15T08:00:00.000Z",
        },
      })
    backend.harness_installed = () => ({ mcp: [rawInstalledItem()] })
    render(<Harness section="discover" />)
    act(() => {
      view.open({ section: "discover", itemRef: "acme.dev/notes" })
    })
    await screen.findByRole("button", { name: "Update" })
    expect(screen.getByText("Installed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Update" }))
    await screen.findByRole("dialog")
    expect(last(callsOf("harness_mcp_plan"))).toEqual({
      itemRef: "acme.dev/notes",
      revision: null,
    })
    await user.click(
      within(screen.getByRole("dialog")).getAllByRole("button", {
        name: "Cancel",
      })[0]
    )
    await user.click(screen.getByRole("button", { name: "Manage agents" }))
    await screen.findByRole("dialog")
    expect(last(callsOf("harness_mcp_plan"))).toEqual({
      itemRef: "acme.dev/notes",
      revision: 3,
    })
  })
})

// ─── The MCP section ──────────────────────────────────────────────────

function mcpFiles() {
  return inventory([
    agent("claude_code", [
      entry("notes", stdio("npx", ["-y", "@acme/notes-mcp@1.2.0"])),
      entry("docs", stdio("npx", ["-y", "docs-mcp@2.0.0"])),
      entry("plain", stdio("plain-server", [])),
    ]),
    agent("codex", [
      entry("notes", stdio("npx", ["-y", "@acme/notes-mcp@1.2.0", "--edited"])),
      entry("web", stdio("npx", ["-y", "web-mcp@1.0.0"])),
    ]),
  ])
}

function installedListing() {
  return {
    mcp: [
      rawInstalledItem({
        state: "changed_locally",
        agents: [
          rawInstalledAgent("claude_code"),
          rawInstalledAgent("codex", { state: "changed_locally" }),
        ],
      }),
      rawInstalledItem({
        id: "item-docs",
        ref: "acme.dev/docs",
        key: "docs",
        version: "2.0.0",
        agents: [rawInstalledAgent("claude_code", { version: "2.0.0" })],
      }),
      rawInstalledItem({
        id: "item-web",
        ref: "acme.dev/web",
        key: "web",
        version: null,
        state: "unknown",
        agents: [
          rawInstalledAgent("codex", { state: "unknown", version: null }),
        ],
      }),
    ],
  }
}

const rowOf = async (key: string) => {
  const list = await screen.findByRole("list", { name: "MCP servers" })
  return waitFor(() => {
    const row = within(list)
      .getAllByRole("button")
      .find((button) => button.dataset.mcpRow === key)
    if (!row) throw new Error(`no row ${key}`)
    return row
  })
}

describe("The MCP section's Harness marks", () => {
  beforeEach(() => {
    backend.mcp_inventory = () => mcpFiles()
    backend.harness_installed = () => installedListing()
  })

  it("lists the servers from Harness first, under its name, each with its version and how it stands", async () => {
    render(<Harness section="mcp" />)
    await waitFor(async () =>
      expect(await rowOf("docs")).toHaveTextContent("2.0.0")
    )
    const fromHarness = screen.getByRole("list", { name: "From SRN Harness" })
    const byHand = screen.getByRole("list", { name: "Added by hand" })
    const keys = (list: HTMLElement) =>
      within(list)
        .getAllByRole("button")
        .map((button) => button.dataset.mcpRow)
    expect(keys(fromHarness)).toEqual(
      expect.arrayContaining(["docs", "notes", "web"])
    )
    expect(keys(byHand)).toEqual(["plain"])
    // The group says where they came from; a row says only what differs.
    expect(await rowOf("docs")).not.toHaveTextContent("SRN Harness")
    expect(await rowOf("docs")).not.toHaveTextContent("As installed")
    expect(await rowOf("notes")).toHaveTextContent("1.2.0")
    expect(await rowOf("notes")).toHaveTextContent("Changed here")
    expect(await rowOf("web")).toHaveTextContent("Cannot be checked")
    expect(await rowOf("plain")).not.toHaveTextContent("SRN Harness")
    // "From SRN Harness" can match; "Update available" cannot yet.
    await userEvent
      .setup()
      .click(screen.getByRole("combobox", { name: "Show" }))
    expect(
      await screen.findByRole("option", { name: "From SRN Harness" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("option", { name: "Update available" })
    ).toBeNull()
  })

  it("says where it came from and how each agent's entry stands, and offers its actions", async () => {
    const user = userEvent.setup()
    render(<Harness section="mcp" />)
    await user.click(await rowOf("notes"))
    const part = await screen.findByRole("heading", { name: "Source" })
    const box = part.closest("section") as HTMLElement
    // The recorded title first, where it is from, the address under it,
    // the version and the revision at the end of that line; under a rule,
    // how it stands, labelled as the command under it is.
    expect(box).toHaveTextContent(
      "Acme NotesFrom SRN Harnessacme.dev/notesv1.2.0Revision 3StatusChanged here"
    )
    // Which agent's entry differs, that agent's own row says — once: the
    // part does not list the agents again.
    expect(box).not.toHaveTextContent("Claude Code")
    const detail = screen.getByRole("article")
    const agentRow = (name: string) =>
      within(detail).getByRole("switch", { name }).closest("li")!
    expect(agentRow("Codex")).toHaveTextContent("Changed here")
    expect(agentRow("Claude Code")).not.toHaveTextContent("Changed here")
    expect(agentRow("Claude Code")).not.toHaveTextContent("As installed")
    // What it runs is the card's too — each definition under its letter —
    // not a part of its own.
    expect(box).toHaveTextContent(
      /Definition A.*npx -y @acme\/notes-mcp@1\.2\.0.*Definition B.*--edited/
    )
    expect(
      within(detail).queryByRole("heading", { name: /^Definitions?$/ })
    ).toBeNull()
    // Status and commands are rows of one grid: one label column for all,
    // so their values start together.
    const grid = within(box).getByText("Status").closest("dl")
    expect(grid).not.toBeNull()
    for (const label of within(box).getAllByText("Command")) {
      expect(label.closest("dl")).toBe(grid)
    }
    // Removing it is uninstalling it, once, in the header.
    expect(within(box).queryByRole("button", { name: "Uninstall…" })).toBeNull()
    expect(within(detail).queryByRole("button", { name: "Remove…" })).toBeNull()
    expect(
      within(detail).getByRole("button", { name: "Uninstall…" })
    ).toBeEnabled()

    await user.click(within(box).getByRole("button", { name: "Update" }))
    await screen.findByRole("dialog")
    expect(last(callsOf("harness_mcp_plan"))).toEqual({
      itemRef: "acme.dev/notes",
      revision: null,
    })
    await user.click(
      last(
        within(screen.getByRole("dialog")).getAllByRole("button", {
          name: /Cancel|Close/,
        })
      )
    )
    // Changing it is one menu: each definition, and its agents.
    await user.click(within(box).getByRole("button", { name: "Edit" }))
    const menu = await screen.findByRole("menu")
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Edit definition A", "Edit definition B", "Manage agents"])
    await user.click(
      within(menu).getByRole("menuitem", { name: "Manage agents" })
    )
    await screen.findByRole("dialog")
    expect(last(callsOf("harness_mcp_plan"))).toEqual({
      itemRef: "acme.dev/notes",
      revision: 3,
    })
  })

  it("uninstalls after showing what it would do, removing a changed entry only when ticked", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_uninstall = (args) => {
      const removeChanged = (args?.removeChanged as string[]) ?? []
      const codexAction = removeChanged.includes("codex")
        ? "remove"
        : "keep_changed"
      const removing = [
        "claude_code",
        ...(codexAction === "remove" ? ["codex"] : []),
      ]
      if (args?.preflight) {
        return {
          outcome: "preflight",
          issues: [],
          agents: [
            {
              agent: "claude_code",
              key: "notes",
              state: "as_installed",
              action: "remove",
            },
            {
              agent: "codex",
              key: "notes",
              state: "changed_locally",
              action: codexAction,
            },
          ],
          apply: rawApply("preflight", removing, "ready"),
          record: null,
        }
      }
      return {
        outcome: "uninstalled",
        issues: [],
        agents: [],
        apply: rawApply("applied", removing, "written"),
        record: { status: "written" },
      }
    }
    render(<Harness section="mcp" />)
    await user.click(await rowOf("notes"))
    await screen.findByRole("heading", { name: "Source" })
    await user.click(
      within(screen.getByRole("article")).getByRole("button", {
        name: "Uninstall…",
      })
    )
    const dialog = await screen.findByRole("dialog")
    await waitFor(() =>
      expect(dialog).toHaveTextContent("kept unless you tick it below")
    )
    expect(callsOf("harness_mcp_uninstall")).toEqual([
      {
        itemId: "item-notes",
        agents: ["claude_code", "codex"],
        removeChanged: [],
        basis: {},
        preflight: true,
      },
    ])
    const confirm = within(dialog).getByRole("button", { name: "Uninstall" })
    await waitFor(() => expect(confirm).toBeEnabled())

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Remove it anyway, with the changes made here",
      })
    )
    await waitFor(() =>
      expect(last(callsOf("harness_mcp_uninstall"))).toMatchObject({
        removeChanged: ["codex"],
        preflight: true,
      })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Uninstall" })
      ).toBeEnabled()
    )
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }))
    await screen.findByText("Uninstalled.")
    expect(last(callsOf("harness_mcp_uninstall"))).toEqual({
      itemId: "item-notes",
      agents: ["claude_code", "codex"],
      removeChanged: ["codex"],
      basis: {
        claude_code: "basis-claude_code-after",
        codex: "basis-codex-after",
      },
      preflight: false,
    })
  })

  it("uninstalls an item whose entries are already gone: the record only forgets it", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_uninstall = (args) =>
      args?.preflight
        ? {
            outcome: "preflight",
            issues: [],
            agents: [
              {
                agent: "claude_code",
                key: "docs",
                state: "missing",
                action: "forget",
              },
            ],
            apply: { outcome: "preflight", ok: true, agents: [] },
            record: null,
          }
        : {
            outcome: "uninstalled",
            issues: [],
            agents: [],
            apply: { outcome: "applied", ok: true, agents: [] },
            record: { status: "written" },
          }
    render(<Harness section="mcp" />)
    await user.click(await rowOf("docs"))
    await screen.findByRole("heading", { name: "Source" })
    await user.click(
      within(screen.getByRole("article")).getByRole("button", {
        name: "Uninstall…",
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Acme Notes")
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Uninstall" })
      ).toBeEnabled()
    )
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }))
    await screen.findByText("Uninstalled.")
    // No file was written: no empty list of agents.
    expect(within(dialog).queryByRole("list")).toBeNull()
    expect(last(callsOf("harness_mcp_uninstall"))).toEqual({
      itemId: "item-docs",
      agents: ["claude_code"],
      removeChanged: [],
      basis: {},
      preflight: false,
    })
  })

  it("with the catalog switched off, offers only uninstalling, and says why", async () => {
    const user = userEvent.setup()
    render(<Harness section="mcp" discoverEnabled={false} />)
    await user.click(await rowOf("docs"))
    const box = (
      await screen.findByRole("heading", { name: "Source" })
    ).closest("section") as HTMLElement
    expect(within(box).queryByRole("button", { name: "Update" })).toBeNull()
    expect(
      within(box).queryByRole("button", { name: "Manage agents" })
    ).toBeNull()
    expect(within(box).getByRole("button", { name: "Edit" })).toBeEnabled()
    expect(
      within(screen.getByRole("article")).getByRole("button", {
        name: "Uninstall…",
      })
    ).toBeEnabled()
    expect(box).toHaveTextContent("which is switched off on this Codeg")
  })

  it("reads the listing again when something was installed elsewhere", async () => {
    render(<Harness section="mcp" />)
    await rowOf("notes")
    const before = callsOf("harness_installed").length
    await act(async () => {
      for (const handler of mocks.listeners.get(
        "harness://installed-changed"
      ) ?? []) {
        handler({ item_ids: ["item-notes"], agents: ["codex"] })
      }
    })
    expect(callsOf("harness_installed").length).toBe(before + 1)
  })

  it("shows no Harness marks from a Codeg too old to say", async () => {
    backend.harness_installed = () => {
      throw { code: "not_implemented", message: "Not implemented" }
    }
    render(<Harness section="mcp" />)
    expect(await rowOf("notes")).not.toHaveTextContent("SRN Harness")
  })
})

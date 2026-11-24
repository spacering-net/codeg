import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.call,
    subscribe: async () => () => {},
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

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  rawApply,
  rawInstallResult,
  rawPlan,
} from "@/lib/harness/mcp-install-fixtures"
import { openMcpInstall } from "@/lib/harness/mcp-install-state"
import {
  rawLinksApplied,
  rawSkillInstallResult,
  rawSkillPlan,
} from "@/lib/harness/skill-install-fixtures"
import { openSkillInstall } from "@/lib/harness/skill-install-state"
import { backendError } from "@/lib/harness/test-fixtures"
import { HarnessInstallDialogs } from "./harness-install-dialogs"

type Args = Record<string, unknown> | undefined
let backend: Record<string, (args: Args) => unknown>
const callsOf = (command: string) =>
  mocks.call.mock.calls.filter(([name]) => name === command)

type View = ReturnType<typeof useHarnessView>
let view: View
function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function Harness() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        <HarnessInstallDialogs />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

const dialog = () => screen.getByRole("dialog")
/** A footer's button: the frame's own close button is named "Close" too. */
const button = (name: string | RegExp) => {
  const found = within(dialog()).getAllByRole("button", { name })
  return found[found.length - 1]
}

const RESOLVE_UNAVAILABLE =
  "Codeg cannot confirm this item's current state with SRN Harness right now, so nothing was installed. Try again later."

beforeEach(() => {
  backend = {
    harness_installed: () => ({ mcp: [], skills: [] }),
  }
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
})

describe("the install dialogs' title before the plan is in", () => {
  it("MCP: the item's title the page already had, not its address", async () => {
    backend.harness_mcp_plan = () => new Promise(() => {})
    render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        title: { en: "Acme Notes", zh: "Acme 笔记" },
        purpose: "install",
        from: "discover",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Install Acme Notes" })
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent("Asking SRN Harness about this version…")
  })

  it("skill: the item's title the page already had, not its address", async () => {
    backend.harness_skill_plan = () => new Promise(() => {})
    render(<Harness />)
    act(() => {
      openSkillInstall(view.slots, {
        itemRef: "anthropics/pdf",
        title: { en: "PDF Tools" },
        purpose: "install",
        from: "discover",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Install PDF Tools" })
    ).toBeInTheDocument()
  })

  it("without one, the address", async () => {
    backend.harness_mcp_plan = () => new Promise(() => {})
    render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        purpose: "install",
        from: "discover",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Install acme.dev/notes" })
    ).toBeInTheDocument()
  })
})

describe("Harness cannot confirm the current state (resolveUnavailable)", () => {
  it("MCP, when planning: says so, with nothing to confirm", async () => {
    backend.harness_mcp_plan = () => {
      throw backendError("resolveUnavailable")
    }
    render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        purpose: "install",
        from: "discover",
      })
    })
    expect(await screen.findByText(RESOLVE_UNAVAILABLE)).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
    expect(button("Try again")).toBeEnabled()
  })

  it("MCP, when installing: says so, takes the confirmation away, and plans again on request", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () => rawPlan()
    backend.harness_mcp_install = () => {
      throw backendError("resolveUnavailable")
    }
    render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        purpose: "install",
        from: "discover",
      })
    })
    await user.type(
      await within(await screen.findByRole("dialog")).findByLabelText(
        "NOTES_TOKEN"
      ),
      "t"
    )
    await user.click(button("Install"))
    expect(await screen.findByText(RESOLVE_UNAVAILABLE)).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
    expect(callsOf("harness_mcp_install")).toHaveLength(1)

    backend.harness_mcp_install = () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code"], "written"),
      })
    await user.click(button("Try again"))
    await waitFor(() => expect(button("Install")).toBeEnabled())
    expect(callsOf("harness_mcp_plan")).toHaveLength(2)
    // Kept over the new plan: what was typed.
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue("t")
    expect(callsOf("harness_mcp_install")).toHaveLength(1)
  })

  it("skill, when planning: says so, with nothing to confirm", async () => {
    backend.harness_skill_plan = () => {
      throw backendError("resolveUnavailable")
    }
    render(<Harness />)
    act(() => {
      openSkillInstall(view.slots, {
        itemRef: "anthropics/pdf",
        purpose: "install",
        from: "discover",
      })
    })
    expect(await screen.findByText(RESOLVE_UNAVAILABLE)).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
  })

  it("skill, when installing: says so and takes the confirmation away", async () => {
    const user = userEvent.setup()
    backend.harness_skill_plan = (args) =>
      rawSkillPlan({}, (args?.agents as string[] | null) ?? null)
    backend.harness_skill_install = () => {
      throw backendError("resolveUnavailable")
    }
    render(<Harness />)
    act(() => {
      openSkillInstall(view.slots, {
        itemRef: "anthropics/pdf",
        purpose: "install",
        from: "discover",
      })
    })
    await screen.findByRole("heading", { name: "Install PDF Tools" })
    await waitFor(() => expect(button("Install")).toBeEnabled())
    await user.click(button("Install"))
    expect(await screen.findByText(RESOLVE_UNAVAILABLE)).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
    expect(callsOf("harness_skill_install")).toHaveLength(1)
    backend.harness_skill_install = () =>
      rawSkillInstallResult("installed", {
        links: rawLinksApplied(["claude_code", "codex"]),
        rewrites: {},
      })
    expect(button("Try again")).toBeEnabled()
  })
})

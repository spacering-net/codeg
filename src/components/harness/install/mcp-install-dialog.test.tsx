import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  remote: null as null | { connection: { name: string; base_url: string } },
  desktop: true,
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
  getActiveRemoteConnectionId: () => (mocks.remote ? 7 : null),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => mocks.desktop,
  openUrl: async () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => mocks.remote,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  MCP_HARNESS_DIALOG,
  openMcpInstall,
} from "@/lib/harness/mcp-install-state"
import {
  NEW_STATE,
  rawApply,
  rawInstallResult,
  rawParameter,
  rawPlan,
  rawPlanAgent,
  rawRemoteOption,
  rawSnapshot,
  rawStdioOption,
  STATE,
} from "@/lib/harness/mcp-install-fixtures"
import { backendError } from "@/lib/harness/test-fixtures"
import { HarnessInstallDialogs } from "./harness-install-dialogs"

type Args = Record<string, unknown> | undefined
type Handler = (args: Args) => unknown

let backend: Record<string, Handler>
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

/** `show` stands for the Harness page being on screen: the provider (and
 *  its slots) stays when the user goes to a conversation; the page goes. */
function Harness({ show = true }: { show?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        {show && <HarnessInstallDialogs />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  mocks.remote = null
  mocks.desktop = true
  mocks.listeners.clear()
  backend = {
    harness_mcp_plan: () => rawPlan(),
    harness_installed: () => ({ mcp: [] }),
    harness_mcp_install: () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code", "codex"], "written"),
        record: { status: "written" },
      }),
  }
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
})

async function openDialog(
  request: Partial<Parameters<typeof openMcpInstall>[1]> = {}
) {
  render(<Harness />)
  act(() => {
    openMcpInstall(view.slots, {
      itemRef: "acme.dev/notes",
      purpose: "install",
      from: "discover",
      ...request,
    })
  })
  return screen.findByRole("dialog")
}

const dialog = () => screen.getByRole("dialog")
/** A footer's button: the frame's own close button is named "Close" too. */
const button = (name: string | RegExp) => {
  const found = within(dialog()).getAllByRole("button", { name })
  return found[found.length - 1]
}

async function fillToken(
  user: ReturnType<typeof userEvent.setup>,
  value = "tok-1"
) {
  const field = await within(dialog()).findByLabelText("NOTES_TOKEN")
  if (value) await user.type(field, value)
  return field
}

describe("Harness install dialog — what it shows", () => {
  it("shows the item and the catalog's state as it is now, and the ways to run it", async () => {
    await openDialog()
    expect(
      await screen.findByRole("heading", { name: "Install Acme Notes" })
    ).toBeInTheDocument()
    const body = dialog()
    expect(body).toHaveTextContent("acme.dev/notes")
    expect(body).toHaveTextContent("Version 1.2.0, revision 3")
    expect(body).toHaveTextContent("Low risk")
    expect(body).toHaveTextContent("Reviewed by a person")
    expect(body).toHaveTextContent("Findings: 0 high, 1 medium, 2 low")
    expect(body).toHaveTextContent("@acme/notes-mcp@1.2.0")
    expect(body).toHaveTextContent("Version verified")
    // Found by the checks and not declared: marked.
    expect(body).toHaveTextContent("telemetry.acme.example")
    expect(body).toHaveTextContent("found, not declared")
    // Both ways to run it, the package chosen.
    const radios = within(body).getAllByRole("radio", {
      name: /A package Codeg starts|A hosted server/,
    })
    expect(radios).toHaveLength(2)
    expect(radios[0]).toBeChecked()
    expect(body).toHaveTextContent("npx -y @acme/notes-mcp@1.2.0")
    // Nothing installs on opening.
    expect(callsOf("harness_mcp_install")).toHaveLength(0)
  })

  it("masks secrets, fills in defaults, says what is required, and only then installs", async () => {
    const user = userEvent.setup()
    await openDialog()
    const token = await fillToken(user, "")
    expect(token).toHaveAttribute("type", "password")
    expect(within(dialog()).getByLabelText("NOTES_DIR")).toHaveValue("~/notes")
    expect(button("Install")).toBeDisabled()
    expect(dialog()).toHaveTextContent("Before it can be installed:")
    expect(dialog()).toHaveTextContent("Fill in NOTES_TOKEN.")

    await user.type(token, "tok-1")
    await user.click(
      within(dialog()).getByRole("button", { name: "Show NOTES_TOKEN" })
    )
    expect(token).toHaveAttribute("type", "text")
    expect(dialog()).toHaveTextContent(
      "Secret values are written in plain text"
    )
    expect(button("Install")).toBeEnabled()
    await user.click(button("Install"))

    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")).toEqual([
      {
        itemRef: "acme.dev/notes",
        revision: 3,
        optionId: "official:package:0:stdio",
        values: { "env.NOTES_TOKEN": "tok-1", "env.NOTES_DIR": "~/notes" },
        key: "notes",
        agents: ["claude_code", "codex"],
        replace: [],
        stateSha256: STATE,
        basis: { claude_code: "basis-claude_code", codex: "basis-codex" },
        acceptYanked: false,
      },
    ])
    // Each agent's result, as the MCP section shows a save.
    expect(dialog()).toHaveTextContent("Claude Code")
    expect(dialog()).toHaveTextContent("Saved")
    // What was typed is gone once it is installed.
    const state = view.slots.get(MCP_HARNESS_DIALOG)
    expect(state?.kind === "install" && state.input?.values).toEqual({})
  })

  it("never keeps a secret anywhere but the open dialog", async () => {
    const user = userEvent.setup()
    await openDialog()
    await fillToken(user, "very-secret-value")
    const stored = [
      ...Object.keys(localStorage).map((key) => localStorage.getItem(key)),
      ...Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key)),
    ].join("\n")
    expect(stored).not.toContain("very-secret-value")
    await user.click(button("Cancel"))
    expect(view.slots.get(MCP_HARNESS_DIALOG)).toBeNull()
  })

  it("says why an item cannot be installed, and offers nothing to confirm", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        blocking: [
          { code: "version_blocked" },
          { code: "snapshot_incomplete", params: { field: "risk" } },
          { code: "item_unavailable", params: { status: "retired" } },
          { code: "server_unreadable", detail: "expected `,` at line 4" },
          { code: "a_code_from_later" },
        ],
        default_option: null,
      })
    await openDialog()
    const body = await screen.findByRole("alert")
    expect(body).toHaveTextContent("This cannot be installed")
    expect(body).toHaveTextContent("SRN Harness blocked this version.")
    expect(body).toHaveTextContent(
      "SRN Harness's answer left out this version's risk"
    )
    expect(body).toHaveTextContent("Its author retired this item.")
    expect(body).toHaveTextContent("server.json) could not be read.")
    expect(body).toHaveTextContent("expected `,` at line 4")
    expect(body).toHaveTextContent("a_code_from_later")
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
    expect(button("Close")).toBeEnabled()
  })

  it("says why a way to run it cannot be chosen, and what is worth knowing about another", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            warnings: [
              {
                code: "version_unverified",
                params: {
                  registry_type: "npm",
                  identifier: "@acme/notes-mcp",
                  version: "1.2.0",
                  verified: "pending",
                },
              },
              {
                code: "install_script",
                params: { registry_type: "npm", identifier: "@acme/notes-mcp" },
              },
            ],
          }),
          rawRemoteOption({
            selectable: false,
            blocking: [
              { code: "remote_not_public", params: { host: "10.0.0.5" } },
              { code: "secret_in_query", params: { name: "api_key" } },
            ],
          }),
          rawStdioOption({
            id: "official:package:1:stdio",
            package: {
              registry_type: "nuget",
              identifier: "Acme.Notes",
              version: "1.0.0",
              verified: "ok",
              has_install_script: false,
              runtime: null,
            },
            selectable: false,
            blocking: [
              {
                code: "registry_unsupported",
                params: { registry_type: "nuget" },
              },
              {
                code: "runtime_arguments_unsupported",
                params: {
                  registry_type: "npm",
                  identifier: "@acme/notes-mcp",
                  argument: "--package",
                },
              },
              {
                code: "runner_environment_unsupported",
                params: { name: "NODE_OPTIONS" },
              },
            ],
            warnings: [{ code: "secret_not_sent", params: { name: "token" } }],
          }),
        ],
      })
    await openDialog()
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    const body = dialog()
    expect(body).toHaveTextContent(
      "Version not verified: @acme/notes-mcp@1.2.0 (Check pending)."
    )
    expect(body).toHaveTextContent("@acme/notes-mcp runs install scripts")
    expect(body).toHaveTextContent(
      "The address is not a public HTTPS address (10.0.0.5)."
    )
    expect(body).toHaveTextContent("The secret api_key could only be sent")
    expect(body).toHaveTextContent("Packages from nuget are not run")
    expect(body).toHaveTextContent("(--package)")
    expect(body).toHaveTextContent("The package sets NODE_OPTIONS")
    expect(body).toHaveTextContent("The optional secret token is left out")
    const radios = within(body).getAllByRole("radio", {
      name: /A package Codeg starts|A hosted server/,
    })
    expect(radios.map((radio) => radio.hasAttribute("disabled"))).toEqual([
      false,
      true,
      true,
    ])
  })

  it("switches to another way to run it, with its own settings and agents", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption(),
          rawRemoteOption({
            id: "official:remote:0:sse",
            transport: "sse",
            definition: { type: "sse", url: "https://notes.acme.example/sse" },
            url: "https://notes.acme.example/sse",
          }),
        ],
      })
    await openDialog()
    await fillToken(user)
    await user.click(
      within(dialog()).getByRole("radio", { name: /A hosted server/ })
    )
    // Its own field, masked, and Codex — which cannot hold SSE — unticked.
    expect(within(dialog()).getByLabelText("Authorization")).toHaveAttribute(
      "type",
      "password"
    )
    expect(
      within(dialog()).getByRole("checkbox", { name: /Codex/ })
    ).toBeDisabled()
    await user.type(
      within(dialog()).getByLabelText("Authorization"),
      "Bearer x"
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]).toMatchObject({
      optionId: "official:remote:0:sse",
      values: { "headers.Authorization": "Bearer x" },
      agents: ["claude_code"],
      basis: { claude_code: "basis-claude_code" },
    })
  })

  it("asks before replacing a server that is not this item's, and shows what it overwrites", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        agents: [
          rawPlanAgent("claude_code", { keys: ["notes"] }),
          rawPlanAgent("codex", { transports: ["stdio", "http"] }),
        ],
        key: {
          name: "notes",
          default: "notes",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
          conflicts: [
            {
              key: "notes",
              agent: "claude_code",
              owner: "elsewhere",
              item_id: null,
              item_ref: null,
              state: null,
              definition: {
                type: "http",
                url: "https://old.example/mcp",
                headers: { Authorization: "Bearer old-secret" },
              },
              enabled: true,
            },
          ],
        },
      })
    await openDialog()
    await fillToken(user)
    const body = dialog()
    expect(body).toHaveTextContent(
      "Has a server named notes (not from SRN Harness): tick it below to replace it"
    )
    expect(body).toHaveTextContent("Not from SRN Harness")
    // Codex only gains the server: its row goes without a word.
    const codex = within(body).getByRole("checkbox", { name: /Codex/ })
    expect(codex).toBeChecked()
    expect(
      document.getElementById(codex.getAttribute("aria-describedby")!)
    ).toHaveTextContent(/^$/)
    expect(body).toHaveTextContent("https://old.example/mcp")
    // The old secret is masked by default.
    expect(body).not.toHaveTextContent("old-secret")
    expect(button("Install")).toBeDisabled()
    expect(body).toHaveTextContent(
      "Tick replacing notes in Claude Code, or untick those agents."
    )
    await user.click(
      within(body).getByRole("checkbox", { name: "Replace it in Claude Code" })
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]).toMatchObject({
      agents: ["claude_code", "codex"],
      replace: ["claude_code"],
    })
  })

  it("needs a tick to install a withdrawn version", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        confirm: [{ code: "yanked" }],
        snapshot: rawSnapshot({ status: "yanked" }),
      })
    await openDialog()
    await fillToken(user)
    expect(dialog()).toHaveTextContent("Its author withdrew this version")
    expect(button("Install")).toBeDisabled()
    await user.click(
      within(dialog()).getByRole("checkbox", {
        name: "Install the withdrawn version anyway",
      })
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]?.acceptYanked).toBe(true)
  })
})

describe("Harness install dialog — kept, and kept safe", () => {
  it("comes back as it was left after a trip to a conversation", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        purpose: "install",
        from: "discover",
      })
    })
    await screen.findByRole("dialog")
    await fillToken(user, "typed-before")
    await user.click(within(dialog()).getByRole("checkbox", { name: /Codex/ }))
    rerender(<Harness show={false} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    rerender(<Harness />)
    await screen.findByRole("dialog")
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue(
      "typed-before"
    )
    // Masked again: revealing is not kept.
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveAttribute(
      "type",
      "password"
    )
    expect(
      within(dialog()).getByRole("checkbox", { name: /Codex/ })
    ).not.toBeChecked()
    // Nothing was planned again, and nothing installed.
    expect(callsOf("harness_mcp_plan")).toHaveLength(1)
    expect(callsOf("harness_mcp_install")).toHaveLength(0)
  })

  it("is not replaced by another dialog while its install is on its way", async () => {
    const user = userEvent.setup()
    let finish: (value: unknown) => void = () => {}
    backend.harness_mcp_install = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findAllByText("Installing…")
    let opened: number | null = 0
    act(() => {
      opened = openMcpInstall(view.slots, {
        itemRef: "acme.dev/other",
        purpose: "install",
        from: "discover",
      })
    })
    expect(opened).toBeNull()
    // Nor closed: Escape does nothing until the answer is in.
    await user.keyboard("{Escape}")
    expect(dialog()).toHaveTextContent("Installing…")
    await act(async () => {
      finish(
        rawInstallResult("installed", {
          apply: rawApply("applied", ["claude_code"], "written"),
        })
      )
    })
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_plan")).toHaveLength(1)
  })
})

describe("Harness install dialog — what an install comes back with", () => {
  it("a file changed elsewhere: plans again, keeps what was typed, waits for a new confirmation", async () => {
    const user = userEvent.setup()
    let plans = 0
    backend.harness_mcp_plan = () => {
      plans += 1
      return rawPlan({
        agents: [
          rawPlanAgent("claude_code", { basis: `basis-claude_code-${plans}` }),
          rawPlanAgent("codex", { transports: ["stdio", "http"] }),
        ],
      })
    }
    backend.harness_mcp_install = () => rawInstallResult("changed_elsewhere")
    await openDialog()
    await fillToken(user, "kept")
    await user.click(button("Install"))
    await screen.findByText(
      /An agent's configuration changed after this was opened/
    )
    expect(callsOf("harness_mcp_plan")).toHaveLength(2)
    expect(callsOf("harness_mcp_install")).toHaveLength(1)
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue("kept")

    backend.harness_mcp_install = () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code"], "written"),
      })
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[1]?.basis).toMatchObject({
      claude_code: "basis-claude_code-2",
    })
  })

  it("the catalog's account changed: shows the changes, and confirms the new state", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("state_changed", {
        changes: [
          { code: "risk_changed", params: { from: "low", to: "medium" } },
          {
            code: "permission_added",
            params: {
              profile: "detected",
              field: "network",
              value: "evil.example",
            },
          },
          {
            code: "verification_changed",
            params: {
              registry_type: "npm",
              identifier: "@acme/notes-mcp",
              from: "ok",
              to: "pending",
            },
          },
          {
            code: "install_script_added",
            params: { identifier: "@acme/notes-mcp" },
          },
        ],
        snapshot: rawSnapshot({ risk: "medium", stateSha256: NEW_STATE }),
        state_sha256: NEW_STATE,
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findByText(/account of this version changed/)
    const body = dialog()
    expect(body).toHaveTextContent("Risk: low → medium")
    expect(body).toHaveTextContent("The checks now find: Network evil.example")
    expect(body).toHaveTextContent(
      "@acme/notes-mcp: Version verified → Check pending"
    )
    expect(body).toHaveTextContent("@acme/notes-mcp now runs install scripts.")
    // The state on show is the new one.
    expect(body).toHaveTextContent("Medium risk")
    expect(callsOf("harness_mcp_install")).toHaveLength(1)

    backend.harness_mcp_install = () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code", "codex"], "written"),
      })
    await user.click(button("Install with these changes"))
    await screen.findByText("Installed.")
    const [first, second] = callsOf("harness_mcp_install")
    expect(first.stateSha256).toBe(STATE)
    expect(second.stateSha256).toBe(NEW_STATE)
    expect(second.basis).toEqual(first.basis)
  })

  it("aborted: says why, and offers nothing to confirm", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("aborted", {
        issues: [
          {
            code: "package_missing",
            params: {
              registry_type: "npm",
              identifier: "@acme/notes-mcp",
              version: "1.2.0",
            },
          },
        ],
        snapshot: rawSnapshot({ status: "blocked" }),
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    const alert = await screen.findByText(/can no longer be installed/)
    expect(alert).toBeInTheDocument()
    expect(dialog()).toHaveTextContent(
      "@acme/notes-mcp@1.2.0 is not at its registry."
    )
    expect(dialog()).toHaveTextContent("Blocked by SRN Harness")
    expect(
      within(dialog()).queryByRole("button", { name: /Install/ })
    ).toBeNull()
    expect(button("Close")).toBeEnabled()
  })

  it("refused: back to the input, saying why", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("refused", {
        issues: [
          {
            code: "replace_required",
            params: { agent: "codex", key: "notes" },
          },
          { code: "parameter_required", params: { key: "env.NOTES_DIR" } },
        ],
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findByText("Codeg did not install it, and wrote nothing:")
    expect(dialog()).toHaveTextContent(
      "Codex already has a server named notes."
    )
    expect(dialog()).toHaveTextContent("NOTES_DIR is required.")
    expect(button("Install")).toBeEnabled()
  })

  it("busy: nothing written, and a retry sends the same call again", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("busy", {
        apply: rawApply("busy", ["claude_code"], "not_written"),
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findByText(
      /Another change to the agents' files was in progress/
    )
    await user.click(button("Try again"))
    await waitFor(() => expect(callsOf("harness_mcp_install")).toHaveLength(2))
    const [first, second] = callsOf("harness_mcp_install")
    expect(second).toEqual(first)
  })

  it("write_failed: each agent says what happened, including what was put back", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("write_failed", {
        apply: {
          ...rawApply("write_failed", ["claude_code"], "restored"),
          agents: [
            {
              ...(
                rawApply("write_failed", ["claude_code"], "restored")
                  .agents as Record<string, unknown>[]
              )[0],
            },
            {
              ...(
                rawApply("write_failed", ["codex"], "write_failed")
                  .agents as Record<string, unknown>[]
              )[0],
              issues: [{ code: "write_failed", detail: "disk full" }],
            },
          ],
        },
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findByText(/Writing failed part-way/)
    expect(dialog()).toHaveTextContent("Put back as it was")
    expect(dialog()).toHaveTextContent("Writing failed")
    expect(dialog()).toHaveTextContent("disk full")
  })

  it("installed but not recorded: the servers work, and it says they are not marked", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_install = () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code"], "written"),
        record: {
          status: "failed",
          code: "record_write_failed",
          detail: "permission denied",
        },
      })
    await openDialog()
    await fillToken(user)
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(dialog()).toHaveTextContent(
      "could not record them as from SRN Harness"
    )
    expect(dialog()).toHaveTextContent("Its record could not be written.")
    expect(dialog()).toHaveTextContent("permission denied")
  })
})

describe("Harness install dialog — when the plan cannot be had", () => {
  it("says the catalog is switched off", async () => {
    backend.harness_mcp_plan = () => {
      throw backendError("disabled")
    }
    await openDialog()
    expect(
      await screen.findByText("Discover is switched off on this Codeg.")
    ).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: "Try again" })
    ).toBeNull()
  })

  it("asks an older Codeg to be updated — the one that needs it", async () => {
    backend.harness_mcp_plan = () => {
      throw { code: "not_implemented", message: "Not implemented" }
    }
    mocks.desktop = false
    await openDialog()
    expect(
      await screen.findByText(
        "The Codeg server is too old to install from SRN Harness. Update the server."
      )
    ).toBeInTheDocument()
  })

  it("lets only the newest plan land", async () => {
    let release: (value: unknown) => void = () => {}
    backend.harness_mcp_plan = (args) =>
      args?.itemRef === "acme.dev/slow"
        ? new Promise((resolve) => {
            release = resolve
          })
        : rawPlan()
    render(<Harness />)
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/slow",
        purpose: "install",
        from: "discover",
      })
    })
    act(() => {
      openMcpInstall(view.slots, {
        itemRef: "acme.dev/notes",
        purpose: "install",
        from: "discover",
      })
    })
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    await act(async () => {
      release(
        rawPlan({
          item: {
            id: "slow",
            ref: "acme.dev/slow",
            kind: "mcp",
            title: { en: "Slow" },
            revision: 1,
            version: null,
            published_at: "",
          },
        })
      )
    })
    expect(
      screen.getByRole("heading", { name: "Install Acme Notes" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Slow")).toBeNull()
  })
})

describe("Harness install dialog — after review", () => {
  it("masks a secret JSON value until it is revealed", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.CREDENTIALS",
                name: "CREDENTIALS",
                kind: "json",
                secret: true,
              }),
            ],
          }),
        ],
      })
    await openDialog()
    const field = await within(dialog()).findByLabelText("CREDENTIALS")
    expect(field).toHaveAttribute("type", "password")
    await user.type(field, "true")
    await user.click(
      within(dialog()).getByRole("button", { name: "Show CREDENTIALS" })
    )
    const shown = within(dialog()).getByLabelText("CREDENTIALS")
    expect(shown.tagName).toBe("TEXTAREA")
    expect(shown).toHaveValue("true")
  })

  it("masks every value of an entry it would replace, whatever it is called", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        agents: [rawPlanAgent("claude_code", { keys: ["notes"] })],
        options: [rawStdioOption({ default_targets: ["claude_code"] })],
        key: {
          name: "notes",
          default: "notes",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
          conflicts: [
            {
              key: "notes",
              agent: "claude_code",
              owner: "elsewhere",
              item_id: null,
              item_ref: null,
              state: null,
              definition: {
                type: "stdio",
                command: "notes",
                env: { CONFIG: "opaque-credential" },
              },
              enabled: true,
            },
          ],
        },
      })
    await openDialog()
    await screen.findByText("What will be replaced:")
    expect(dialog()).toHaveTextContent("CONFIG")
    expect(dialog()).not.toHaveTextContent("opaque-credential")
  })

  it("masks a value the option marks secret in what will be run, whatever it is called", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            definition: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@acme/notes-mcp@1.2.0"],
              env: { SETTING: "default-but-secret" },
            },
            parameters: [
              rawParameter({
                key: "env.SETTING",
                name: "SETTING",
                secret: true,
                default: "default-but-secret",
              }),
            ],
          }),
        ],
      })
    await openDialog()
    await screen.findByText("What will be run")
    const preview = screen.getByText("What will be run").parentElement!
    expect(preview).toHaveTextContent("SETTING")
    expect(preview).not.toHaveTextContent("default-but-secret")
  })

  it("going back after the catalog's account changed plans again, so the input shows what will be confirmed", async () => {
    const user = userEvent.setup()
    let plans = 0
    backend.harness_mcp_plan = () => {
      plans += 1
      return plans === 1
        ? rawPlan()
        : rawPlan({
            snapshot: rawSnapshot({ stateSha256: NEW_STATE }),
            state_sha256: NEW_STATE,
            options: [
              rawStdioOption({
                definition: {
                  type: "stdio",
                  command: "npx",
                  args: ["-y", "@acme/notes-mcp@1.2.1"],
                },
              }),
            ],
          })
    }
    backend.harness_mcp_install = () =>
      rawInstallResult("state_changed", {
        changes: [
          {
            code: "package_version_changed",
            params: {
              registry_type: "npm",
              identifier: "@acme/notes-mcp",
              from: "1.2.0",
              to: "1.2.1",
            },
          },
        ],
        snapshot: rawSnapshot({ stateSha256: NEW_STATE }),
        state_sha256: NEW_STATE,
      })
    await openDialog()
    await fillToken(user, "kept")
    await user.click(button("Install"))
    await screen.findByText(/account of this version changed/)
    expect(dialog()).toHaveTextContent("@acme/notes-mcp: version 1.2.0 → 1.2.1")
    await user.click(button("Back"))
    await waitFor(() =>
      expect(dialog()).toHaveTextContent("npx -y @acme/notes-mcp@1.2.1")
    )
    expect(callsOf("harness_mcp_plan")).toHaveLength(2)
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue("kept")
    backend.harness_mcp_install = () =>
      rawInstallResult("installed", {
        apply: rawApply("applied", ["claude_code"], "written"),
      })
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[1]?.stateSha256).toBe(NEW_STATE)
  })
})

describe("Harness install dialog — an update keeps what was entered", () => {
  const installedPlan = (parameters: Record<string, unknown>[], extra = {}) =>
    rawPlan({
      item: {
        id: "item-notes",
        ref: "acme.dev/notes",
        kind: "mcp",
        title: { en: "Acme Notes" },
        revision: 4,
        version: "1.3.0",
        published_at: "2026-11-15T08:00:00.000Z",
      },
      installed: {
        id: "item-notes",
        ref: "acme.dev/notes",
        title: { en: "Acme Notes" },
        key: "notes",
        revision: 3,
        version: "1.2.0",
        state: "as_installed",
        agents: [
          {
            agent: "claude_code",
            state: "as_installed",
            revision: 3,
            version: "1.2.0",
            option: "official:package:0:stdio",
            transport: "stdio",
            packages: [],
            state_sha256: STATE,
            installed_at: "2026-11-16T09:30:00.000Z",
          },
        ],
      },
      options: [
        rawStdioOption({
          default_targets: ["claude_code"],
          default_replace: ["claude_code"],
          parameters,
          ...extra,
        }),
      ],
      agents: [
        rawPlanAgent("claude_code", { keys: ["notes"] }),
        rawPlanAgent("codex", { transports: ["stdio", "http"] }),
      ],
      key: {
        name: "notes",
        default: "notes",
        pattern: "^[A-Za-z0-9_-]{1,64}$",
        conflicts: [
          {
            key: "notes",
            agent: "claude_code",
            owner: "this_item",
            item_id: "item-notes",
            item_ref: "acme.dev/notes",
            state: "as_installed",
            definition: { type: "stdio", command: "npx" },
            enabled: true,
          },
        ],
      },
    })

  it("fills the fields in from what the agents hold now, secrets masked", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      installedPlan([
        rawParameter({
          current: {
            value: "kept-token",
            agents: ["claude_code"],
            conflicting: false,
          },
        }),
      ])
    await openDialog({ purpose: "update", from: "mcp" })
    await screen.findByRole("heading", { name: "Update Acme Notes" })
    const token = within(dialog()).getByLabelText("NOTES_TOKEN")
    expect(token).toHaveValue("kept-token")
    expect(token).toHaveAttribute("type", "password")
    expect(dialog()).not.toHaveTextContent("kept-token")
    expect(dialog()).toHaveTextContent(
      "Filled in from what Claude Code have now."
    )
    await user.click(button("Update"))
    await screen.findByText("Updated.")
    expect(callsOf("harness_mcp_install")[0]).toMatchObject({
      values: { "env.NOTES_TOKEN": "kept-token" },
      replace: ["claude_code"],
    })
  })

  it("does not fill in a value the agents disagree on, and lets the user take one", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      installedPlan([
        rawParameter({
          current: {
            value: "claude-token",
            agents: ["claude_code", "codex"],
            conflicting: true,
          },
        }),
      ])
    await openDialog({ purpose: "update", from: "mcp" })
    await screen.findByRole("heading", { name: "Update Acme Notes" })
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue("")
    expect(dialog()).toHaveTextContent(
      "The agents it is installed in do not agree on this (Claude Code, Codex)."
    )
    expect(dialog()).toHaveTextContent(
      "Pick the value of NOTES_TOKEN: the agents do not agree on it."
    )
    expect(button("Update")).toBeDisabled()
    await user.click(
      within(dialog()).getByRole("button", {
        name: "Use Claude Code's value",
      })
    )
    expect(within(dialog()).getByLabelText("NOTES_TOKEN")).toHaveValue(
      "claude-token"
    )
    expect(dialog()).toHaveTextContent("the value here is the one you set")
    await user.click(button("Update"))
    await screen.findByText("Updated.")
    expect(callsOf("harness_mcp_install")[0]?.values).toEqual({
      "env.NOTES_TOKEN": "claude-token",
    })
  })

  it("lists what an update cannot carry over, and the agents it reads nothing from", async () => {
    backend.harness_mcp_plan = () =>
      installedPlan(
        [
          rawParameter(),
          rawParameter({
            key: "variables.tenant",
            name: "tenant",
            location: "query",
            secret: false,
          }),
        ],
        {
          recovery: {
            from: ["claude_code"],
            unmatched: ["codex"],
            lost: [
              { key: "variables.tenant", agents: ["claude_code"] },
              { key: "env.OLD_FLAG", agents: ["claude_code"] },
              { key: "package_arguments.2", agents: ["claude_code"] },
            ],
          },
        }
      )
    await openDialog({ purpose: "update", from: "mcp" })
    await screen.findByRole("heading", { name: "Update Acme Notes" })
    const note = within(dialog()).getByRole("note")
    expect(note).toHaveTextContent("Not everything can be carried over")
    expect(note).toHaveTextContent(
      "Codex: the entry no longer matches this way of running it"
    )
    expect(note).toHaveTextContent("OLD_FLAG")
    expect(note).toHaveTextContent("argument 3")
    // Every dropped value is listed — also one whose field is here — and
    // the field says it too.
    expect(note).toHaveTextContent("tenant")
    expect(dialog()).toHaveTextContent(
      "Codeg could not read back what Claude Code had here."
    )
  })

  it("lists a dropped value under a key whose field now holds another value read back", async () => {
    backend.harness_mcp_plan = () =>
      installedPlan(
        [
          rawParameter(),
          rawParameter({
            key: "package_arguments.0",
            name: "--workspace",
            location: "arg",
            secret: false,
            required: false,
            current: {
              value: "/data",
              agents: ["claude_code"],
              conflicting: false,
            },
          }),
        ],
        {
          recovery: {
            from: ["claude_code"],
            unmatched: [],
            lost: [{ key: "package_arguments.0", agents: ["claude_code"] }],
          },
        }
      )
    await openDialog({ purpose: "update", from: "mcp" })
    await screen.findByRole("heading", { name: "Update Acme Notes" })
    const note = within(dialog()).getByRole("note")
    expect(note).toHaveTextContent(
      "An update drops these values unless you enter them again:"
    )
    expect(note).toHaveTextContent("argument 1 (Claude Code)")
    expect(within(dialog()).getByLabelText("--workspace")).toHaveValue("/data")
  })

  it("forgets the values it read back once the update went through", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      installedPlan([
        rawParameter({
          current: {
            value: "kept-token",
            agents: ["claude_code"],
            conflicting: false,
          },
        }),
      ])
    await openDialog({ purpose: "update", from: "mcp" })
    await screen.findByRole("heading", { name: "Update Acme Notes" })
    await user.click(button("Update"))
    await screen.findByText("Updated.")
    const state = view.slots.get(MCP_HARNESS_DIALOG)
    expect(JSON.stringify(state)).not.toContain("kept-token")
  })
})

describe("Harness install dialog — choices, agents and names", () => {
  it("offers a parameter's choices, and no free text", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.REGION",
                name: "REGION",
                secret: false,
                choices: ["eu-central-1", "us-east-1"],
              }),
            ],
          }),
        ],
      })
    await openDialog()
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    expect(
      within(dialog()).queryByRole("textbox", { name: "REGION" })
    ).toBeNull()
    // jsdom names machine text with a space at each place it may break.
    await user.click(
      within(dialog()).getByRole("radio", {
        name: (name) => name.replace(/\s+/g, "") === "us-east-1",
      })
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]?.values).toEqual({
      "env.REGION": "us-east-1",
    })
  })

  it("keeps a secret parameter's choice masked until it is revealed", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.TIER_KEY",
                name: "TIER_KEY",
                secret: true,
                choices: ["alpha-key", "beta-key"],
                current: {
                  value: "beta-key",
                  agents: ["claude_code"],
                  conflicting: false,
                },
              }),
            ],
          }),
        ],
      })
    await openDialog()
    const field = await within(dialog()).findByLabelText("TIER_KEY")
    expect(field).toHaveAttribute("type", "password")
    expect(dialog()).not.toHaveTextContent("alpha-key")
    expect(within(dialog()).queryByRole("radio", { name: /key/ })).toBeNull()
    await user.click(
      within(dialog()).getByRole("button", { name: "Show TIER_KEY" })
    )
    expect(dialog()).toHaveTextContent("alpha-key")
    expect(
      within(dialog()).getByRole("radio", {
        name: (name) => name.replace(/\s+/g, "") === "beta-key",
      })
    ).toBeChecked()
  })

  it("never shows a secret's default as a masked field's placeholder", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.TIER_KEY",
                name: "TIER_KEY",
                secret: true,
                required: false,
                default: "alpha-key",
                choices: ["alpha-key", "beta-key"],
              }),
              rawParameter({
                key: "env.OTHER_KEY",
                name: "OTHER_KEY",
                secret: true,
                required: false,
                default: "default-secret",
              }),
            ],
          }),
        ],
      })
    await openDialog()
    await within(dialog()).findByLabelText("TIER_KEY")
    await user.click(
      within(dialog()).getByRole("button", { name: "Show TIER_KEY" })
    )
    await user.click(within(dialog()).getByRole("radio", { name: "Not set" }))
    await user.click(
      within(dialog()).getByRole("button", { name: "Hide TIER_KEY" })
    )
    const masked = within(dialog()).getByLabelText("TIER_KEY")
    expect(masked).toHaveValue("")
    expect(masked).not.toHaveAttribute("placeholder", "alpha-key")
    const other = within(dialog()).getByLabelText("OTHER_KEY")
    await user.clear(other)
    expect(other).not.toHaveAttribute("placeholder", "default-secret")
  })

  it("offers a long list of choices as a menu", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.REGION",
                name: "REGION",
                secret: false,
                required: false,
                choices: ["a", "b", "c", "d", "e", "f", "g"],
              }),
            ],
          }),
        ],
      })
    await openDialog()
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    expect(within(dialog()).getByRole("combobox")).toBeInTheDocument()
  })

  it("says why an agent cannot be written, in the engine's words", async () => {
    backend.harness_mcp_plan = () =>
      rawPlan({
        agents: [
          rawPlanAgent("claude_code"),
          rawPlanAgent("cline", {
            writable: false,
            status: "unreadable",
            basis: null,
            reason: { code: "invalid_json", detail: "line 3" },
          }),
          rawPlanAgent("open_claw", {
            writable: false,
            status: "read_only",
            reason: { code: "managed_by_agent" },
          }),
        ],
      })
    await openDialog()
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    expect(
      within(dialog()).getByRole("checkbox", { name: /Cline/ })
    ).toBeDisabled()
    expect(dialog()).toHaveTextContent("The file is not valid JSON.")
    expect(dialog()).toHaveTextContent(
      "The agent manages this file itself; Codeg only lists its servers."
    )
  })

  it("says who a typed name is taken by, and asks before replacing it", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        agents: [
          rawPlanAgent("claude_code", {
            entries: [
              {
                key: "team-notes",
                owner: "other_item",
                item_id: "other",
                item_ref: "someone.example/team-notes",
              },
            ],
          }),
          rawPlanAgent("codex", {
            transports: ["stdio", "http"],
            entries: [
              {
                key: "team-notes",
                owner: "elsewhere",
                item_id: null,
                item_ref: null,
              },
            ],
          }),
        ],
      })
    await openDialog()
    await fillToken(user)
    const name = within(dialog()).getByLabelText("Server name")
    await user.clear(name)
    await user.type(name, "team-notes")
    const body = dialog()
    expect(body).toHaveTextContent(
      "Has a server named team-notes (from another SRN Harness item): tick it below to replace it"
    )
    expect(body).toHaveTextContent(
      "Has a server named team-notes (not from SRN Harness)"
    )
    expect(body).toHaveTextContent(
      "Installed from another SRN Harness item: someone.example/team-notes"
    )
    expect(button("Install")).toBeDisabled()
    await user.click(
      within(body).getByRole("checkbox", { name: "Replace it in Claude Code" })
    )
    await user.click(
      within(body).getByRole("checkbox", { name: "Replace it in Codex" })
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]).toMatchObject({
      key: "team-notes",
      replace: ["claude_code", "codex"],
    })
  })
})

describe("Harness install dialog — parameters", () => {
  it("offers a boolean as a choice, and checks numbers", async () => {
    const user = userEvent.setup()
    backend.harness_mcp_plan = () =>
      rawPlan({
        options: [
          rawStdioOption({
            parameters: [
              rawParameter({
                key: "env.VERBOSE",
                name: "VERBOSE",
                required: false,
                secret: false,
                kind: "boolean",
              }),
              rawParameter({
                key: "env.PORT",
                name: "PORT",
                required: true,
                secret: false,
                kind: "integer",
              }),
            ],
          }),
        ],
      })
    await openDialog()
    await screen.findByRole("heading", { name: "Install Acme Notes" })
    await user.click(within(dialog()).getByRole("radio", { name: "true" }))
    await user.type(within(dialog()).getByLabelText("PORT"), "80.5")
    expect(dialog()).toHaveTextContent("Enter a whole number.")
    expect(button("Install")).toBeDisabled()
    await user.clear(within(dialog()).getByLabelText("PORT"))
    await user.type(within(dialog()).getByLabelText("PORT"), "8080")
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_mcp_install")[0]?.values).toEqual({
      "env.VERBOSE": "true",
      "env.PORT": "8080",
    })
  })
})

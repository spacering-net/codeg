import { useEffect } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  reconnect: new Set<() => void>(),
  mobile: false,
  desktop: true,
  remote: null as null | { connection: { name: string; base_url: string } },
  openSettingsWindow: vi.fn(async () => {}),
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
    onReconnect: (callback: () => void) => {
      mocks.reconnect.add(callback)
      return () => mocks.reconnect.delete(callback)
    },
  }),
  getActiveRemoteConnectionId: () => (mocks.remote ? 7 : null),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => mocks.desktop,
  openUrl: async () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => mocks.remote,
}))
vi.mock("@/lib/api", () => ({ openSettingsWindow: mocks.openSettingsWindow }))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { DISCOVER_DETAIL, DISCOVER_FILTERS } from "@/lib/harness/discover-state"
import {
  agent,
  agentResult,
  appliedOf,
  entry,
  fingerprintOf,
  inventory,
  preflightOf,
  remote,
  resetFingerprints,
  stdio,
} from "@/lib/mcp/test-fixtures"
import type {
  McpAppType,
  McpApplyArgs,
  McpApplyResult,
  McpInventory,
  McpOp,
} from "@/lib/mcp/types"
import { MASK } from "@/lib/mcp/secrets"
import { McpSection } from "./mcp-section"
import { fitFaces } from "./mcp-server-list"

// ─── A stand-in engine ────────────────────────────────────────────────

/**
 * Just enough of the engine to carry a save through: it holds the files'
 * contents as an inventory, answers a preflight from it, and applies ops to
 * it — so the page reads back what it wrote. Tests swap its answers where
 * they want something else to happen.
 */
let files: McpInventory
let applyAnswer: ((args: McpApplyArgs) => McpApplyResult | undefined) | null
const applied: McpApplyArgs[] = []

function applyOps(ops: McpOp[]) {
  for (const op of ops) {
    const target = files.agents.find((info) => info.agent === op.agent)!
    const index = target.entries.findIndex((item) => item.key === op.key)
    const existing = target.entries[index]
    switch (op.action) {
      case "set":
        if (existing) {
          target.entries[index] = {
            ...existing,
            definition: op.definition,
            fingerprint: fingerprintOf(op.definition),
          }
        } else {
          target.entries.push(entry(op.key, op.definition))
        }
        break
      case "remove":
        if (existing) target.entries.splice(index, 1)
        break
      case "set_enabled":
        target.entries[index] = { ...existing, enabled: op.enabled }
        break
      case "rename":
        target.entries[index] = { ...existing, key: op.new_key }
        break
    }
    target.config = { ...target.config, basis: `${target.config.basis}+` }
  }
}

/** As the engine does with `basis`: required for every agent of a real run,
 *  and a file that is not what it says is reported and not written. */
function basisAnswer(request: McpApplyArgs): McpApplyResult | undefined {
  const agents = [...new Set(request.ops.map((op) => op.agent))]
  const sent = (agent: McpAppType) => request.basis?.[agent]
  const current = (agent: string) =>
    files.agents.find((info) => info.agent === agent)?.config.basis ?? null
  const missing = request.preflight
    ? []
    : agents.filter((agent) => sent(agent) === undefined)
  if (missing.length > 0) {
    return {
      outcome: "invalid",
      ok: false,
      agents: agents.map((agent) =>
        missing.includes(agent)
          ? agentResult(agent, {
              status: "invalid",
              issues: [{ code: "basis_required" }],
            })
          : agentResult(agent, { status: "not_written" })
      ),
    }
  }
  const stale = agents.filter(
    (agent) => sent(agent) !== undefined && sent(agent) !== current(agent)
  )
  if (stale.length === 0) return undefined
  return {
    outcome: "changed_elsewhere",
    ok: false,
    agents: agents.map((agent) =>
      stale.includes(agent)
        ? agentResult(agent, {
            status: "changed_elsewhere",
            basis: current(agent),
            issues: [{ code: "basis_mismatch" }],
          })
        : agentResult(agent, {
            status: request.preflight ? "ready" : "not_written",
          })
    ),
  }
}

function engine(command: string, args: unknown) {
  if (command === "mcp_inventory") return structuredClone(files)
  if (command === "mcp_apply") {
    const request = args as McpApplyArgs
    applied.push(structuredClone(request))
    const custom = applyAnswer?.(request)
    if (custom) return custom
    const refused = basisAnswer(request)
    if (refused) return refused
    if (request.preflight) return preflightOf(request.ops)
    applyOps(request.ops)
    return appliedOf(request.ops)
  }
  if (command === "mcp_parse_snippet") return pasteAnswer
  throw new Error(`unexpected command ${command}`)
}

let pasteAnswer: unknown = null

const callsOf = (command: string) =>
  mocks.call.mock.calls.filter(([name]) => name === command)

const saves = () => applied.filter((args) => !args.preflight)
const preflights = () => applied.filter((args) => args.preflight)

/** Another window — or the agent — wrote a file, and said so. */
async function emitChanged(agents: string[]) {
  await act(async () => {
    for (const handler of mocks.listeners.get("mcp://changed") ?? []) {
      handler({ agents })
    }
  })
}

// ─── Rendering ────────────────────────────────────────────────────────

type View = ReturnType<typeof useHarnessView>
let view: View

function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function Harness({ show = true }: { show?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        {show && <McpSection />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

/** The usual host: one server that two agents disagree about, a local one,
 *  and agents in every state worth testing. */
function usualFiles(): McpInventory {
  return inventory([
    agent("claude_code", [
      entry("linear", remote("sse", "https://linear.test/sse")),
      entry(
        "github",
        remote("http", "https://api.github.test/mcp", {
          Authorization: "Bearer ghp_secret_value",
        })
      ),
    ]),
    agent("codex", [
      entry("linear", remote("http", "https://linear.test/mcp"), {
        enabled: false,
      }),
      entry("fs", stdio("npx", ["-y", "fs-server"], { API_KEY: "k-123" })),
    ]),
    agent("gemini", [
      entry("linear", remote("sse", "https://linear.test/sse")),
    ]),
    agent("zcode"),
    agent("cline", [], {
      config: {
        status: "unreadable",
        basis: null,
        reason: { code: "invalid_json", detail: "expected value at line 3" },
      },
    }),
    agent("kiro", [], { installed: false }),
    agent("open_claw", [
      entry("github", remote("http", "https://api.github.test/mcp")),
    ]),
  ])
}

beforeEach(() => {
  localStorage.clear()
  resetFingerprints()
  files = usualFiles()
  applyAnswer = null
  applied.length = 0
  pasteAnswer = null
  mocks.mobile = false
  mocks.desktop = true
  mocks.remote = null
  mocks.listeners.clear()
  mocks.reconnect.clear()
  mocks.openSettingsWindow.mockClear()
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: unknown) =>
    engine(command, args)
  )
})

afterEach(() => {
  vi.useRealTimers()
})

const serverList = () => screen.getByRole("list", { name: "MCP servers" })
const rowNames = () =>
  within(serverList())
    .getAllByRole("button")
    .map((button) => button.querySelector("bdi")?.textContent)

async function openServer(
  user: ReturnType<typeof userEvent.setup>,
  key: string
) {
  const list = await screen.findByRole("list", { name: "MCP servers" })
  const row = await waitFor(() => {
    const found = within(list)
      .getAllByRole("button")
      .find((button) => button.dataset.mcpRow === key)
    if (!found) throw new Error(`no row for ${key}`)
    return found
  })
  await user.click(row)
  return screen.findByRole("article")
}

const agentRow = (detail: HTMLElement, name: string) =>
  within(detail).getByRole("switch", { name }).closest("li") as HTMLElement

const dialog = () => screen.getByRole("dialog")

// ─── By server ────────────────────────────────────────────────────────

describe("MCP — by server", () => {
  it("lists one row per key across every agent, without merging", async () => {
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    expect(rowNames()).toEqual(["fs", "github", "linear"])
    const linear = within(serverList())
      .getAllByRole("button")
      .find((button) => button.dataset.mcpRow === "linear")!
    // Two agents disagree about it: visibly so, and said in words.
    expect(within(linear).getByText("2 definitions")).toBeInTheDocument()
    expect(linear).toHaveTextContent("On in Claude Code, Gemini CLI.")
    expect(linear).toHaveTextContent("Off in Codex.")
    expect(callsOf("mcp_inventory")).toHaveLength(1)
  })

  it("shows each definition apart, and each agent's state in words", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")

    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent(
      "linear"
    )
    const definitions = within(detail)
      .getByRole("heading", { name: "Definitions" })
      .closest("section") as HTMLElement
    expect(within(definitions).getByText("Definition A")).toBeInTheDocument()
    expect(within(definitions).getByText("Definition B")).toBeInTheDocument()
    // The short words are chips beside the name: which definition, and
    // "Off" — "On" is the switch's to say.
    const chips = (name: string) =>
      Array.from(agentRow(detail, name).querySelectorAll("span.rounded-full"))
        .map((chip) => chip.textContent)
        // The switch's thumb is round too, and says nothing.
        .filter(Boolean)
    expect(chips("Claude Code")).toEqual(["Definition A"])
    expect(chips("Codex")).toEqual(["Off", "Definition B"])
    expect(chips("Gemini CLI")).toEqual(["Definition A"])
    expect(
      within(detail).getByRole("switch", { name: "Codex" })
    ).toHaveAccessibleDescription("Off Definition B")
    // Where it is not there, it says so — and, under it, why it cannot be.
    expect(chips("ZCode")).toEqual(["Not set up"])
    // ZCode runs local servers only.
    expect(agentRow(detail, "ZCode")).toHaveTextContent(
      "Cannot use HTTP, SSE servers"
    )
    expect(within(detail).getByRole("switch", { name: "ZCode" })).toBeDisabled()
    // An unreadable file stops its own agent, and nothing else.
    expect(agentRow(detail, "Cline")).toHaveTextContent(
      "Its file could not be read."
    )
    expect(agentRow(detail, "Cline")).toHaveTextContent(
      "The file is not valid JSON."
    )
    expect(within(detail).getByRole("switch", { name: "Cline" })).toBeDisabled()
    expect(
      within(detail).getByRole("switch", { name: "Claude Code" })
    ).toBeEnabled()
    // The real path, as the agent's environment makes it.
    expect(agentRow(detail, "Codex")).toHaveTextContent(
      "/home/u/.codex/config.json"
    )
  })

  it("says how far a server reaches, and copies its command as shown", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "fs")
    // Under the name: how it is reached, and in how many agents it is on —
    // said there only, not again over the agents.
    const header = within(detail).getByRole("banner")
    expect(header).toHaveTextContent("stdio")
    expect(header).toHaveTextContent("On in 1 agent")
    expect(detail.textContent?.match(/On in 1 agent| of \d+ on/g)).toEqual([
      "On in 1 agent",
    ])
    // One definition: its lines, with Edit by its title. Who holds it, the
    // agents' rows say.
    const definition = within(detail)
      .getByRole("heading", { name: "Definition" })
      .closest("section") as HTMLElement
    expect(definition).not.toHaveTextContent("Codex")
    expect(
      within(definition).getByRole("button", { name: "Edit" })
    ).toBeEnabled()
    await user.click(
      within(definition).getByRole("button", { name: "Copy the command" })
    )
    expect(await navigator.clipboard.readText()).toBe("npx -y fs-server")
  })

  it("titles each list with its count", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    expect(screen.getByText("MCP servers").textContent).toBe("MCP servers3")
    await user.click(screen.getByRole("radio", { name: "Agents" }))
    const list = await screen.findByRole("list", { name: "Agents" })
    const shown = within(list).getAllByRole("button").length
    expect(screen.getByText("Agents", { selector: "p" }).textContent).toBe(
      `Agents${shown}`
    )
  })

  it("shows a row's agents as a group of faces, the rest as a count", async () => {
    for (const index of [0, 1, 2, 3, 6]) {
      files.agents[index].entries.push(entry("shared", stdio("shared-mcp")))
    }
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    const rowOf = (key: string) =>
      within(serverList())
        .getAllByRole("button")
        .find((button) => button.dataset.mcpRow === key)!
    const faces = (row: HTMLElement) =>
      row.querySelectorAll('[data-slot="avatar"]').length
    const count = (row: HTMLElement) =>
      row.querySelector('[data-slot="avatar-group-count"]')?.textContent
    // Five agents: three faces and "+2" — one row's width, not five.
    expect(faces(rowOf("shared"))).toBe(3)
    expect(count(rowOf("shared"))).toBe("+2")
    // Four fit as they are.
    expect(faces(rowOf("fs"))).toBe(1)
    expect(count(rowOf("fs"))).toBeUndefined()
    // In words, every one of them.
    expect(rowOf("shared")).toHaveTextContent(
      "On in Claude Code, Codex, Gemini CLI, ZCode, OpenClaw."
    )
  })

  it("fits as many faces as the row has room for, in turn across definitions", () => {
    // Not measured yet: a fixed few.
    expect(fitFaces(0, [9], false)).toEqual([4])
    expect(fitFaces(0, [5, 5], true)).toEqual([3, 3])
    // 24 for the first, 18 for each more, room kept for a wide count.
    expect(fitFaces(24 + 18 * 7 + 6, [20], false)).toEqual([8])
    expect(fitFaces(400, [5], false)).toEqual([5])
    // Several definitions take turns; one with fewer agents leaves the rest.
    expect(fitFaces(12 * 2 + 10 + 24 * 2 + 18 * 6 + 6, [9, 9], true)).toEqual([
      4, 4,
    ])
    expect(fitFaces(12 * 2 + 10 + 24 * 2 + 18 * 6 + 6, [1, 9], true)).toEqual([
      1, 7,
    ])
    // Too narrow for even one each: one place each all the same.
    expect(fitFaces(10, [3, 3], true)).toEqual([1, 1])
  })

  it("says, in the list and the detail, that a server is on nowhere", async () => {
    const user = userEvent.setup()
    files.agents[1].entries[1].enabled = false
    render(<Harness />)
    const detail = await openServer(user, "fs")
    const row = within(serverList())
      .getAllByRole("button")
      .find((button) => button.dataset.mcpRow === "fs")!
    expect(row).toHaveTextContent("Off everywhere")
    expect(within(detail).getByRole("banner")).toHaveTextContent(
      "On in no agent"
    )
  })

  it("folds away agents that are not installed and hold nothing", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    expect(
      within(detail).queryByRole("switch", { name: "Kiro CLI" })
    ).toBeNull()
    await user.click(
      within(detail).getByRole("button", { name: /Show all agents/ })
    )
    expect(
      within(detail).getByRole("switch", { name: "Kiro CLI" })
    ).toBeInTheDocument()
  })
})

// ─── Switches ─────────────────────────────────────────────────────────

describe("MCP — an agent's switch", () => {
  it("turns off with the agent's own flag, keeping the definition", async () => {
    const user = userEvent.setup()
    files.agents[1].entries[0].enabled = true
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("switch", { name: "Codex" }))
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0]).toEqual({
      basis: { codex: "basis-codex-1" },
      ops: [
        {
          agent: "codex",
          key: "linear",
          action: "set_enabled",
          enabled: false,
        },
      ],
      preflight: false,
    })
    await waitFor(() =>
      expect(
        within(detail).getByRole("switch", { name: "Codex" })
      ).not.toBeChecked()
    )
    expect(screen.getByRole("status", { hidden: true })).toBeTruthy()
  })

  it("asks before removing where the agent has no off flag", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(
      within(detail).getByRole("switch", { name: "Claude Code" })
    )
    const ask = await screen.findByRole("dialog")
    expect(ask).toHaveTextContent(
      "Claude Code has no setting to switch a server off, so switching it off removes the entry from its configuration file."
    )
    expect(saves()).toHaveLength(0)
    await user.click(
      within(ask).getByRole("button", { name: "Remove from Claude Code" })
    )
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0].ops).toEqual([
      { agent: "claude_code", key: "linear", action: "remove" },
    ])
  })

  it("asks which definition to add where the agents disagree", async () => {
    const user = userEvent.setup()
    files.agents[2].entries = []
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("switch", { name: "Gemini CLI" }))
    const ask = await screen.findByRole("dialog")
    const add = within(ask).getByRole("button", { name: "Add" })
    expect(add).toBeDisabled()
    await user.click(within(ask).getAllByRole("radio")[1])
    await user.click(add)
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0].ops).toEqual([
      {
        agent: "gemini",
        key: "linear",
        action: "set",
        definition: { type: "http", url: "https://linear.test/mcp" },
      },
    ])
  })

  it("says so, and offers Retry, when another save holds the lock", async () => {
    const user = userEvent.setup()
    files.agents[1].entries[0].enabled = true
    applyAnswer = (args) =>
      args.preflight
        ? undefined
        : {
            outcome: "busy",
            ok: false,
            agents: [
              agentResult("codex", {
                status: "not_written",
                basis: null,
                issues: [{ code: "lock_busy" }],
              }),
            ],
          }
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("switch", { name: "Codex" }))
    const alert = await within(detail).findByRole("alert")
    expect(alert).toHaveTextContent("Not saved: another save was in progress.")
    applyAnswer = null
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(saves()).toHaveLength(2))
  })
})

describe("MCP — saving what the user decided on", () => {
  it("answers a question against the file as it was when the question opened", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code", [
        entry("linear", remote("sse", "https://linear.test/sse")),
      ]),
      agent("codex", [
        entry("linear", remote("http", "https://linear.test/mcp")),
      ]),
      agent("hermes", [], { config: { comments_lost_on_write: true } }),
    ])
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(
      within(detail).getByRole("switch", { name: "Hermes Agent" })
    )
    const ask = await screen.findByRole("dialog")
    expect(ask).toHaveTextContent(
      "This file has comments, and saving removes them."
    )

    // Meanwhile something else gives Hermes a server of that name.
    const theirs = entry("linear", stdio("their-linear"))
    files.agents[2].entries = [theirs]
    files.agents[2].config = {
      ...files.agents[2].config,
      basis: "basis-hermes-2",
    }
    await emitChanged(["hermes"])
    await waitFor(() =>
      expect(callsOf("mcp_inventory").length).toBeGreaterThan(1)
    )

    await user.click(within(ask).getAllByRole("radio")[0])
    await user.click(within(ask).getByRole("button", { name: "Add" }))
    await waitFor(() => expect(saves()).toHaveLength(1))
    // Sent against what was on screen, so the engine reports the change…
    expect(saves()[0].basis).toEqual({ hermes: "basis-hermes-1" })
    expect(
      await within(screen.getByRole("article")).findByText(
        /the file changed after it was read/
      )
    ).toBeInTheDocument()
    // …and the other writer's entry is still there.
    expect(files.agents[2].entries).toEqual([theirs])
  })

  it("retries a save against the same file, not a newer one", async () => {
    const user = userEvent.setup()
    files.agents[1].entries[0].enabled = true
    let busy = true
    applyAnswer = (args) =>
      args.preflight || !busy
        ? undefined
        : {
            outcome: "busy",
            ok: false,
            agents: [
              agentResult("codex", {
                status: "not_written",
                basis: null,
                issues: [{ code: "lock_busy" }],
              }),
            ],
          }
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("switch", { name: "Codex" }))
    const alert = await within(detail).findByRole("alert")

    // The save that held the lock changed Codex's file.
    busy = false
    files.agents[1].config = {
      ...files.agents[1].config,
      basis: "basis-codex-2",
    }
    await emitChanged(["codex"])
    await waitFor(() =>
      expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled()
    )
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(saves()).toHaveLength(2))
    expect(saves()[1].basis).toEqual({ codex: "basis-codex-1" })
    expect(
      await within(detail).findByText(/the file changed after it was read/)
    ).toBeInTheDocument()
  })
})

describe("MCP — entries that take no edits are never written to", () => {
  it("leaves out a holder of the same definition whose entry is there twice", async () => {
    const user = userEvent.setup()
    const shared = remote("http", "https://shared.test/mcp")
    files = inventory([
      agent("claude_code", [entry("shared", shared)]),
      agent("kimi_code", [
        entry("shared", shared, {
          read_only: true,
          problems: [{ code: "duplicate_key", field: "headers.Authorization" }],
        }),
      ]),
    ])
    render(<Harness />)
    const detail = await openServer(user, "shared")
    await user.click(within(detail).getByRole("button", { name: "Edit" }))
    const editor = await screen.findByRole("dialog")
    const kimi = within(editor).getByRole("checkbox", { name: /Kimi Code/ })
    expect(kimi).toBeDisabled()
    expect(kimi).not.toBeChecked()
    expect(editor).toHaveTextContent(
      "headers.Authorization appears twice in this entry."
    )
    await user.type(
      within(editor).getByRole("textbox", { name: "Address" }),
      "/v2"
    )
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    await waitFor(() => expect(preflights()).toHaveLength(1))
    expect(preflights()[0].ops.map((op) => op.agent)).toEqual(["claude_code"])
  })

  it("does not offer a new server to an agent whose entry of that name takes no edits", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code"),
      agent("kimi_code", [
        entry("dup", stdio(), {
          read_only: true,
          problems: [{ code: "duplicate_key" }],
        }),
      ]),
    ])
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Add by hand/ })
    )
    const editor = await screen.findByRole("dialog")
    expect(
      within(editor).getByRole("checkbox", { name: /Kimi Code/ })
    ).toBeChecked()
    await user.type(
      within(editor).getByRole("textbox", { name: "Name" }),
      "dup"
    )
    expect(
      within(editor).getByRole("checkbox", { name: /Kimi Code/ })
    ).toBeDisabled()
    await user.type(
      within(editor).getByRole("textbox", { name: "Command" }),
      "npx"
    )
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    await waitFor(() => expect(preflights()).toHaveLength(1))
    expect(preflights()[0].ops.map((op) => op.agent)).toEqual(["claude_code"])
  })
})

describe("MCP — what can be edited", () => {
  it("offers Edit only for a definition some agent that holds it can change", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    // GitHub: Claude Code's definition, and OpenClaw's, which Codeg only
    // lists.
    const detail = await openServer(user, "github")
    expect(within(detail).getByRole("button", { name: "Edit A" })).toBeEnabled()
    const editB = within(detail).getByRole("button", { name: "Edit B" })
    expect(editB).toBeDisabled()
    expect(editB).toHaveAccessibleDescription(
      "Codeg cannot change this definition in any of the agents that have it; each agent below says why."
    )
  })

  it("does not offer Edit for a server no agent that has it can change, as Rename and Remove", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code"),
      agent("open_claw", [
        entry("notion", remote("http", "https://n.test/mcp")),
      ]),
    ])
    render(<Harness />)
    const detail = await openServer(user, "notion")
    expect(within(detail).getByRole("button", { name: "Edit" })).toBeDisabled()
    expect(
      within(detail).getByRole("button", { name: "Rename" })
    ).toBeDisabled()
    expect(detail).toHaveTextContent(
      "Codeg cannot change this server in any of the agents that have it"
    )
    // Said once, in the header, not again on the definition.
    expect(detail).not.toHaveTextContent("Codeg cannot change this definition")
  })
})

// ─── The editor ───────────────────────────────────────────────────────

describe("MCP — editing one of several definitions", () => {
  it("sends ops for that definition's agents only, after showing what will be written", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit B" }))
    const editor = await screen.findByRole("dialog")
    expect(editor).toHaveTextContent("Edit definition B of linear")
    // Applied to the agents that hold B, and only to them.
    expect(
      within(editor).getByRole("checkbox", { name: /Codex/ })
    ).toBeChecked()
    expect(
      within(editor).getByRole("checkbox", { name: /Claude Code/ })
    ).not.toBeChecked()
    expect(
      within(editor).getByRole("checkbox", { name: /Gemini CLI/ })
    ).not.toBeChecked()

    const url = within(editor).getByRole("textbox", { name: "Address" })
    await user.clear(url)
    await user.type(url, "https://linear.test/v2")
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )

    await within(editor).findByText(
      "This is what will be written. Nothing is saved until you confirm."
    )
    expect(preflights()).toEqual([
      {
        basis: { codex: "basis-codex-1" },
        ops: [
          {
            agent: "codex",
            key: "linear",
            action: "set",
            definition: { type: "http", url: "https://linear.test/v2" },
          },
        ],
        preflight: true,
      },
    ])
    expect(editor).toHaveTextContent("/home/u/.codex/config.json")
    await user.click(within(editor).getByRole("button", { name: "Save" }))
    expect(await within(editor).findByText("Saved.")).toBeInTheDocument()
    expect(saves()[0].ops.map((op) => op.agent)).toEqual(["codex"])
  })
})

describe("MCP — a new server", () => {
  async function openCreate(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Add by hand/ })
    )
    return screen.findByRole("dialog")
  }

  it("goes by default only to installed agents that can hold its transport", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const editor = await openCreate(user)
    for (const name of ["Claude Code", "Codex", "Gemini CLI", "ZCode"]) {
      expect(
        within(editor).getByRole("checkbox", { name: new RegExp(name) })
      ).toBeChecked()
    }
    // Not installed, unreadable, listed only: not ticked, and why is said.
    expect(
      within(editor).queryByRole("checkbox", { name: /Kiro CLI/ })
    ).toBeNull()
    expect(
      within(editor).getByRole("checkbox", { name: /Cline/ })
    ).toBeDisabled()
    expect(
      within(editor).getByRole("checkbox", { name: /OpenClaw/ })
    ).toBeDisabled()

    // SSE: Codex and ZCode cannot hold it.
    await user.click(within(editor).getByRole("radio", { name: "SSE" }))
    const codex = within(editor).getByRole("checkbox", { name: /Codex/ })
    expect(codex).toBeDisabled()
    expect(codex).not.toBeChecked()
    expect(editor).toHaveTextContent("Cannot use SSE servers")
  })

  it("will not take a name new servers cannot have", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const editor = await openCreate(user)
    const name = within(editor).getByRole("textbox", { name: "Name" })
    await user.type(
      within(editor).getByRole("textbox", { name: "Command" }),
      "npx"
    )

    await user.type(name, "my.server")
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    expect(editor).toHaveTextContent(
      "Use only letters, digits, - and _, up to 64 characters."
    )

    await user.clear(name)
    await user.type(name, "codeg-mcp")
    expect(editor).toHaveTextContent(
      "codeg-mcp is the name of Codeg's built-in server."
    )
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    expect(preflights()).toHaveLength(0)
    // Why the rule exists.
    expect(editor).toHaveTextContent(
      "agents such as Claude Code build the names of its tools from it"
    )
  })

  it("offers the official chrome-devtools package, exactly, and only on an empty form", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const editor = await openCreate(user)
    await user.click(
      within(editor).getByRole("button", { name: "Chrome DevTools" })
    )
    expect(within(editor).getByRole("textbox", { name: "Name" })).toHaveValue(
      "chrome-devtools"
    )
    expect(
      within(editor).getByRole("textbox", { name: "Command" })
    ).toHaveValue("npx")
    expect(
      within(editor).getByRole("textbox", { name: "Argument 2" })
    ).toHaveValue("chrome-devtools-mcp@latest")
    expect(
      within(editor).getByRole("button", { name: "Chrome DevTools" })
    ).toBeDisabled()
    expect(editor).toHaveTextContent(
      "the registry lists lookalikes under the same name"
    )
  })

  it("gives a plain-http address a word, and saves it all the same", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const editor = await openCreate(user)
    await user.type(
      within(editor).getByRole("textbox", { name: "Name" }),
      "plain"
    )
    await user.click(within(editor).getByRole("radio", { name: "HTTP" }))
    await user.type(
      within(editor).getByRole("textbox", { name: "Address" }),
      "http://mcp.example.com/mcp"
    )
    expect(editor).toHaveTextContent("This address is not HTTPS")
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    await waitFor(() => expect(preflights()).toHaveLength(1))
  })
})

describe("MCP — secrets", () => {
  it("are masked in the detail, revealed one at a time — Authorization too", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "github")
    expect(detail).not.toHaveTextContent("ghp_secret_value")
    expect(detail).toHaveTextContent(MASK)
    await user.click(
      within(detail).getByRole("button", { name: "Show Authorization" })
    )
    expect(detail).toHaveTextContent("Bearer ghp_secret_value")
  })

  it("are masked in the editor's fields and in its JSON view, which needs a deliberate step", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "fs")
    expect(detail).not.toHaveTextContent("k-123")
    await user.click(within(detail).getByRole("button", { name: "Edit" }))
    const editor = await screen.findByRole("dialog")
    const value = within(editor).getByLabelText("Value of variable 1")
    expect(value).toHaveAttribute("type", "password")

    await user.click(within(editor).getByRole("radio", { name: "JSON" }))
    const json = within(editor).getByRole("textbox", {
      name: "Definition as JSON",
    })
    expect(json).toHaveAttribute("readonly")
    expect((json as HTMLTextAreaElement).value).not.toContain("k-123")
    expect((json as HTMLTextAreaElement).value).toContain(MASK)
    await user.click(
      within(editor).getByRole("button", { name: "Show and edit" })
    )
    expect(json).not.toHaveAttribute("readonly")
    expect((json as HTMLTextAreaElement).value).toContain("k-123")
  })

  it("says they will be written in plain text to every ticked agent", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "fs")
    await user.click(within(detail).getByRole("button", { name: "Edit" }))
    const editor = await screen.findByRole("dialog")
    expect(editor).toHaveTextContent(
      "Secret values (API_KEY) are written in plain text into the configuration file of the ticked agent."
    )
  })
})

describe("MCP — the JSON view", () => {
  it("is the form, both ways, and keeps text that is not a definition", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit A" }))
    const editor = await screen.findByRole("dialog")
    await user.click(within(editor).getByRole("radio", { name: "JSON" }))
    const json = within(editor).getByRole("textbox", {
      name: "Definition as JSON",
    })
    fireEvent.change(json, {
      target: { value: '{"type": "sse", "url": "https://linear.test/v3"}' },
    })
    await user.click(within(editor).getByRole("radio", { name: "Form" }))
    expect(
      within(editor).getByRole("textbox", { name: "Address" })
    ).toHaveValue("https://linear.test/v3")

    await user.click(within(editor).getByRole("radio", { name: "JSON" }))
    fireEvent.change(
      within(editor).getByRole("textbox", { name: "Definition as JSON" }),
      {
        target: { value: '{"type": "sse", "url": ' },
      }
    )
    expect(editor).toHaveTextContent("This is not valid JSON.")
    // Not dropped: the form cannot be gone back to until it is fixed or
    // discarded on purpose.
    await user.click(within(editor).getByRole("radio", { name: "Form" }))
    expect(
      within(editor).getByRole("textbox", { name: "Definition as JSON" })
    ).toHaveValue('{"type": "sse", "url": ')
    expect(editor).toHaveTextContent(
      "Fix the JSON before going back to the form"
    )
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    expect(preflights()).toHaveLength(0)
  })
})

describe("MCP — what will be written", () => {
  it("lists files, warnings and what stops the save, and does not save past a block", async () => {
    const user = userEvent.setup()
    applyAnswer = (args) =>
      args.preflight
        ? {
            outcome: "preflight",
            ok: false,
            agents: [
              agentResult("claude_code", {
                ops: [{ index: 0, key: "linear", effect: "updated" }],
                writes: [
                  {
                    path: "/home/u/.claude.json",
                    role: "servers",
                    creates: false,
                  },
                  {
                    path: "/home/u/.claude/settings.json",
                    role: "plugin_gate",
                    creates: true,
                  },
                ],
                warnings: [{ code: "fields_dropped", detail: "cwd, env_vars" }],
              }),
              agentResult("gemini", {
                status: "invalid",
                issues: [
                  {
                    code: "edit_failed",
                    op_index: 1,
                    key: "linear",
                    detail: "bad comment",
                  },
                ],
              }),
            ],
          }
        : undefined
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit A" }))
    const editor = await screen.findByRole("dialog")
    await user.click(within(editor).getByRole("radio", { name: "stdio" }))
    await user.type(
      within(editor).getByRole("textbox", { name: "Command" }),
      "linear-mcp"
    )
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )

    await within(editor).findByText(
      "Some of this cannot be written, so none of it will be. Each agent says why."
    )
    expect(editor).toHaveTextContent("/home/u/.claude/settings.json")
    expect(editor).toHaveTextContent("New file")
    expect(editor).toHaveTextContent(
      "Fields only the other kind of server uses were removed: cwd, env_vars."
    )
    expect(editor).toHaveTextContent(
      "Codeg could not change the file in place."
    )
    expect(editor).toHaveTextContent("bad comment")
    expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled()
  })
})

describe("MCP — results", () => {
  async function saveAnEdit(user: ReturnType<typeof userEvent.setup>) {
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit A" }))
    const editor = await screen.findByRole("dialog")
    const url = within(editor).getByRole("textbox", { name: "Address" })
    await user.type(url, "/v2")
    await user.click(
      within(editor).getByRole("button", { name: "Review changes" })
    )
    await user.click(
      await within(editor).findByRole("button", { name: "Save" })
    )
    return editor
  }

  it("never says Saved for a save that failed part-way, and points at the copy from before", async () => {
    const user = userEvent.setup()
    applyAnswer = (args) =>
      args.preflight
        ? undefined
        : {
            outcome: "write_failed",
            ok: false,
            agents: [
              agentResult("claude_code", {
                status: "restore_skipped",
                issues: [
                  {
                    code: "changed_after_write",
                    field: "/home/u/.claude.json",
                  },
                ],
                backup_paths: [
                  "/home/u/.codeg/mcp/backups/claude_code/.claude.json.bak",
                ],
              }),
              agentResult("gemini", {
                status: "write_failed",
                issues: [
                  { code: "write_failed", detail: "No space left on device" },
                ],
              }),
            ],
          }
    render(<Harness />)
    const editor = await saveAnEdit(user)
    await within(editor).findByText(/The save failed part-way/)
    expect(within(editor).queryByText("Saved.")).toBeNull()
    expect(editor).toHaveTextContent("Left as another program changed it")
    expect(editor).toHaveTextContent(
      "/home/u/.codeg/mcp/backups/claude_code/.claude.json.bak"
    )
    expect(editor).toHaveTextContent("Writing the file failed.")
    expect(editor).toHaveTextContent("No space left on device")
  })

  it("reads the files again and asks again when one changed elsewhere", async () => {
    const user = userEvent.setup()
    let failed = false
    applyAnswer = (args) => {
      if (args.preflight || failed) return undefined
      failed = true
      return {
        outcome: "changed_elsewhere",
        ok: false,
        agents: [
          agentResult("claude_code", {
            status: "changed_elsewhere",
            basis: "basis-claude_code-2",
            issues: [{ code: "basis_mismatch" }],
          }),
          agentResult("gemini", { status: "not_written" }),
        ],
      }
    }
    render(<Harness />)
    const reads = () => callsOf("mcp_inventory").length
    const editor = await saveAnEdit(user)
    const before = reads()
    await within(editor).findByText(
      "A file changed after it was read. This is what would be written now."
    )
    expect(reads()).toBeGreaterThan(before - 1)
    expect(preflights()).toHaveLength(2)
    await user.click(within(editor).getByRole("button", { name: "Save" }))
    expect(await within(editor).findByText("Saved.")).toBeInTheDocument()
  })

  it("says another save is in progress, and tries again on Retry", async () => {
    const user = userEvent.setup()
    let busy = true
    applyAnswer = (args) =>
      args.preflight || !busy
        ? undefined
        : {
            outcome: "busy",
            ok: false,
            agents: [
              agentResult("claude_code", {
                status: "not_written",
                basis: null,
                issues: [{ code: "lock_busy" }],
              }),
              agentResult("gemini", {
                status: "not_written",
                basis: null,
                issues: [{ code: "lock_busy" }],
              }),
            ],
          }
    render(<Harness />)
    const editor = await saveAnEdit(user)
    await within(editor).findByText(
      "Another save was in progress, so nothing was written. Try again."
    )
    busy = false
    await user.click(within(editor).getByRole("button", { name: "Retry" }))
    expect(await within(editor).findByText("Saved.")).toBeInTheDocument()
    expect(saves()).toHaveLength(2)
  })
})

// ─── Remove, rename ───────────────────────────────────────────────────

describe("MCP — remove and rename", () => {
  it("removes from the agents ticked, all of them by default", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Remove…" }))
    const ask = await screen.findByRole("dialog")
    const boxes = within(ask).getAllByRole("checkbox")
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
    ])
    await user.click(boxes[1]) // Codex keeps it.
    await user.click(
      within(ask).getByRole("button", { name: "Review changes" })
    )
    await user.click(await within(ask).findByRole("button", { name: "Save" }))
    await within(ask).findByText("Saved.")
    expect(saves()[0].ops).toEqual([
      { agent: "claude_code", key: "linear", action: "remove" },
      { agent: "gemini", key: "linear", action: "remove" },
    ])
  })

  it("renames in every agent that has it, as one server", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Rename" }))
    const ask = await screen.findByRole("dialog")
    const input = within(ask).getByRole("textbox", { name: "New name" })
    await user.clear(input)
    await user.type(input, "issues")
    await user.click(
      within(ask).getByRole("button", { name: "Review changes" })
    )
    await user.click(await within(ask).findByRole("button", { name: "Save" }))
    await within(ask).findByText("Saved.")
    expect(saves()[0].ops).toEqual(
      ["claude_code", "codex", "gemini"].map((id) => ({
        agent: id,
        key: "linear",
        action: "rename",
        new_key: "issues",
      }))
    )
    await user.click(within(ask).getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(screen.getByRole("article")).toHaveTextContent("issues")
    )
  })

  it("does not offer edits on a read-only entry, and says why", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code", [
        entry("dup", stdio(), {
          read_only: true,
          problems: [{ code: "duplicate_key", field: "env.TOKEN" }],
        }),
        entry("fine"),
      ]),
    ])
    render(<Harness />)
    const detail = await openServer(user, "dup")
    expect(
      within(detail).getByRole("button", { name: "Rename" })
    ).toBeDisabled()
    expect(
      within(detail).getByRole("button", { name: "Remove…" })
    ).toBeDisabled()
    expect(
      within(detail).getByRole("switch", { name: "Claude Code" })
    ).toBeDisabled()
    expect(detail).toHaveTextContent(
      "env.TOKEN appears twice in this entry. Codeg does not change it until the file is fixed by hand."
    )
    // The other entry of the same file is untouched by it.
    const other = await openServer(user, "fine")
    expect(within(other).getByRole("button", { name: "Rename" })).toBeEnabled()
  })

  it("lists a name twice where YAML has it twice, and changes neither", async () => {
    const user = userEvent.setup()
    // `1` and `"1"` read as one name: the engine lists both, each marked.
    const twice = () =>
      entry("1", stdio(), {
        read_only: true,
        problems: [{ code: "duplicate_key" }],
      })
    files = inventory([agent("hermes", [twice(), twice()]), agent("gemini")])
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<Harness />)
      const detail = await openServer(user, "1")
      // One agent: named once, counted once.
      expect(detail).toHaveTextContent("in 1 agent")
      expect(
        within(detail).getAllByRole("switch", { name: "Hermes Agent" })
      ).toHaveLength(1)
      expect(
        within(detail).getByRole("switch", { name: "Hermes Agent" })
      ).toBeDisabled()
      expect(
        within(detail).getByRole("button", { name: "Rename" })
      ).toBeDisabled()
      expect(detail).toHaveTextContent(
        "This name appears twice in the file. Codeg does not change it until the file is fixed by hand."
      )
      // Both entries are in the agent's own list.
      await user.click(screen.getByRole("radio", { name: "Agents" }))
      await user.click(
        within(screen.getByRole("list", { name: "Agents" }))
          .getAllByRole("button")
          .find((button) => button.dataset.mcpRow === "hermes")!
      )
      const page = await screen.findByRole("article")
      expect(within(page).getAllByRole("switch", { name: "1" })).toHaveLength(2)
      // And nothing about the repeated name upset React's lists.
      expect(
        errors.mock.calls.some((call) => String(call[0]).includes("same key"))
      ).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  it("keeps the built-in server's name out of reach", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code", [
        entry("codeg-mcp", stdio(), {
          reserved: true,
          read_only: true,
          problems: [{ code: "reserved_key" }],
        }),
      ]),
    ])
    render(<Harness />)
    const detail = await openServer(user, "codeg-mcp")
    expect(within(detail).getByRole("button", { name: "Edit" })).toBeDisabled()
    expect(
      within(detail).getByRole("button", { name: "Rename" })
    ).toBeDisabled()
    expect(detail).toHaveTextContent("is the name of Codeg's built-in server")
  })
})

// ─── Paste ────────────────────────────────────────────────────────────

describe("MCP — paste", () => {
  it("reads the servers, has broken names fixed, and writes each where it can go", async () => {
    const user = userEvent.setup()
    pasteAnswer = {
      format: "json_servers",
      servers: [
        {
          key: "docs",
          definition: { type: "stdio", command: "uvx", args: ["docs-mcp"] },
          extra: { disabled: false },
          problems: [],
        },
        {
          key: "codeg-mcp",
          definition: {
            type: "sse",
            url: "https://e.test/sse",
            headers: { Authorization: "Bearer zzz" },
          },
          extra: {},
          problems: [{ code: "key_reserved", field: "key" }],
        },
      ],
      problems: [],
    }
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Paste configuration/ })
    )
    const paste = await screen.findByRole("dialog")
    fireEvent.change(
      within(paste).getByRole("textbox", { name: "Configuration" }),
      {
        target: { value: '{"mcpServers": {"docs": {"command": "uvx"}}}' },
      }
    )
    await user.click(within(paste).getByRole("button", { name: "Read it" }))
    await within(paste).findByText("Found 2 servers.")
    expect(callsOf("mcp_parse_snippet")[0][1]).toEqual({
      text: '{"mcpServers": {"docs": {"command": "uvx"}}}',
    })
    // Masked here too.
    expect(paste).not.toHaveTextContent("Bearer zzz")
    // The reserved name has to change first.
    expect(
      within(paste).getByRole("button", { name: "Review changes" })
    ).toBeDisabled()
    const names = within(paste).getAllByRole("textbox", { name: "Name" })
    await user.clear(names[1])
    await user.type(names[1], "events")
    await user.click(
      within(paste).getByRole("button", { name: "Review changes" })
    )
    await within(paste).findByText(/This is what will be written/)
    const ops = preflights()[0].ops
    expect(ops.filter((op) => op.key === "docs").map((op) => op.agent)).toEqual(
      ["claude_code", "codex", "gemini", "zcode"]
    )
    // SSE: not to Codex or ZCode, which cannot hold it.
    expect(
      ops.filter((op) => op.key === "events").map((op) => op.agent)
    ).toEqual(["claude_code", "gemini"])
    expect(ops[0]).toEqual({
      agent: "claude_code",
      key: "docs",
      action: "set",
      definition: { type: "stdio", command: "uvx", args: ["docs-mcp"] },
    })
  })

  it("says in words what each agent gets, and what a save costs it", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code"),
      agent("hermes", [], { config: { comments_lost_on_write: true } }),
      agent("cursor", [entry("notion", remote("http", "https://n.test/mcp"))], {
        installed: false,
      }),
    ])
    pasteAnswer = {
      format: "json_servers",
      servers: [
        {
          key: "docs",
          definition: { type: "stdio", command: "uvx", args: ["docs-mcp"] },
          extra: {},
          problems: [],
        },
      ],
      problems: [],
    }
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Paste configuration/ })
    )
    const paste = await screen.findByRole("dialog")
    fireEvent.change(
      within(paste).getByRole("textbox", { name: "Configuration" }),
      { target: { value: '{"mcpServers": {"docs": {"command": "uvx"}}}' } }
    )
    await user.click(within(paste).getByRole("button", { name: "Read it" }))
    await within(paste).findByText("Found 1 server.")
    const row = (name: RegExp) =>
      within(paste).getByRole("checkbox", { name }).closest("li")!
    // Getting every server chosen goes without saying; the cost does not.
    expect(row(/Hermes/)).toHaveTextContent(
      "Saving removes the comments in its file"
    )
    expect(row(/Hermes/)).not.toHaveTextContent("Gets")
    // Not installed, so not ticked: nothing to say of it.
    expect(
      within(paste).getByRole("checkbox", { name: /Cursor/ })
    ).not.toBeChecked()
    expect(row(/Cursor/)).not.toHaveTextContent("Gets")
    // Unticked, a save costs Hermes nothing: no warning any more.
    await user.click(within(paste).getByRole("checkbox", { name: /Hermes/ }))
    expect(row(/Hermes/)).not.toHaveTextContent("comments")
  })

  it("says why nothing was recognised", async () => {
    const user = userEvent.setup()
    pasteAnswer = {
      format: "unknown",
      servers: [],
      problems: [
        { code: "snippet_unrecognized", detail: "expected value at 1:1" },
      ],
    }
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Paste configuration/ })
    )
    const paste = await screen.findByRole("dialog")
    fireEvent.change(
      within(paste).getByRole("textbox", { name: "Configuration" }),
      {
        target: { value: "hello" },
      }
    )
    await user.click(within(paste).getByRole("button", { name: "Read it" }))
    expect(await within(paste).findByRole("alert")).toHaveTextContent(
      "Codeg found no MCP servers in this text."
    )
  })
})

// ─── Unsaved changes and refreshes ────────────────────────────────────

describe("MCP — unsaved changes", () => {
  it("asks before closing an editor that holds changes", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit A" }))
    const editor = await screen.findByRole("dialog")
    await user.type(
      within(editor).getByRole("textbox", { name: "Address" }),
      "/v2"
    )
    await user.keyboard("{Escape}")
    const ask = await screen.findByRole("alertdialog")
    expect(ask).toHaveTextContent("Discard your changes?")
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }))
    expect(
      within(dialog()).getByRole("textbox", { name: "Address" })
    ).toHaveValue("https://linear.test/sse/v2")
    await user.click(within(dialog()).getByRole("button", { name: "Close" }))
    await user.click(await screen.findByRole("button", { name: "Discard" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps the edit through a refresh, and says so when the definition changed elsewhere", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.click(within(detail).getByRole("button", { name: "Edit B" }))
    const editor = await screen.findByRole("dialog")
    await user.type(
      within(editor).getByRole("textbox", { name: "Address" }),
      "/mine"
    )

    // Another file changes: the edit is untouched.
    files.agents[0].config.basis = "basis-claude_code-9"
    await emitChanged(["claude_code"])
    await waitFor(() =>
      expect(callsOf("mcp_inventory").length).toBeGreaterThan(1)
    )
    expect(
      within(editor).getByRole("textbox", { name: "Address" })
    ).toHaveValue("https://linear.test/mcp/mine")
    expect(within(editor).queryByRole("alert")).toBeNull()

    // Codex's definition changes: said, with a choice; nothing overwritten.
    files.agents[1].entries[0] = entry(
      "linear",
      remote("http", "https://linear.test/theirs"),
      { enabled: false }
    )
    await emitChanged(["codex"])
    const alert = await within(editor).findByRole("alert")
    expect(alert).toHaveTextContent(
      "This server was changed elsewhere since you opened it."
    )
    expect(
      within(editor).getByRole("textbox", { name: "Address" })
    ).toHaveValue("https://linear.test/mcp/mine")
    expect(
      within(editor).getByRole("button", { name: "Review changes" })
    ).toBeDisabled()
    await user.click(within(alert).getByRole("button", { name: "Reload" }))
    expect(
      within(editor).getByRole("textbox", { name: "Address" })
    ).toHaveValue("https://linear.test/theirs")
  })
})

// ─── Events, targets, leaving and coming back ─────────────────────────

describe("MCP — reading the configuration", () => {
  it("reads once per visit and once per mcp://changed", async () => {
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    expect(callsOf("mcp_inventory")).toHaveLength(1)
    await emitChanged(["codex"])
    await emitChanged(["claude_code", "gemini"])
    await waitFor(() => expect(callsOf("mcp_inventory")).toHaveLength(3))
  })

  it("is back as it was after a trip away: view, search, selection and an open editor", async () => {
    const user = userEvent.setup()
    const page = render(<Harness />)
    const detail = await openServer(user, "linear")
    await user.type(
      screen.getByRole("textbox", { name: "Search servers" }),
      "lin"
    )
    await user.click(within(detail).getByRole("button", { name: "Edit A" }))
    const editor = await screen.findByRole("dialog")
    await user.type(
      within(editor).getByRole("textbox", { name: "Address" }),
      "/kept"
    )

    page.rerender(<Harness show={false} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    page.rerender(<Harness />)

    // Behind the editor, which is open again: out of the accessibility tree
    // while the dialog is modal, but there.
    expect(
      screen.getByRole("textbox", { name: "Search servers", hidden: true })
    ).toHaveValue("lin")
    expect(screen.getByRole("article", { hidden: true })).toHaveTextContent(
      "linear"
    )
    expect(
      within(await screen.findByRole("dialog")).getByRole("textbox", {
        name: "Address",
      })
    ).toHaveValue("https://linear.test/sse/kept")
  })

  it("opens a server asked for from outside, and says so for one that is not there", async () => {
    const page = render(<Harness show={false} />)
    act(() => {
      view.open({ section: "mcp", serverKey: "github" })
    })
    page.rerender(<Harness />)
    const detail = await screen.findByRole("article")
    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent(
      "github"
    )

    act(() => {
      view.open({ section: "mcp", serverKey: "nowhere" })
    })
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "H2" &&
          element.textContent === "No agent here has a server named nowhere."
      )
    ).toBeInTheDocument()
  })

  it.each([
    [
      null,
      true,
      "This Codeg is too old for the MCP section. Update it to manage MCP servers here.",
    ],
    [
      { connection: { name: "box", base_url: "https://10.0.0.5:3080" } },
      true,
      "The Codeg on the remote host is too old for the MCP section.",
    ],
    [null, false, "The Codeg server is too old for the MCP section."],
  ])(
    "says which Codeg is too old (remote %#)",
    async (remote, desktop, message) => {
      mocks.remote = remote
      mocks.desktop = desktop
      mocks.call.mockImplementation(async () => {
        throw {
          code: "not_implemented",
          message: "API endpoint is not available in web mode",
        }
      })
      render(<Harness />)
      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(message)
      expect(screen.queryByRole("textbox")).toBeNull()
    }
  )

  it("shows what a newer Codeg sends as unknown, without falling over", async () => {
    const user = userEvent.setup()
    files = inventory([
      agent("claude_code", [
        entry("odd", stdio(), { problems: [{ code: "weird_new_code" }] }),
      ]),
      {
        ...agent("future_agent", [entry("odd", stdio())]),
        agent: "future_agent",
      },
    ])
    render(<Harness />)
    const detail = await openServer(user, "odd")
    expect(detail).toHaveTextContent(
      "A problem this Codeg does not know: weird_new_code."
    )
    expect(agentRow(detail, "future_agent")).toHaveTextContent("Unknown agent")
    expect(
      within(detail).getByRole("switch", { name: "future_agent" })
    ).toBeDisabled()
  })
})

// ─── By agent ─────────────────────────────────────────────────────────

describe("MCP — by agent", () => {
  it("shows an agent's real path, its file's state, how servers reach its sessions, and the built-in server", async () => {
    const user = userEvent.setup()
    files.agents[0].session_capabilities = {
      http: true,
      sse: false,
      recorded_at: "2026-11-15T14:21:07Z",
    }
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("radio", { name: "Agents" }))
    const agents = screen.getByRole("list", { name: "Agents" })
    await user.click(
      within(agents)
        .getAllByRole("button")
        .find((button) => button.dataset.mcpRow === "claude_code")!
    )
    const page = await screen.findByRole("article")
    expect(page).toHaveTextContent("/home/u/.claude_code/config.json")
    expect(page).toHaveTextContent(
      "Codeg sends the servers that are on to the agent when a session starts."
    )
    expect(page).toHaveTextContent("did not declare SSE")
    // The SSE server is on, and skipped in its sessions.
    expect(page).toHaveTextContent("Skipped in sessions")
    expect(page).toHaveTextContent("codeg-mcp (built in)")
    await user.click(
      within(page).getByRole("button", { name: "Open Settings" })
    )
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith("collaboration")
  })

  it("says why an unreadable file's servers are not known", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("radio", { name: "Agents" }))
    const agents = screen.getByRole("list", { name: "Agents" })
    await user.click(
      within(agents)
        .getAllByRole("button")
        .find((button) => button.dataset.mcpRow === "cline")!
    )
    const page = await screen.findByRole("article")
    expect(page).toHaveTextContent("The file is not valid JSON.")
    expect(page).toHaveTextContent("expected value at line 3")
    expect(page).toHaveTextContent(
      "Its file could not be read, so its servers are not known."
    )
  })
})

describe("MCP — Find on Harness", () => {
  it("switches to Discover, on its MCP servers", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole("list", { name: "MCP servers" })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: /Find on SRN Harness/ })
    )
    expect(view.section).toBe("discover")
    expect(view.slots.get(DISCOVER_FILTERS)).toMatchObject({
      kind: "mcp",
      text: "",
    })
    expect(view.slots.get(DISCOVER_DETAIL)).toBeNull()
  })
})

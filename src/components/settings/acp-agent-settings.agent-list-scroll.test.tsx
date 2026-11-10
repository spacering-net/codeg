/**
 * The agent list scrolls itself for two reasons only: to bring the agent the
 * user selects into view, and to bring it back after a reload rebuilds the
 * list at the top. Dragging an agent reorders the list on every row it passes,
 * and scrolling to the selected agent then pulled the list away from the
 * pointer mid-drag.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ElementType } from "react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgents, acpReorderAgents, listModelProviders } from "@/lib/api"
import type { AcpAgentInfo, AgentType } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls the panel makes that a test does not set up never settle.
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

// jsdom does no layout, so motion never sees a dragged row pass another and a
// real drag cannot be driven here. The real Reorder components still render
// the list; these wrappers only hand the test the callbacks a drag fires.
const drag = vi.hoisted(() => ({
  values: [] as unknown[],
  reorder: null as ((next: unknown[]) => void) | null,
  drop: new Map<string, () => void>(),
}))
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  const { createElement } = await import("react")
  function Group(props: Record<string, unknown>) {
    drag.values = props.values as unknown[]
    drag.reorder = props.onReorder as (next: unknown[]) => void
    return createElement(actual.Reorder.Group as ElementType, props)
  }
  function Item(props: Record<string, unknown>) {
    drag.drop.set(
      props["data-agent-type"] as string,
      props.onDragEnd as () => void
    )
    return createElement(actual.Reorder.Item as ElementType, props)
  }
  return { ...actual, Reorder: { Group, Item } }
})

function agent(overrides: Partial<AcpAgentInfo>): AcpAgentInfo {
  return {
    agent_type: "gemini",
    skills_capable: true,
    registry_id: "gemini",
    registry_version: "0.60.0",
    supports_custom_version: true,
    name: "Gemini CLI",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "0.60.0",
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
    ...overrides,
  }
}

const GEMINI = agent({})
const GROK = agent({
  agent_type: "grok",
  registry_id: "grok-build",
  registry_version: "1.0.41",
  name: "Grok",
  sort_order: 1,
  installed_version: "1.0.41",
})
const OPENCODE = agent({
  agent_type: "open_code",
  registry_id: "opencode",
  registry_version: "1.18.33",
  name: "OpenCode",
  distribution_type: "binary",
  sort_order: 2,
  installed_version: "1.18.33",
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

let scrollIntoView: MockInstance<Element["scrollIntoView"]>

function row(agentType: AgentType) {
  return document.querySelector<HTMLElement>(`[data-agent-type="${agentType}"]`)
}

function rowOrder() {
  return Array.from(document.querySelectorAll("[data-agent-type]"), (element) =>
    element.getAttribute("data-agent-type")
  )
}

/** The rows the list scrolled into view, oldest first. */
function revealed() {
  return (scrollIntoView.mock.contexts as Element[]).map((element) =>
    element.getAttribute("data-agent-type")
  )
}

function select(agentType: AgentType) {
  const target = row(agentType)
  if (!target) throw new Error(`no list row for ${agentType}`)
  return userEvent.setup().click(target)
}

/** Reports a new order the way a drag does each time a row passes another. */
function dragTo(order: AgentType[]) {
  const reorder = drag.reorder
  if (!reorder) throw new Error("the agent list is not rendered")
  const byType = new Map(
    (drag.values as AcpAgentInfo[]).map((value) => [value.agent_type, value])
  )
  act(() => reorder(order.map((agentType) => byType.get(agentType))))
}

/** Ends the drag, which saves the new order. */
async function drop(agentType: AgentType) {
  const onDragEnd = drag.drop.get(agentType)
  if (!onDragEnd) throw new Error(`no list row for ${agentType}`)
  await act(async () => {
    onDragEnd()
  })
}

async function renderPanel(agents: AcpAgentInfo[]) {
  vi.mocked(acpListAgents).mockResolvedValue(agents)
  vi.mocked(listModelProviders).mockResolvedValue([])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByText("Agent List")
}

beforeEach(() => {
  // Reset, not just clear: a test's mockResolvedValue/mockImplementation must
  // not reach the next one, and restoreAllMocks only takes down spyOn spies —
  // resetting puts every stubbed api function back on its never-settling stub.
  vi.resetAllMocks()
  scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView")
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AcpAgentSettings — agent list scrolling", () => {
  it("brings the agent the user selects into view", async () => {
    await renderPanel([GEMINI, GROK, OPENCODE])
    // The first agent is selected for the user when the list loads.
    await waitFor(() => expect(revealed()).toEqual(["gemini"]))

    await select("open_code")
    await waitFor(() => expect(revealed()).toEqual(["gemini", "open_code"]))
  })

  it("leaves the list where it is while an agent is dragged", async () => {
    vi.mocked(acpReorderAgents).mockResolvedValue(undefined)
    await renderPanel([GEMINI, GROK, OPENCODE])
    await select("open_code")
    await waitFor(() => expect(revealed()).toEqual(["gemini", "open_code"]))
    scrollIntoView.mockClear()

    // Gemini is dragged to the bottom, past Grok and then the selected agent.
    dragTo(["grok", "gemini", "open_code"])
    dragTo(["grok", "open_code", "gemini"])
    expect(rowOrder()).toEqual(["grok", "open_code", "gemini"])
    await drop("gemini")
    await waitFor(() =>
      expect(acpReorderAgents).toHaveBeenCalledWith([
        "grok",
        "open_code",
        "gemini",
      ])
    )
    // The handles stay disabled until the new order is saved.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Drag to reorder Gemini CLI" })
      ).toBeEnabled()
    )

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it("brings the selected agent back into view when a reload rebuilds the list", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    // The new order cannot be saved, so the panel reloads the agents; the list
    // is unmounted while they load and comes back scrolled to the top.
    vi.mocked(acpReorderAgents).mockRejectedValue(new Error("database locked"))
    await renderPanel([GEMINI, GROK, OPENCODE])
    await select("open_code")
    await waitFor(() => expect(revealed()).toEqual(["gemini", "open_code"]))
    const before = row("open_code")
    const reload = deferred<AcpAgentInfo[]>()
    vi.mocked(acpListAgents).mockImplementationOnce(() => reload.promise)

    dragTo(["grok", "open_code", "gemini"])
    await drop("gemini")
    await screen.findByText("Loading agent list...")
    expect(row("open_code")).toBeNull()
    scrollIntoView.mockClear()

    await act(async () => {
      reload.resolve([GEMINI, GROK, OPENCODE])
    })
    const rebuilt = row("open_code")
    expect(rebuilt).not.toBeNull()
    expect(rebuilt).not.toBe(before)
    await waitFor(() => expect(revealed()).toEqual(["open_code"]))
    expect(scrollIntoView.mock.contexts[0]).toBe(rebuilt)
    // The failed save is the only thing logged.
    expect(consoleError.mock.calls).toEqual([
      ["[Settings] reorder agents failed:", expect.any(Error)],
    ])
  })
})

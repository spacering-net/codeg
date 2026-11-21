import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PersonalAgentInfo } from "@/lib/types"

const api = vi.hoisted(() => ({ personalAgentSave: vi.fn() }))
vi.mock("@/lib/api", () => api)
const assistants = vi.hoisted(() => ({
  list: [] as { id: number; name: string; enabled: boolean }[],
}))
vi.mock("@/stores/assistants-store", () => ({
  useAssistants: () => assistants.list,
}))
// The executor config picked with a plain select; the editor as a button
// that "makes" one.
vi.mock("./executor-pick", async (importOriginal) => {
  const real = await importOriginal<typeof import("./executor-pick")>()
  return {
    ...real,
    ExecutorPick: ({
      value,
      onChange,
    }: {
      value: { kind: string; id?: number }
      onChange: (v: unknown) => void
    }) => (
      <select
        data-testid="executor-pick"
        value={value.kind === "existing" ? String(value.id) : value.kind}
        onChange={(e) =>
          onChange(
            e.target.value === "new"
              ? { kind: "new" }
              : { kind: "existing", id: Number(e.target.value) }
          )
        }
      >
        <option value="none">none</option>
        <option value="new">new</option>
        <option value="5">Dev</option>
        <option value="6">Off one</option>
      </select>
    ),
  }
})
vi.mock("@/components/settings/assistant-editor-dialog", () => ({
  AssistantEditorDialog: ({
    onSaved,
    prefill,
  }: {
    onSaved: (a: { id: number }) => void
    prefill: { agentType: string; name: string }
  }) => (
    <form
      data-testid="executor-editor-form"
      onSubmit={(e) => e.preventDefault()}
    >
      <button
        type="button"
        data-testid="executor-editor"
        data-agent={prefill.agentType}
        data-name={prefill.name}
        onClick={() => onSaved({ id: 9 })}
      />
    </form>
  ),
}))
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock("@/contexts/personal-agent-context", () => ({ useBotId: () => null }))
// The tiles offer these.
const acp = vi.hoisted(() => ({
  agents: [] as { agent_type: string; enabled: boolean; available: boolean }[],
}))
const CLAUDE = { agent_type: "claude_code", enabled: true, available: true }
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: acp.agents }),
}))
// The brain's editors are the assistant editor's, tested there.
vi.mock("@/components/settings/agent-options-editor", () => ({
  AgentSelect: ({ onChange }: { onChange: (a: string) => void }) => (
    <button
      type="button"
      data-testid="agent-select"
      onClick={() => onChange("claude_code")}
    />
  ),
  OptionBlock: ({ children }: { children: React.ReactNode }) => children,
  RequiredOptionRow: () => null,
  optionValueLabel: () => null,
}))
// The brain's options as the agent answers them: none read by default;
// `ready` with a required one not picked, when a test says so.
const brain = vi.hoisted(() => ({
  missing: false,
  pickModel: false,
  ready: false,
}))
vi.mock("@/components/settings/required-agent-options", () => ({
  RequiredOptionsSection: () => null,
  useRequiredOptionsGate: () => ({
    gate: brain.pickModel
      ? { kind: "pick-model" }
      : brain.missing
        ? { kind: "ready", rows: [{ kind: "select", id: "model" }] }
        : brain.ready
          ? { kind: "ready", rows: [] }
          : { kind: "unavailable-agent" },
    probe: { loading: false, reload: vi.fn() },
  }),
}))
vi.mock("@/components/settings/assistant-agent-config", async (orig) => {
  const real =
    await orig<typeof import("@/components/settings/assistant-agent-config")>()
  return {
    ...real,
    missingRows: (rows: unknown[]) => (brain.missing ? rows : []),
    rowMark: () => null,
  }
})

import { toast } from "sonner"

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { IdentityPage } from "./identity-page"

function agent(
  name: string,
  color = "blue",
  executor: number | null = null
): PersonalAgentInfo {
  return {
    id: 1,
    kind: "primary",
    name,
    avatar: { kind: "face", shape: "blob", color },
    agent_type: "claude_code",
    agent_options: {},
    label_snapshot: { agent: "Claude Code", mode: null, options: [] },
    revision: 1,
    executor_assistant_id: executor,
  } as unknown as PersonalAgentInfo
}

function page(a: PersonalAgentInfo) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <IdentityPage agent={a} bot={null} disabled={false} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  acp.agents = [CLAUDE]
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  assistants.list = []
  brain.missing = false
  brain.pickModel = false
  brain.ready = false
})

const save = () =>
  fireEvent.submit(
    document.querySelector('[data-pa-settings-page="identity"]')!
  )

describe("the identity tab", () => {
  it("leaves its name and face to the page's head: no field for them, and a save sends neither", async () => {
    api.personalAgentSave.mockResolvedValue({})
    render(page(agent("Nova")))
    expect(screen.queryByLabelText("Name")).toBeNull()
    expect(document.querySelector("[data-pa-face-picker]")).toBeNull()
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty("name")
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty("avatar")
  })

  it("picks its brain's agent from tiles, as the first setup does — from the list for one not among them", () => {
    acp.agents = [
      CLAUDE,
      { agent_type: "codex", enabled: true, available: true },
    ]
    render(page(agent("Nova")))
    const brainCard = document.querySelector("[data-pa-identity-brain]")!
    const tile = brainCard.querySelector(
      '[data-pa-setup-agent-tile="claude_code"]'
    )!
    expect(tile.getAttribute("aria-checked")).toBe("true")
    expect(
      brainCard
        .querySelector('[data-pa-setup-agent-tile="codex"]')!
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(screen.queryByTestId("agent-select")).toBeNull()
    cleanup()
    // Its agent gone from the list (or the list not read yet): the list,
    // which names the one saved.
    acp.agents = [{ agent_type: "codex", enabled: true, available: true }]
    render(page(agent("Nova")))
    expect(screen.getByTestId("agent-select")).toBeInTheDocument()
    expect(document.querySelector("[data-pa-setup-agent-tile]")).toBeNull()
    cleanup()
    acp.agents = []
    render(page(agent("Nova")))
    expect(screen.getByTestId("agent-select")).toBeInTheDocument()
  })

  it("says when there is nothing for its work to run on, and binds the one picked", async () => {
    assistants.list = [
      { id: 5, name: "Dev", enabled: true },
      { id: 6, name: "Off one", enabled: false },
    ]
    api.personalAgentSave.mockResolvedValue({})
    render(page(agent("Nova")))
    expect(document.querySelector("[data-pa-executor-missing]")).not.toBeNull()
    // Saved as it is: nothing about the executor config rides along.
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty(
      "executor_assistant_id"
    )
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty(
      "executor_new"
    )
    fireEvent.change(screen.getByTestId("executor-pick"), {
      target: { value: "5" },
    })
    expect(document.querySelector("[data-pa-executor-missing]")).toBeNull()
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(2))
    expect(api.personalAgentSave.mock.calls[1][0]).toMatchObject({
      executor_assistant_id: 5,
    })
  })

  it("warns of one turned off", () => {
    assistants.list = [{ id: 6, name: "Off one", enabled: false }]
    render(page(agent("Nova", "blue", 6)))
    expect(
      document.querySelector("[data-pa-executor-missing]")?.textContent
    ).toMatch(/turned off/)
  })

  it("makes a new one on the brain's agent, and opens the editor when its options cannot be read", async () => {
    assistants.list = [{ id: 5, name: "Dev", enabled: true }]
    api.personalAgentSave
      .mockRejectedValueOnce(
        new Error("executor options unavailable: the agent did not answer")
      )
      .mockResolvedValueOnce({})
    render(page(agent("Nova", "blue", 5)))
    fireEvent.change(screen.getByTestId("executor-pick"), {
      target: { value: "new" },
    })
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).toMatchObject({
      executor_new: true,
    })
    // Nothing saved: the editor, on the brain's agent, made one, saved
    // again with it.
    const editor = await screen.findByTestId("executor-editor")
    // The editor's own submit never saves the page.
    fireEvent.submit(screen.getByTestId("executor-editor-form"))
    expect(api.personalAgentSave).toHaveBeenCalledTimes(1)
    expect(editor.getAttribute("data-agent")).toBe("claude_code")
    expect(editor.getAttribute("data-name")).toBe("Nova")
    fireEvent.click(editor)
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(2))
    expect(api.personalAgentSave.mock.calls[1][0]).toMatchObject({
      executor_assistant_id: 9,
    })
    expect(api.personalAgentSave.mock.calls[1][0]).not.toHaveProperty(
      "executor_new"
    )
    expect(screen.queryByTestId("executor-editor")).toBeNull()
  })

  it("binds another executor config with the brain left as saved, an option it lacks since or not", async () => {
    brain.missing = true
    assistants.list = [{ id: 5, name: "Dev", enabled: true }]
    api.personalAgentSave.mockResolvedValue({})
    render(page(agent("Nova")))
    fireEvent.change(screen.getByTestId("executor-pick"), {
      target: { value: "5" },
    })
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    const draft = api.personalAgentSave.mock.calls[0][0]
    expect(draft).toMatchObject({ executor_assistant_id: 5 })
    expect(draft).not.toHaveProperty("agent_config")
  })

  it("binds another executor config while the brain's agent asks for a model to be picked, the brain left as saved", async () => {
    brain.pickModel = true
    assistants.list = [{ id: 5, name: "Dev", enabled: true }]
    api.personalAgentSave.mockResolvedValue({})
    render(page(agent("Nova")))
    fireEvent.change(screen.getByTestId("executor-pick"), {
      target: { value: "5" },
    })
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    const draft = api.personalAgentSave.mock.calls[0][0]
    expect(draft).toMatchObject({ executor_assistant_id: 5 })
    expect(draft).not.toHaveProperty("agent_config")
  })
})

describe("the first setup", () => {
  const setup = (props: { disabled?: boolean; onSaved?: () => void } = {}) =>
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <IdentityPage
          agent={null}
          bot={null}
          disabled={props.disabled ?? false}
          onSaved={props.onSaved}
        />
      </NextIntlClientProvider>
    )
  const start = () =>
    document.querySelector<HTMLButtonElement>("[data-pa-setup-start]")!

  it("takes its face, its name and its agent — no executor config to pick — and goes on to its conversation", async () => {
    brain.ready = true
    api.personalAgentSave.mockResolvedValue({})
    // Come in by a link to its persona: the page asked for waits on the
    // setup, which goes on to the conversation all the same.
    usePersonalAgentUi.getState().openBotPage("persona")
    const onSaved = vi.fn()
    setup({ onSaved })
    expect(document.querySelector("[data-pa-setup]")).not.toBeNull()
    expect(screen.queryByTestId("executor-pick")).toBeNull()
    expect(start().textContent).toBe("Chat with your agent")
    // Its agent's card says what the agent is for: its brain.
    expect(
      document.querySelector("[data-pa-setup-agent]")?.textContent
    ).toContain("Agent for its brain")
    fireEvent.click(
      document.querySelector('[data-pa-setup-agent-tile="claude_code"]')!
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Nova " },
    })
    fireEvent.click(start())
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    // Its work runs on a new executor config on the brain's agent.
    expect(api.personalAgentSave.mock.calls[0][0]).toMatchObject({
      name: "Nova",
      executor_new: true,
      agent_config: { agent_type: "claude_code" },
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    // The conversation opening says it is set up; no toast besides.
    expect(toast.message).not.toHaveBeenCalled()
  })

  it("asks for its agent first", async () => {
    setup()
    fireEvent.click(start())
    expect(await screen.findByRole("alert")).toHaveTextContent(/agent/i)
    expect(api.personalAgentSave).not.toHaveBeenCalled()
  })

  it("opens the executor config editor when the agent's options cannot be read, and saves again with the one made", async () => {
    brain.ready = true
    api.personalAgentSave
      .mockRejectedValueOnce(
        new Error("executor options unavailable: the agent did not answer")
      )
      .mockResolvedValueOnce({})
    setup()
    fireEvent.click(
      document.querySelector('[data-pa-setup-agent-tile="claude_code"]')!
    )
    fireEvent.click(start())
    const editor = await screen.findByTestId("executor-editor")
    expect(editor.getAttribute("data-agent")).toBe("claude_code")
    // The default name while the field is empty.
    expect(editor.getAttribute("data-name")).toBe("Personal agent")
    fireEvent.click(editor)
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(2))
    expect(api.personalAgentSave.mock.calls[1][0]).toMatchObject({
      executor_assistant_id: 9,
    })
  })

  it("says how many of its agent's options are still to pick, and the same when it is saved so", async () => {
    brain.missing = true
    setup()
    fireEvent.click(
      document.querySelector('[data-pa-setup-agent-tile="claude_code"]')!
    )
    expect(document.querySelector("[data-pa-setup-hint]")?.textContent).toBe(
      "Your agent has 1 option to pick"
    )
    fireEvent.click(start())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your agent has 1 option to pick"
    )
    expect(api.personalAgentSave).not.toHaveBeenCalled()
  })

  it("hangs the line under [Chat] below it, out of the flow, so its coming and going moves nothing", () => {
    brain.missing = true
    setup()
    fireEvent.click(
      document.querySelector('[data-pa-setup-agent-tile="claude_code"]')!
    )
    const line = document.querySelector<HTMLElement>("[data-pa-setup-hint]")!
    // Hung from [Chat]'s own box, under it.
    expect(line.className).toMatch(/\babsolute\b/)
    expect(line.className).toMatch(/\btop-full\b/)
    expect(line.parentElement).toBe(start().parentElement)
    expect(line.parentElement!.className).toMatch(/\brelative\b/)
  })

  it("goes side by side when wide enough: its face, name and [Chat] on the left, its agent alone scrolling on the right", () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb)
        }
        observe() {}
        disconnect() {}
      }
    )
    let width = 1200
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width }) as DOMRect)
    try {
      setup()
      const form = document.querySelector("[data-pa-setup]")!
      expect(form.getAttribute("data-pa-setup-layout")).toBe("wide")
      const agentCard = document.querySelector("[data-pa-setup-agent]")!
      // The button is not in the right half's scroller with the agent: the
      // left half is its own (scrolling only when too short to hold it).
      const scroller = agentCard.closest("[data-overlayscrollbars-initialize]")
      expect(scroller).not.toBeNull()
      expect(scroller!.contains(start())).toBe(false)
      expect(start().closest("[data-overlayscrollbars-initialize]")).not.toBe(
        scroller
      )
      expect(
        start().closest("[data-overlayscrollbars-initialize]")
      ).not.toBeNull()
      // Narrower: one column again.
      width = 700
      act(() => observers.forEach((o) => o()))
      expect(
        document
          .querySelector("[data-pa-setup]")!
          .getAttribute("data-pa-setup-layout")
      ).toBe("narrow")
    } finally {
      rect.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("is read-only while the engine runs elsewhere", () => {
    setup({ disabled: true })
    expect(start()).toBeDisabled()
    expect(screen.getByText(/read-only here/)).toBeInTheDocument()
  })
})

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
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock("@/contexts/personal-agent-context", () => ({ useBotId: () => null }))
// The tiles offer these.
const acp = vi.hoisted(() => ({
  agents: [] as {
    agent_type: string
    enabled: boolean
    available: boolean
    installed_version?: string | null
  }[],
}))
// Installed, as the agent picker reads it: available and a version.
const CLAUDE = {
  agent_type: "claude_code",
  enabled: true,
  available: true,
  installed_version: "2.1.0",
}
const CODEX = {
  agent_type: "codex",
  enabled: true,
  available: true,
  installed_version: "0.170.0",
}
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
  over: Partial<PersonalAgentInfo> = {}
): PersonalAgentInfo {
  return {
    id: 1,
    kind: "primary",
    name,
    avatar: { kind: "face", shape: "ring", color: "blue" },
    agent_type: "claude_code",
    agent_options: {},
    label_snapshot: { agent: "Claude Code", mode: null, options: [] },
    work: {
      agent_type: "claude_code",
      agent_options: {},
      label_snapshot: { agent: "Claude Code", mode: null, options: [] },
    },
    work_instructions: "",
    revision: 1,
    legacy_assistant_id: null,
    ...over,
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
    // Nothing changed: neither its brain nor its work rides along.
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty(
      "agent_config"
    )
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty("work")
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty(
      "work_instructions"
    )
  })

  it("shows its brain and its work alike: the agent picked, its model and options under it — the brain's shown, the work's folded until asked for", () => {
    brain.ready = true
    acp.agents = [CLAUDE, CODEX]
    render(page(agent("Nova")))
    for (const [which, open] of [
      ["brain", true],
      ["work", false],
    ] as const) {
      const card = document.querySelector(`[data-pa-identity-${which}]`)!
      // The agent from the list — no tiles of every agent.
      expect(card.querySelector('[data-testid="agent-select"]')).not.toBeNull()
      expect(card.querySelector("[data-pa-setup-agent-tile]")).toBeNull()
      const toggle = card.querySelector<HTMLButtonElement>(
        "[data-pa-agent-options-toggle]"
      )!
      expect(toggle.textContent).toBe("Model and options")
      const shown = () => card.querySelector("[data-pa-agent-options]")
      expect(toggle.getAttribute("aria-expanded")).toBe(String(open))
      expect(shown() !== null).toBe(open)
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe(String(!open))
      expect(shown() !== null).toBe(!open)
      fireEvent.click(toggle)
      expect(shown() !== null).toBe(open)
      if (open) {
        expect(shown()!.id).toBe(toggle.getAttribute("aria-controls"))
      }
    }
    // Neither says what the other is for.
    expect(
      document.querySelector("[data-pa-identity-work]")!.textContent
    ).not.toMatch(/brain/i)
  })

  it("unfolds its options on its own while they want a look: some still to pick, or another agent picked", () => {
    brain.missing = true
    render(page(agent("Nova")))
    for (const which of ["brain", "work"]) {
      const card = document.querySelector(`[data-pa-identity-${which}]`)!
      const toggle = card.querySelector<HTMLButtonElement>(
        "[data-pa-agent-options-toggle]"
      )!
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      expect(toggle.disabled).toBe(true)
      expect(card.querySelector("[data-pa-agent-options]")).not.toBeNull()
    }
    cleanup()
    brain.missing = false
    brain.ready = true
    acp.agents = [CLAUDE, CODEX]
    // Its work on Codex; the list picks Claude Code for it.
    render(
      page(
        agent("Nova", {
          work: {
            agent_type: "codex",
            agent_options: { config_values: {} },
            label_snapshot: { agent: "Codex", mode: null, options: [] },
          },
        })
      )
    )
    const work = document.querySelector("[data-pa-identity-work]")!
    expect(work.querySelector("[data-pa-agent-options]")).toBeNull()
    fireEvent.click(
      work.querySelector<HTMLElement>('[data-testid="agent-select"]')!
    )
    expect(work.querySelector("[data-pa-agent-options]")).not.toBeNull()
  })

  it("says when the agent its work runs on can't be used", () => {
    // Its work on Codex, which is not among the agents codeg has on.
    render(
      page(
        agent("Nova", {
          work: {
            agent_type: "codex",
            agent_options: { config_values: {} },
            label_snapshot: { agent: "Codex", mode: null, options: [] },
          },
        })
      )
    )
    expect(document.querySelector("[data-pa-work-off]")?.textContent).toContain(
      "Codex"
    )
    cleanup()
    render(page(agent("Nova")))
    expect(document.querySelector("[data-pa-work-off]")).toBeNull()
    cleanup()
    // Listed, but not installed: no version.
    acp.agents = [{ ...CLAUDE, installed_version: null }]
    render(page(agent("Nova")))
    expect(document.querySelector("[data-pa-work-off]")?.textContent).toContain(
      "Claude Code"
    )
  })

  it("changes the agent its work runs on apart from its brain (D1)", async () => {
    brain.ready = true
    acp.agents = [CLAUDE, CODEX]
    api.personalAgentSave.mockResolvedValue({})
    // Its work on Codex; the list picks Claude Code for it.
    render(
      page(
        agent("Nova", {
          work: {
            agent_type: "codex",
            agent_options: { config_values: {} },
            label_snapshot: { agent: "Codex", mode: null, options: [] },
          },
        })
      )
    )
    const work = document.querySelector("[data-pa-identity-work]")!
    fireEvent.click(
      work.querySelector<HTMLElement>('[data-testid="agent-select"]')!
    )
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    const draft = api.personalAgentSave.mock.calls[0][0]
    expect(draft).toMatchObject({
      work: { kind: "config", config: { agent_type: "claude_code" } },
    })
    expect(draft).not.toHaveProperty("agent_config")
  })

  it("saves its work's standing instructions", async () => {
    api.personalAgentSave.mockResolvedValue({})
    render(page(agent("Nova", { work_instructions: "Be brief." })))
    const box = document.querySelector<HTMLTextAreaElement>(
      "[data-pa-work-instructions]"
    )!
    expect(box.value).toBe("Be brief.")
    fireEvent.change(box, { target: { value: "Cite lines." } })
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).toMatchObject({
      work_instructions: "Cite lines.",
    })
  })

  it("has no brain to pick for one with none yet: it gets the primary's", async () => {
    api.personalAgentSave.mockResolvedValue({})
    render(
      page(
        agent("Reviewer", {
          kind: "worker",
          agent_type: null,
          agent_options: null,
          label_snapshot: null,
        })
      )
    )
    expect(document.querySelector("[data-pa-identity-brain]")).toBeNull()
    expect(screen.getByText(/no brain yet/)).toBeInTheDocument()
    expect(document.querySelector("[data-pa-identity-work]")).not.toBeNull()
    save()
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).not.toHaveProperty(
      "agent_config"
    )
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

  it("takes its face, its name and its agent — its work the same as its brain by default — and goes on to its conversation", async () => {
    brain.ready = true
    api.personalAgentSave.mockResolvedValue({})
    // Come in by a link to its persona: the page asked for waits on the
    // setup, which goes on to the conversation all the same.
    usePersonalAgentUi.getState().openBotPage("persona")
    const onSaved = vi.fn()
    setup({ onSaved })
    expect(document.querySelector("[data-pa-setup]")).not.toBeNull()
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
    // Its work on a copy of its brain.
    expect(api.personalAgentSave.mock.calls[0][0]).toMatchObject({
      name: "Nova",
      work: { kind: "same_as_brain" },
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

  it("runs its work on another agent picked apart from its brain", async () => {
    brain.ready = true
    api.personalAgentSave.mockResolvedValue({})
    setup()
    fireEvent.click(
      document.querySelector('[data-pa-setup-agent-tile="claude_code"]')!
    )
    fireEvent.click(
      document.querySelector('[data-pa-setup-work-mode="other"]')!
    )
    fireEvent.click(screen.getByTestId("agent-select"))
    fireEvent.click(start())
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSave.mock.calls[0][0]).toMatchObject({
      work: { kind: "config", config: { agent_type: "claude_code" } },
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

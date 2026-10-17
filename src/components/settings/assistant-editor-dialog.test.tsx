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

import type {
  AcpAgentInfo,
  AgentOptionsSnapshot,
  AgentType,
  AssistantInfo,
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

const api = vi.hoisted(() => ({
  describeAgentOptions: vi.fn(),
  assistantList: vi.fn(),
  assistantCreate: vi.fn(),
  assistantUpdate: vi.fn(),
  assistantDelete: vi.fn(),
  assistantReorder: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const agents = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: agents.list, fresh: true, refresh: () => {} }),
}))

// Each case drives a dozen Radix selects through several probe rounds — about
// 1–2 s on an idle machine, and several times that under a loaded full run.
vi.setConfig({ testTimeout: 20_000 })

import enMessages from "@/i18n/messages/en.json"
import { __resetAgentOptionsCacheForTests } from "@/components/automations/use-agent-options"
import { resetAssistantsStore } from "@/stores/assistants-store"
import { AssistantEditorDialog } from "./assistant-editor-dialog"

function agent(
  agentType: AgentType,
  patch: Partial<AcpAgentInfo> = {}
): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: agentType,
    enabled: true,
    available: true,
    sort_order: 0,
    ...patch,
  } as AcpAgentInfo
}

const value = (v: string, name: string): SessionConfigSelectOptionInfo => ({
  value: v,
  name,
  description: null,
})

function select(
  id: string,
  current: string,
  values: SessionConfigSelectOptionInfo[],
  patch: Partial<SessionConfigOptionInfo> = {}
): SessionConfigOptionInfo {
  return {
    id,
    name: id === "model" ? "Model" : id[0].toUpperCase() + id.slice(1),
    description: null,
    category: id === "model" ? "model" : null,
    kind: {
      type: "select",
      current_value: current,
      options: values,
      groups: [],
    },
    ...patch,
  }
}

function toggle(id: string, current: boolean): SessionConfigOptionInfo {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: null,
    category: null,
    kind: { type: "boolean", current_value: current },
  }
}

/** `unapplied: null` leaves the confirmation field out, as a backend that
 *  predates it does. */
function snapshot(
  options: SessionConfigOptionInfo[],
  unapplied: string[] | null = []
): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options: options,
    available_commands: [],
    ...(unapplied === null ? {} : { unapplied_config_ids: unapplied }),
  }
}

const MODELS = [value("model-a", "Model A"), value("model-b", "Model B")]
/** opencode-style: `effort` is listed per model, and the two lists share no
 *  value. `sandbox` and `fast` are the same for both, so a pick of them holds
 *  across a model switch. */
const EFFORTS: Record<string, SessionConfigSelectOptionInfo[]> = {
  "model-a": [value("low", "Low"), value("high", "High")],
  "model-b": [value("medium", "Medium"), value("max", "Max")],
}

/** What the agent describes while holding `held`. */
function opencodeSnapshot(
  held: string,
  unapplied: string[] | null
): AgentOptionsSnapshot {
  return snapshot(
    [
      select("model", held, MODELS, { recommended_value: "model-b" }),
      select("effort", EFFORTS[held][0].value, EFFORTS[held]),
      select("sandbox", "read-only", [
        value("read-only", "Read only"),
        value("write", "Writable"),
      ]),
      toggle("fast", true),
    ],
    unapplied
  )
}

type ProbeCfg = { model: string } | null

/**
 * A probe of the opencode-style agent. By default it switches to the model
 * asked for and confirms it; `holds` names the model it ends up on instead
 * (the snapshot then describes THAT model and lists `model` as unapplied),
 * and `unconfirmed` leaves the confirmation field out, as a backend that
 * predates it does.
 */
function opencodeProbe(
  script: {
    holds?: (asked: string | null) => string
    unconfirmed?: (asked: string | null) => boolean
  } = {}
) {
  return (_agent: AgentType, _dir: string | null, cfg: ProbeCfg) => {
    const asked = cfg?.model ?? null
    const held = script.holds?.(asked) ?? asked ?? "model-a"
    const unapplied = script.unconfirmed?.(asked)
      ? null
      : asked !== null && held !== asked
        ? ["model"]
        : []
    return Promise.resolve(opencodeSnapshot(held, unapplied))
  }
}

/** The agent stays on A when asked for B. */
const staysOnA = (asked: string | null) =>
  asked === "model-b" ? "model-a" : (asked ?? "model-a")
/** The agent stays on A when asked for a model it does not offer. */
const offeredOnly = (asked: string | null) =>
  asked !== null && asked in EFFORTS ? asked : "model-a"

const probesFor = (model: string | null) =>
  api.describeAgentOptions.mock.calls.filter(
    (call) => ((call[2] as ProbeCfg)?.model ?? null) === model
  ).length

function saved(patch: Partial<AssistantInfo> = {}): AssistantInfo {
  return {
    id: 3,
    uid: "u-3",
    name: "Reviewer",
    description: "Reviews diffs",
    avatar: { kind: "monogram", color: "teal" },
    agent_type: "open_code",
    agent_options: {
      config_values: {
        model: "model-a",
        effort: "high",
        sandbox: "write",
        fast: "false",
      },
    },
    label_snapshot: {
      agent: "OpenCode",
      mode: null,
      options: [
        { id: "model", kind: "select", name: "Model", value_label: "Model A" },
        { id: "effort", kind: "select", name: "Effort", value_label: "High" },
        {
          id: "sandbox",
          kind: "select",
          name: "Sandbox",
          value_label: "Writable",
        },
        { id: "fast", kind: "boolean", name: "Fast", value_label: "Off" },
      ],
    },
    instructions: "Cite line numbers.",
    enabled: true,
    sort_order: 1,
    revision: 1,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    deleted_at: null,
    ...patch,
  }
}

function renderEditor(assistant: AssistantInfo | null = null) {
  const onOpenChange = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AssistantEditorDialog
        open
        onOpenChange={onOpenChange}
        assistant={assistant}
      />
    </NextIntlClientProvider>
  )
  return { onOpenChange }
}

type User = ReturnType<typeof userEvent.setup>

const trigger = (label: string) => screen.getByRole("combobox", { name: label })
const queryTrigger = (label: string) =>
  screen.queryByRole("combobox", { name: label })

async function pick(user: User, label: string, option: string) {
  await user.click(trigger(label))
  const list = await screen.findByRole("listbox")
  await user.click(within(list).getByRole("option", { name: option }))
}

/** Submits an edit — the button a new assistant's form calls "Create". */
const save = (user: User) =>
  user.click(screen.getByRole("button", { name: "Save" }))

const create = (user: User) =>
  user.click(screen.getByRole("button", { name: "Create" }))

async function rename(user: User, name: string) {
  await user.clear(screen.getByLabelText("Name"))
  await user.type(screen.getByLabelText("Name"), name)
}

/** A new assistant on the opencode-style agent, model A picked and its
 *  snapshot confirmed. */
async function startOnModelA(user: User) {
  await user.type(screen.getByLabelText("Name"), "Reviewer")
  await pick(user, "Agent", "OpenCode")
  await waitFor(() => expect(trigger("Model")).toBeInTheDocument())
  await pick(user, "Model", "Model A")
  await waitFor(() => expect(trigger("Effort")).toBeInTheDocument())
}

const echoUpdate = (_id: number, patch: object) =>
  Promise.resolve({ ...saved(), ...patch, revision: 2 })

describe("AssistantEditorDialog — required options", () => {
  beforeEach(() => {
    __resetAgentOptionsCacheForTests()
    resetAssistantsStore()
    for (const fn of Object.values(api)) fn.mockReset()
    agents.list = [
      agent("open_code"),
      agent("codex"),
      agent("gemini", { enabled: false }),
      agent("grok", { available: false }),
    ]
  })
  afterEach(() => {
    __resetAgentOptionsCacheForTests()
  })

  it("starts with no agent and nothing picked: no default items, no preselection", async () => {
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    const user = userEvent.setup()
    renderEditor()
    expect(trigger("Agent")).toHaveTextContent("Select an agent")
    expect(api.describeAgentOptions).not.toHaveBeenCalled()

    await user.click(trigger("Agent"))
    let list = await screen.findByRole("listbox")
    // Disabled agents are left out; one that is not installed is listed but
    // cannot be picked.
    // By accessible name: each item carries the agent's mark, whose SVG title
    // is decorative (hidden) next to the label.
    const offered = within(list).getAllByRole("option")
    expect(offered).toHaveLength(3)
    expect(offered[0]).toHaveAccessibleName("OpenCode")
    expect(offered[1]).toHaveAccessibleName("Codex")
    expect(offered[2]).toHaveAccessibleName("Grok (not installed)")
    expect(
      within(list).getByRole("option", { name: "Grok (not installed)" })
    ).toHaveAttribute("aria-disabled", "true")
    await user.click(within(list).getByRole("option", { name: "OpenCode" }))

    // The model row comes first and empty — neither the agent's current
    // value nor its recommendation — and nothing else is offered yet.
    await waitFor(() => expect(trigger("Model")).toHaveTextContent("Select"))
    expect(queryTrigger("Effort")).toBeNull()
    expect(
      screen.getByText("Select a model to see the other options.")
    ).toBeInTheDocument()

    await user.click(trigger("Model"))
    list = await screen.findByRole("listbox")
    const models = within(list).getAllByRole("option")
    expect(models).toHaveLength(2)
    for (const option of models) {
      expect(option).toHaveAttribute("data-state", "unchecked")
    }
    // The recommendation is only a chip.
    expect(
      within(within(list).getByRole("option", { name: "Model B" })).getByText(
        "Recommended"
      )
    ).toBeInTheDocument()
    await user.click(within(list).getByRole("option", { name: "Model A" }))

    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("Select"))
    expect(api.describeAgentOptions).toHaveBeenLastCalledWith(
      "open_code",
      null,
      { model: "model-a" }
    )
    expect(trigger("Sandbox")).toHaveTextContent("Select")
    expect(trigger("Fast")).toHaveTextContent("Select")
    expect(screen.getByText("3 options still to pick")).toBeInTheDocument()

    // A switch is a two-item list, neither item chosen.
    await user.click(trigger("Fast"))
    list = await screen.findByRole("listbox")
    const switches = within(list).getAllByRole("option")
    expect(switches.map((o) => o.textContent)).toEqual(["On", "Off"])
    for (const option of switches) {
      expect(option).toHaveAttribute("data-state", "unchecked")
    }
    await user.keyboard("{Escape}")
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
  })

  it("refuses to save with options missing, flags them and focuses the first", async () => {
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    const user = userEvent.setup()
    renderEditor()
    await startOnModelA(user)
    await pick(user, "Effort", "High")

    await create(user)
    expect(api.assistantCreate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 options still to pick"
    )
    expect(trigger("Sandbox")).toHaveAttribute("aria-invalid", "true")
    expect(trigger("Fast")).toHaveAttribute("aria-invalid", "true")
    expect(trigger("Effort")).not.toHaveAttribute("aria-invalid")
    expect(trigger("Sandbox")).toHaveFocus()

    // Picking a flagged row clears its flag.
    await pick(user, "Sandbox", "Writable")
    expect(trigger("Sandbox")).not.toHaveAttribute("aria-invalid")
  })

  it("submits a complete selection with its option list, switches included", async () => {
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    const { onOpenChange } = renderEditor()
    await startOnModelA(user)
    await pick(user, "Effort", "High")
    await pick(user, "Sandbox", "Read only")
    await pick(user, "Fast", "Off")
    await create(user)

    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    const draft = api.assistantCreate.mock.calls[0][0]
    expect(draft.name).toBe("Reviewer")
    expect(draft.agent_config).toEqual({
      agent_type: "open_code",
      agent_options: {
        mode_id: null,
        config_values: {
          model: "model-a",
          effort: "high",
          sandbox: "read-only",
          fast: "false",
        },
      },
      label_snapshot: {
        agent: "OpenCode",
        mode: null,
        options: [
          {
            id: "model",
            kind: "select",
            name: "Model",
            value_label: "Model A",
          },
          {
            id: "effort",
            kind: "select",
            name: "Effort",
            value_label: "High",
          },
          {
            id: "sandbox",
            kind: "select",
            name: "Sandbox",
            value_label: "Read only",
          },
          { id: "fast", kind: "boolean", name: "Fast", value_label: "Off" },
        ],
      },
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("re-probes for a new model, keeping only the picks that still hold", async () => {
    const answerFor = opencodeProbe()
    let releaseB: () => void = () => {}
    api.describeAgentOptions.mockImplementation(
      (agentType: AgentType, dir: string | null, cfg: ProbeCfg) =>
        cfg?.model === "model-b"
          ? new Promise((resolve) => {
              releaseB = () => resolve(opencodeSnapshot("model-b", []))
            })
          : answerFor(agentType, dir, cfg)
    )
    const user = userEvent.setup()
    renderEditor()
    await startOnModelA(user)
    await pick(user, "Effort", "High")
    await pick(user, "Sandbox", "Writable")
    await pick(user, "Fast", "On")

    await pick(user, "Model", "Model B")
    await waitFor(() => expect(probesFor("model-b")).toBe(1))
    // Until B's own snapshot lands, A's rows are not offered — a value picked
    // off them would be saved for B. The model row stays usable.
    expect(trigger("Model")).toHaveTextContent("Model B")
    expect(trigger("Model")).toBeEnabled()
    expect(queryTrigger("Effort")).toBeNull()
    expect(queryTrigger("Sandbox")).toBeNull()
    expect(
      screen.getByText("Loading available options from the agent…")
    ).toBeInTheDocument()

    await act(async () => releaseB())
    await waitFor(() => expect(trigger("Effort")).toBeInTheDocument())
    // `High` is A's, not a choice for B: unpicked, and marked.
    expect(trigger("Effort")).toHaveTextContent("Select")
    expect(screen.getByText("Unavailable (was High)")).toBeInTheDocument()
    expect(trigger("Sandbox")).toHaveTextContent("Writable")
    expect(trigger("Fast")).toHaveTextContent("On")
  })

  it("blocks a model the agent did not switch to, even with every other value valid", async () => {
    // Asked for B, the agent stays on A: the snapshot is the one asked for
    // (open_code, B), it has landed, and it lists A's options — so every value
    // picked under A is valid against it.
    api.describeAgentOptions.mockImplementation(
      opencodeProbe({ holds: staysOnA })
    )
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    await startOnModelA(user)
    await pick(user, "Effort", "High")
    await pick(user, "Sandbox", "Writable")
    await pick(user, "Fast", "On")

    await pick(user, "Model", "Model B")
    await waitFor(() =>
      expect(
        screen.getByText(/didn't switch to this model/)
      ).toBeInTheDocument()
    )
    expect(api.describeAgentOptions).toHaveBeenLastCalledWith(
      "open_code",
      null,
      { model: "model-b" }
    )
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()
    expect(queryTrigger("Effort")).toBeNull()

    await create(user)
    expect(api.assistantCreate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "didn't switch to the selected model"
    )

    // Now the agent does switch: B's own options, confirmed.
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(trigger("Effort")).toBeInTheDocument())
    await pick(user, "Effort", "Max")
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(
      api.assistantCreate.mock.calls[0][0].agent_config.agent_options
        .config_values
    ).toEqual({
      model: "model-b",
      effort: "max",
      sandbox: "write",
      fast: "true",
    })
  })

  it("re-probes an unconfirmed snapshot exactly once, then treats it as not switched", async () => {
    // B answers without the confirmation field — what a backend predating it
    // sends, say from a snapshot cached across a server upgrade — and the
    // forced re-probe answers the same. Its content is A's, so every value
    // picked under A is valid against it: only the confirmation is missing.
    api.describeAgentOptions.mockImplementation(
      opencodeProbe({
        holds: staysOnA,
        unconfirmed: (asked) => asked === "model-b",
      })
    )
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    await startOnModelA(user)
    await pick(user, "Effort", "High")
    await pick(user, "Sandbox", "Writable")
    await pick(user, "Fast", "On")

    await pick(user, "Model", "Model B")
    await waitFor(() =>
      expect(
        screen.getByText(/didn't switch to this model/)
      ).toBeInTheDocument()
    )
    // The first probe, then exactly one forced re-probe…
    expect(probesFor("model-b")).toBe(2)
    // …and none after it, once every timer has had its turn.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(probesFor("model-b")).toBe(2)
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()

    await create(user)
    expect(api.assistantCreate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "didn't switch to the selected model"
    )

    // A confirmed answer (an empty list) is what unlocks the rest.
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(trigger("Effort")).toBeInTheDocument())
    await pick(user, "Effort", "Medium")
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
  })

  it("clears every option when the agent changes, and offers nothing until its snapshot lands", async () => {
    const answerFor = opencodeProbe()
    let releaseCodex: () => void = () => {}
    api.describeAgentOptions.mockImplementation(
      (agentType: AgentType, dir: string | null, cfg: ProbeCfg) =>
        agentType === "codex"
          ? new Promise((resolve) => {
              releaseCodex = () => resolve(opencodeSnapshot("model-a", []))
            })
          : answerFor(agentType, dir, cfg)
    )
    const user = userEvent.setup()
    renderEditor(saved())
    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("High"))

    await pick(user, "Agent", "Codex")
    await waitFor(() =>
      expect(api.describeAgentOptions).toHaveBeenLastCalledWith(
        "codex",
        null,
        null
      )
    )
    // OpenCode's rows — its model row included — belong to another agent.
    expect(queryTrigger("Model")).toBeNull()
    expect(queryTrigger("Effort")).toBeNull()
    expect(
      screen.getByText("Loading available options from the agent…")
    ).toBeInTheDocument()

    await act(async () => releaseCodex())
    await waitFor(() => expect(trigger("Model")).toHaveTextContent("Select"))
    expect(queryTrigger("Effort")).toBeNull()
  })

  it("shows a saved selection as saved when nothing changed, and does not resubmit it", async () => {
    api.describeAgentOptions.mockImplementation(opencodeProbe())
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(saved())
    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("High"))
    expect(trigger("Model")).toHaveTextContent("Model A")
    expect(trigger("Sandbox")).toHaveTextContent("Writable")
    expect(trigger("Fast")).toHaveTextContent("Off")
    expect(screen.queryByText(/options changed/)).toBeNull()

    await rename(user, "Renamed")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    const [id, patch] = api.assistantUpdate.mock.calls[0]
    expect(id).toBe(3)
    expect(patch.name).toBe("Renamed")
    expect(patch).not.toHaveProperty("agent_config")
  })

  it("marks what changed since the save and blocks even a rename until it is picked", async () => {
    // Since the save the agent dropped `sandbox`, withdrew `high`, and added
    // `verbosity`.
    api.describeAgentOptions.mockResolvedValue(
      snapshot([
        select("model", "model-a", MODELS),
        select("effort", "low", [
          value("low", "Low"),
          value("medium", "Medium"),
        ]),
        select("verbosity", "short", [
          value("short", "Short"),
          value("long", "Long"),
        ]),
        toggle("fast", true),
      ])
    )
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(saved())
    await waitFor(() => expect(trigger("Effort")).toBeInTheDocument())
    expect(trigger("Model")).toHaveTextContent("Model A")
    expect(trigger("Fast")).toHaveTextContent("Off")
    expect(trigger("Effort")).toHaveTextContent("Select")
    expect(screen.getByText("Unavailable (was High)")).toBeInTheDocument()
    expect(trigger("Verbosity")).toHaveTextContent("Select")
    expect(screen.getByText("New")).toBeInTheDocument()
    expect(queryTrigger("Sandbox")).toBeNull()
    expect(screen.getByText(/pick the 2 marked options/)).toBeInTheDocument()

    await rename(user, "Renamed")
    await save(user)
    expect(api.assistantUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 options still to pick"
    )

    await pick(user, "Effort", "Medium")
    await pick(user, "Verbosity", "Long")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    const patch = api.assistantUpdate.mock.calls[0][1]
    // The option the agent dropped is gone from what is submitted.
    expect(patch.agent_config.agent_options.config_values).toEqual({
      model: "model-a",
      effort: "medium",
      verbosity: "long",
      fast: "false",
    })
    expect(
      patch.agent_config.label_snapshot.options.map((o: { id: string }) => o.id)
    ).toEqual(["model", "effort", "verbosity", "fast"])
  })

  it("asks for a model again when the saved one is no longer offered", async () => {
    api.describeAgentOptions.mockImplementation(
      opencodeProbe({ holds: offeredOnly })
    )
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(
      saved({
        agent_options: { config_values: { model: "model-z", effort: "high" } },
        label_snapshot: {
          agent: "OpenCode",
          mode: null,
          options: [
            {
              id: "model",
              kind: "select",
              name: "Model",
              value_label: "Model Z",
            },
            {
              id: "effort",
              kind: "select",
              name: "Effort",
              value_label: "High",
            },
          ],
        },
      })
    )
    await waitFor(() =>
      expect(screen.getByText("Unavailable (was Model Z)")).toBeInTheDocument()
    )
    expect(trigger("Model")).toHaveTextContent("Select")
    expect(queryTrigger("Effort")).toBeNull()

    await rename(user, "Renamed")
    await save(user)
    expect(api.assistantUpdate).not.toHaveBeenCalled()
    expect(trigger("Model")).toHaveAttribute("aria-invalid", "true")
    expect(trigger("Model")).toHaveFocus()
  })

  it("cannot save a new assistant whose probe failed", async () => {
    api.describeAgentOptions.mockRejectedValue(new Error("not signed in"))
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Reviewer")
    await pick(user, "Agent", "OpenCode")
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load options: not signed in")
      ).toBeInTheDocument()
    )
    await create(user)
    expect(api.assistantCreate).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't be loaded")
  })

  it("saves an untouched edit's other fields when the probe fails, keeping its selection", async () => {
    api.describeAgentOptions.mockRejectedValue(new Error("not signed in"))
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(saved())
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load options: not signed in")
      ).toBeInTheDocument()
    )
    // The saved names stand in, read-only.
    expect(screen.getByText("Saved options")).toBeInTheDocument()
    expect(screen.getByText("Writable")).toBeInTheDocument()

    await user.clear(screen.getByLabelText("Description"))
    await user.type(screen.getByLabelText("Description"), "New blurb")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    const patch = api.assistantUpdate.mock.calls[0][1]
    expect(patch.description).toBe("New blurb")
    expect(patch).not.toHaveProperty("agent_config")
  })

  it("saves an untouched edit's other fields when the agent will not switch to the saved model", async () => {
    // Saved on B; the agent now stays on A.
    api.describeAgentOptions.mockImplementation(
      opencodeProbe({ holds: staysOnA })
    )
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(
      saved({
        agent_options: {
          config_values: {
            model: "model-b",
            effort: "max",
            sandbox: "write",
            fast: "false",
          },
        },
      })
    )
    await waitFor(() =>
      expect(
        screen.getByText(/didn't switch to this model/)
      ).toBeInTheDocument()
    )
    expect(screen.getByText("Saved options")).toBeInTheDocument()
    expect(queryTrigger("Effort")).toBeNull()

    await rename(user, "Renamed")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    const patch = api.assistantUpdate.mock.calls[0][1]
    expect(patch.name).toBe("Renamed")
    expect(patch).not.toHaveProperty("agent_config")
  })

  it("keeps a saved agent that can no longer run here, and saves the other fields", async () => {
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(
      saved({
        agent_type: "grok",
        agent_options: { config_values: { model: "grok-5" } },
        label_snapshot: {
          agent: "Grok",
          mode: null,
          options: [
            {
              id: "model",
              kind: "select",
              name: "Model",
              value_label: "Grok 5",
            },
          ],
        },
      })
    )
    expect(trigger("Agent")).toHaveTextContent("Grok")
    expect(
      screen.getByText(/This agent is disabled or not installed/)
    ).toBeInTheDocument()
    expect(screen.getByText("Grok 5")).toBeInTheDocument()

    await rename(user, "Renamed")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    expect(api.assistantUpdate.mock.calls[0][1]).not.toHaveProperty(
      "agent_config"
    )
    // No probe for an agent that cannot run.
    expect(api.describeAgentOptions).not.toHaveBeenCalled()
  })

  it("saves an agent with nothing to configure", async () => {
    api.describeAgentOptions.mockResolvedValue(snapshot([]))
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Plain")
    await pick(user, "Agent", "Codex")
    await waitFor(() =>
      expect(
        screen.getByText("This agent has no configurable options.")
      ).toBeInTheDocument()
    )
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(api.assistantCreate.mock.calls[0][0].agent_config).toEqual({
      agent_type: "codex",
      agent_options: { mode_id: null, config_values: {} },
      label_snapshot: { agent: "Codex", mode: null, options: [] },
    })
  })

  it("puts the model row first, whatever order the agent lists it in", async () => {
    // Codex-style: the approval preset comes before the model.
    api.describeAgentOptions.mockImplementation(
      (_agent: AgentType, _dir: string | null, cfg: ProbeCfg) =>
        Promise.resolve(
          snapshot([
            select("preset", "auto", [
              value("auto", "Auto"),
              value("read-only", "Read only"),
            ]),
            select("model", cfg?.model ?? "model-a", MODELS),
            toggle("fast", false),
          ])
        )
    )
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Plain")
    await pick(user, "Agent", "Codex")
    await waitFor(() => expect(trigger("Model")).toBeInTheDocument())
    await pick(user, "Model", "Model A")
    await waitFor(() => expect(trigger("Preset")).toBeInTheDocument())
    // The rows that appear once the model is picked land below it.
    expect(
      screen
        .getAllByRole("combobox")
        .map((combobox) => combobox.getAttribute("aria-label"))
    ).toEqual(["Agent", "Model", "Preset", "Fast"])

    await pick(user, "Preset", "Read only")
    await pick(user, "Fast", "On")
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(
      api.assistantCreate.mock.calls[0][0].agent_config.label_snapshot.options.map(
        (o: { id: string }) => o.id
      )
    ).toEqual(["model", "preset", "fast"])
  })

  it("takes the `model` option for the model, not another one in the model category", async () => {
    // qoder through 1.1.66 hung its effort selector off the `model` category.
    api.describeAgentOptions.mockResolvedValue(
      snapshot([
        select(
          "reasoning",
          "low",
          [value("low", "Low"), value("high", "High")],
          { category: "model" }
        ),
        select("model", "model-a", MODELS),
      ])
    )
    const user = userEvent.setup()
    renderEditor()
    await pick(user, "Agent", "Codex")
    await waitFor(() => expect(trigger("Model")).toHaveTextContent("Select"))
    expect(queryTrigger("Reasoning")).toBeNull()
    expect(
      screen.getByText("Select a model to see the other options.")
    ).toBeInTheDocument()
  })

  it("creates a new assistant enabled: switching it is the list's job", async () => {
    api.describeAgentOptions.mockResolvedValue(snapshot([]))
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    expect(screen.queryByRole("switch")).toBeNull()
    await user.type(screen.getByLabelText("Name"), "Plain")
    await pick(user, "Agent", "Codex")
    await waitFor(() =>
      expect(
        screen.getByText("This agent has no configurable options.")
      ).toBeInTheDocument()
    )
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(api.assistantCreate.mock.calls[0][0].enabled).toBe(true)
  })

  it("never sends the enabled state with an edit, so it cannot undo the list's switch", async () => {
    api.describeAgentOptions.mockResolvedValue(snapshot([]))
    api.assistantUpdate.mockImplementation(echoUpdate)
    const user = userEvent.setup()
    renderEditor(
      saved({
        enabled: false,
        agent_type: "codex",
        agent_options: { mode_id: null, config_values: {} },
        label_snapshot: { agent: "Codex", mode: null, options: [] },
      })
    )
    expect(screen.queryByRole("switch")).toBeNull()
    await waitFor(() =>
      expect(
        screen.getByText("This agent has no configurable options.")
      ).toBeInTheDocument()
    )
    await rename(user, "Renamed")
    await save(user)
    await waitFor(() => expect(api.assistantUpdate).toHaveBeenCalledTimes(1))
    const patch = api.assistantUpdate.mock.calls[0][1]
    expect(patch.name).toBe("Renamed")
    expect(patch).not.toHaveProperty("enabled")
  })

  it("never requires an option offered with no values", async () => {
    api.describeAgentOptions.mockResolvedValue(
      snapshot([select("tier", "", [])])
    )
    api.assistantCreate.mockResolvedValue(saved({ id: 9 }))
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Plain")
    await pick(user, "Agent", "Codex")
    await waitFor(() =>
      expect(trigger("Tier")).toHaveTextContent("No values offered")
    )
    expect(trigger("Tier")).toBeDisabled()
    await create(user)
    await waitFor(() => expect(api.assistantCreate).toHaveBeenCalledTimes(1))
    expect(
      api.assistantCreate.mock.calls[0][0].agent_config.agent_options
    ).toEqual({ mode_id: null, config_values: {} })
  })

  it("puts a description over the limit on its field, and clears it as soon as it is edited", async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Reviewer")
    const field = screen.getByLabelText("Description")
    fireEvent.change(field, { target: { value: "x".repeat(201) } })
    await create(user)
    // Under the field it is about, in the same row.
    expect(field.parentElement).toContainElement(
      screen.getByText("The description can be at most 200 characters.")
    )
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(field).toHaveFocus()
    // On the field, like the name's error — not a footer alert that outlives
    // the fix.
    expect(screen.queryByRole("alert")).toBeNull()
    expect(api.assistantCreate).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "x".repeat(200) } })
    expect(screen.queryByText(/The description can be at most/)).toBeNull()
    expect(field).not.toHaveAttribute("aria-invalid")
  })

  it("puts instructions over the limit on their field, and clears it as soon as they are edited", async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Reviewer")
    const field = screen.getByLabelText("Standing instructions")
    fireEvent.change(field, { target: { value: "x".repeat(20_001) } })
    await create(user)
    expect(field.parentElement).toContainElement(
      screen.getByText("The instructions can be at most 20000 characters.")
    )
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(field).toHaveFocus()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(api.assistantCreate).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "x".repeat(20_000) } })
    expect(screen.queryByText(/The instructions can be at most/)).toBeNull()
    expect(field).not.toHaveAttribute("aria-invalid")
  })

  it("puts a duplicate-name refusal on the name field, and submits once when sent twice", async () => {
    api.describeAgentOptions.mockResolvedValue(snapshot([]))
    let refuse: (err: unknown) => void = () => {}
    api.assistantCreate.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject
      })
    )
    const user = userEvent.setup()
    renderEditor()
    await user.type(screen.getByLabelText("Name"), "Reviewer")
    await pick(user, "Agent", "Codex")
    await waitFor(() =>
      expect(
        screen.getByText("This agent has no configurable options.")
      ).toBeInTheDocument()
    )
    // Two submits in one tick — Enter pressed twice — before the form
    // re-renders disabled.
    const form = screen.getByLabelText("Name").closest("form")!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(api.assistantCreate).toHaveBeenCalledTimes(1)

    await act(async () =>
      refuse({
        code: "already_exists",
        message: 'An assistant named "Reviewer" already exists',
        i18n_key: "errors.duplicateName",
        i18n_params: { name: "Reviewer" },
      })
    )
    await waitFor(() =>
      expect(
        screen.getByText("An assistant named “Reviewer” already exists.")
      ).toBeInTheDocument()
    )
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "true"
    )
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus())
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps the submit button in view: only the fields scroll", () => {
    renderEditor()
    const fields = screen.getByLabelText("Name").closest(".overflow-y-auto")
    expect(fields).not.toBeNull()
    expect(fields).not.toContainElement(
      screen.getByRole("button", { name: "Create" })
    )
  })

  it("calls the submit button Create for a new assistant and Save for an edit", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AssistantEditorDialog open onOpenChange={() => {}} assistant={null} />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute(
      "type",
      "submit"
    )
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    unmount()
    renderEditor(saved({ agent_type: "grok" }))
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "type",
      "submit"
    )
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull()
  })
})

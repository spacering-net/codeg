import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AcpAgentInfo,
  AgentOptionsSnapshot,
  AgentType,
  CommitMessageSettings,
  FolderDetail,
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

const api = vi.hoisted(() => ({
  describeAgentOptions: vi.fn(),
  getCommitMessageSettings: vi.fn(),
  setCommitMessageSettings: vi.fn(),
  deleteCommitMessageSettings: vi.fn(),
  listOpenFolderDetails: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const agents = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: agents.list, fresh: true, refresh: () => {} }),
}))

// The commit window has no workspace loaded: the dialog asks for the folders.
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (s: { folders: FolderDetail[] }) => unknown) =>
    select({ folders: [] }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Radix selects driven through several probe rounds.
vi.setConfig({ testTimeout: 20_000 })

import enMessages from "@/i18n/messages/en.json"
import { __resetAgentOptionsCacheForTests } from "@/components/automations/use-agent-options"
import { CommitMessageSettingsDialog } from "./commit-message-settings-dialog"

const value = (v: string, name: string): SessionConfigSelectOptionInfo => ({
  value: v,
  name,
  description: null,
})

function select(
  id: string,
  current: string,
  values: SessionConfigSelectOptionInfo[]
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
  }
}

const EFFORTS: Record<string, SessionConfigSelectOptionInfo[]> = {
  "model-a": [value("low", "Low"), value("high", "High")],
  "model-b": [value("medium", "Medium"), value("max", "Max")],
}

/** An agent that lists `effort` per model and switches to the model asked
 *  for. */
function probe(
  _agent: AgentType,
  _dir: string | null,
  cfg: { model: string } | null
): Promise<AgentOptionsSnapshot> {
  const held = cfg?.model ?? "model-a"
  return Promise.resolve({
    modes: null,
    config_options: [
      select("model", held, [
        value("model-a", "Model A"),
        value("model-b", "Model B"),
      ]),
      select("effort", EFFORTS[held][0].value, EFFORTS[held]),
    ],
    available_commands: [],
    unapplied_config_ids: [],
  })
}

function agent(agentType: AgentType): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: agentType,
    enabled: true,
    available: true,
    sort_order: 0,
  } as AcpAgentInfo
}

const FOLDER = { id: 7, name: "app", path: "/repo/app" } as FolderDetail

const EMPTY: CommitMessageSettings = {
  agent: null,
  instructions: "",
  auto_commit: false,
}

const ON_MODEL_B: CommitMessageSettings = {
  agent: {
    agent_type: "open_code",
    agent_options: {
      mode_id: null,
      config_values: { model: "model-b", effort: "max" },
    },
    label_snapshot: {
      agent: "OpenCode",
      mode: null,
      options: [
        { id: "model", kind: "select", name: "Model", value_label: "Model B" },
        { id: "effort", kind: "select", name: "Effort", value_label: "Max" },
      ],
    },
  },
  instructions: "Write in Chinese.",
  auto_commit: true,
}

/** Settings by scope: `null` is the global ones. */
function saved(byScope: Map<number | null, CommitMessageSettings | null>) {
  api.getCommitMessageSettings.mockImplementation((folderId: number | null) =>
    Promise.resolve(byScope.get(folderId) ?? (folderId === null ? EMPTY : null))
  )
}

function renderDialog(folderId: number | null) {
  const onOpenChange = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommitMessageSettingsDialog
        open
        onOpenChange={onOpenChange}
        folderId={folderId}
      />
    </NextIntlClientProvider>
  )
  return { onOpenChange }
}

type User = ReturnType<typeof userEvent.setup>

const trigger = (label: string) => screen.getByRole("combobox", { name: label })

async function pick(user: User, label: string, option: string) {
  await user.click(trigger(label))
  const list = await screen.findByRole("listbox")
  await user.click(within(list).getByRole("option", { name: option }))
}

const saveButton = () => screen.getByRole("button", { name: "Save" })

describe("CommitMessageSettingsDialog", () => {
  beforeEach(() => {
    __resetAgentOptionsCacheForTests()
    for (const fn of Object.values(api)) fn.mockReset()
    api.describeAgentOptions.mockImplementation(probe)
    api.setCommitMessageSettings.mockImplementation(
      (_folderId: number | null, settings: CommitMessageSettings) =>
        Promise.resolve(settings)
    )
    api.deleteCommitMessageSettings.mockResolvedValue(undefined)
    api.listOpenFolderDetails.mockResolvedValue([FOLDER])
    agents.list = [agent("open_code"), agent("codex")]
  })
  afterEach(() => {
    __resetAgentOptionsCacheForTests()
  })

  it("follows the session by default and saves the global settings", async () => {
    saved(new Map())
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog(null)
    const pin = await screen.findByRole("switch", {
      name: "Use a specific agent",
    })
    await waitFor(() => expect(pin).toBeEnabled())
    expect(pin).not.toBeChecked()
    expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull()
    expect(api.describeAgentOptions).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole("switch", { name: "Commit automatically" })
    )
    await user.type(screen.getByLabelText("Instructions"), "Write in Chinese.")
    await user.click(saveButton())

    expect(api.setCommitMessageSettings).toHaveBeenCalledWith(null, {
      agent: null,
      instructions: "Write in Chinese.",
      auto_commit: true,
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("asks for every option of a specific agent, the model first", async () => {
    saved(new Map())
    const user = userEvent.setup()
    renderDialog(null)
    const pin = await screen.findByRole("switch", {
      name: "Use a specific agent",
    })
    await waitFor(() => expect(pin).toBeEnabled())
    await user.click(pin)
    expect(trigger("Agent")).toHaveTextContent("Select an agent")

    // No agent yet: nothing to save.
    await user.click(saveButton())
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select an agent to see its options."
    )

    await pick(user, "Agent", "OpenCode")
    await waitFor(() => expect(trigger("Model")).toHaveTextContent("Select"))
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull()
    await user.click(saveButton())
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 option still to pick"
    )

    await pick(user, "Model", "Model B")
    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("Select"))
    await user.click(saveButton())
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 option still to pick"
    )
    expect(api.setCommitMessageSettings).not.toHaveBeenCalled()

    await pick(user, "Effort", "Max")
    await user.click(saveButton())
    expect(api.setCommitMessageSettings).toHaveBeenCalledWith(null, {
      ...ON_MODEL_B,
      instructions: "",
      auto_commit: false,
    })
  })

  it("lets a folder follow the global settings or keep its own", async () => {
    saved(new Map([[null, ON_MODEL_B]]))
    const user = userEvent.setup()
    renderDialog(FOLDER.id)
    const follow = await screen.findByRole("tab", { name: "Global defaults" })
    await waitFor(() => expect(follow).toHaveAttribute("data-state", "active"))
    expect(screen.queryByRole("switch", { name: "Use a specific agent" })).toBe(
      null
    )
    await user.click(saveButton())
    expect(api.deleteCommitMessageSettings).toHaveBeenCalledWith(FOLDER.id)
    expect(api.setCommitMessageSettings).not.toHaveBeenCalled()

    // Its own settings start from the global ones. The save above locks the
    // tabs until it lands, and a click on a locked tab is dropped.
    const own = screen.getByRole("tab", { name: "Custom" })
    await waitFor(() => expect(own).toBeEnabled())
    await user.click(own)
    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("Max"))
    expect(trigger("Model")).toHaveTextContent("Model B")
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "Write in Chinese."
    )
    await user.click(
      screen.getByRole("switch", { name: "Commit automatically" })
    )
    await user.click(saveButton())
    expect(api.setCommitMessageSettings).toHaveBeenCalledWith(FOLDER.id, {
      ...ON_MODEL_B,
      auto_commit: false,
    })
  })

  it("opens a folder's own settings with its agent and picks", async () => {
    saved(new Map([[FOLDER.id, ON_MODEL_B]]))
    const user = userEvent.setup()
    renderDialog(FOLDER.id)
    const own = await screen.findByRole("tab", { name: "Custom" })
    await waitFor(() => expect(own).toHaveAttribute("data-state", "active"))
    await waitFor(() => expect(trigger("Effort")).toHaveTextContent("Max"))
    expect(
      screen.getByRole("switch", { name: "Use a specific agent" })
    ).toBeChecked()
    expect(api.describeAgentOptions).toHaveBeenCalledWith("open_code", null, {
      model: "model-b",
    })

    await user.click(saveButton())
    expect(api.setCommitMessageSettings).toHaveBeenCalledWith(
      FOLDER.id,
      ON_MODEL_B
    )
  })
})

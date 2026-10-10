import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { workTaskTemplateSave } from "@/lib/api"
import type {
  AcpAgentInfo,
  AgentType,
  WorkTask,
  WorkTaskDraft,
} from "@/lib/types"

// What the launch would resolve for an agent-less task, layer by layer: the
// effective task settings' agent (with their mode and options), then the
// folder's own default agent.
const inheritance = vi.hoisted(() => ({
  settingsAgent: null as string | null,
  settingsModeId: null as string | null,
  settingsConfig: {} as Record<string, string>,
  folderDefault: null as string | null,
}))
const templateSave = vi.hoisted(() => vi.fn())
// The config selections each probe host passed on its latest render: the
// editor's own options hook, and the brief's composer.
const probeSelections = vi.hoisted(() => ({
  bar: [] as unknown[],
  composer: [] as unknown[],
}))

vi.mock("@/lib/api", () => ({
  gitListAllBranches: () =>
    Promise.resolve({
      local: ["main"],
      remote: [],
      worktree_branches: [],
      main_worktree_branch: null,
    }),
  getGitBranch: () => Promise.resolve("main"),
  workTaskSettingsEffective: () =>
    Promise.resolve({
      default_agent_type: inheritance.settingsAgent,
      mode_id: inheritance.settingsModeId,
      config_values: inheritance.settingsConfig,
      auto_process: false,
      max_concurrent: 2,
      merge_strategy: "squash",
      auto_merge: false,
      delete_worktree_default: true,
      auto_compact_percent: 0,
    }),
  workTaskTemplateList: () => Promise.resolve([]),
  workTaskTemplateSave: (...args: unknown[]) => templateSave(...args),
  workTaskTemplateDelete: () => Promise.resolve(undefined),
}))

// The REAL agent selector, fed a registry: what it highlights on its own is
// the thing under test.
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: vi.fn(),
}))

vi.mock("@/components/automations/agent-config-section", () => ({
  AgentConfigSection: () => <div data-testid="agent-config" />,
  effectiveSelections: (
    _snapshot: unknown,
    modeId: string | null,
    configValues: Record<string, string>
  ) => ({ mode_id: modeId, config_values: configValues }),
  snapshotLabels: () => ({}),
}))
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: (
    agentType: string,
    _folderPath: string | null,
    _enabled: boolean,
    configValues: unknown
  ) => {
    probeSelections.bar.push(configValues)
    return {
      snapshot: null,
      snapshotAgentType: agentType,
      loading: false,
      error: null,
      reload: vi.fn(),
      ensure: () => Promise.resolve(null),
    }
  },
}))

// The real composer is a Tiptap editor; the editor dialog only reads text and
// prompt blocks back off its handle.
vi.mock("./task-message-composer", async () => {
  const { forwardRef, useImperativeHandle, useState } = await import("react")
  type StubProps = {
    defaultText?: string
    ariaLabel?: string
    onChange?: (text: string) => void
    probeConfigValues?: Record<string, string> | null
  }
  return {
    TaskMessageComposer: forwardRef(function Stub(
      props: StubProps,
      ref: React.Ref<unknown>
    ) {
      probeSelections.composer.push(props.probeConfigValues)
      const [text, setText] = useState(props.defaultText ?? "")
      useImperativeHandle(
        ref,
        () => ({
          getText: () => text,
          getPromptBlocks: () => [{ type: "text", text }],
          hasAttachments: () => false,
          hasUploadingImage: () => false,
          focus: () => {},
        }),
        [text]
      )
      return (
        <textarea
          aria-label={props.ariaLabel}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            props.onChange?.(e.target.value)
          }}
        />
      )
    }),
  }
})

vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    get folders() {
      return [
        {
          id: 1,
          name: "proj",
          alias: null,
          parent_id: null,
          kind: "regular",
          path: "/tmp/proj",
          default_agent_type: inheritance.folderDefault,
        },
      ]
    },
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})

import { useAcpAgents } from "@/hooks/use-acp-agents"
import { TaskEditorDialog } from "./task-editor-dialog"

const INHERITED_HINT = enMessages.Tasks.agentInheritedHint
const NO_DEFAULT_HINT = enMessages.Tasks.agentNoDefaultHint

function agent(
  agentType: AgentType,
  overrides: Partial<AcpAgentInfo> = {}
): AcpAgentInfo {
  return {
    agent_type: agentType,
    skills_capable: true,
    registry_id: `${agentType}-registry`,
    registry_version: null,
    supports_custom_version: false,
    name: agentType,
    description: "",
    available: true,
    distribution_type: "system",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "1.0.0",
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
    opencode_auth_json: null,
    codex_auth_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    cline_secrets_json: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
    ...overrides,
  }
}

function registry(...agents: AcpAgentInfo[]) {
  vi.mocked(useAcpAgents).mockReturnValue({
    agents,
    fresh: true,
    refresh: async () => {},
  })
}

/** A task saved without an agent whose launch then failed on it (#864). */
function agentlessFailedTask(): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Polish the feature",
    config: {
      prompt_blocks: [{ type: "text", text: "do it" }],
      display_text: "do it",
      agent_type: null,
      config_values: {},
    },
    status: "failed",
    failure_reason: "setup_error",
    last_error: "no agent configured: set a task agent or a folder default",
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: null,
    conversation_id: null,
    connection_id: null,
    base_branch: null,
    base_sha: null,
    work_branch: null,
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 0,
    additions: 0,
    deletions: 0,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-09-29T00:00:00Z",
    updated_at: "2026-09-29T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
  }
}

function renderEditor(task: WorkTask | null = null) {
  const onSubmit = vi.fn<(draft: WorkTaskDraft) => Promise<void>>(() =>
    Promise.resolve()
  )
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskEditorDialog
        open
        onOpenChange={() => {}}
        task={task}
        defaultFolderId={1}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>
  )
  return onSubmit
}

/** The agent the pill row presents as this task's pick. */
async function shownAgent(label: string) {
  // The pill's name also carries its icon's <title>, so match on the label.
  await waitFor(() =>
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      label
    )
  )
}

async function fillBrief(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Polish the feature")
  await user.type(screen.getByLabelText("Task description"), "do it")
}

async function saveBrief(
  user: ReturnType<typeof userEvent.setup>,
  onSubmit: ReturnType<typeof renderEditor>
) {
  await fillBrief(user)
  await user.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  return onSubmit.mock.calls[0][0].config
}

beforeEach(() => {
  inheritance.settingsAgent = null
  inheritance.settingsModeId = null
  inheritance.settingsConfig = {}
  inheritance.folderDefault = null
  templateSave.mockReset().mockResolvedValue(undefined)
  probeSelections.bar = []
  probeSelections.composer = []
})

describe("TaskEditorDialog agent", () => {
  it("the brief's composer probes with the bar's selections, so they share one probe", async () => {
    // Probes are keyed by the selected model: the composer has to pass the
    // same selections as the mode/model bar, or opening the editor on a saved
    // model would spawn the agent twice.
    inheritance.settingsAgent = "claude_code"
    inheritance.settingsConfig = { model: "opus", effort: "high" }
    registry(agent("claude_code"))
    renderEditor()
    const latest = (renders: unknown[]) => renders[renders.length - 1]
    await waitFor(() =>
      expect(latest(probeSelections.bar)).toEqual({
        model: "opus",
        effort: "high",
      })
    )
    expect(latest(probeSelections.composer)).toBe(latest(probeSelections.bar))
  })

  it("nothing to inherit: saves the agent the selector substituted and shows", async () => {
    // #864: no task settings, no folder default, and the placeholder agent is
    // disabled — so the selector highlights the first usable one on its own.
    registry(agent("claude_code", { enabled: false }), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Codex")
    // Not "inherited": there is nothing to inherit, and the hint says so.
    expect(await screen.findByText(NO_DEFAULT_HINT)).toBeInTheDocument()
    expect(screen.queryByText(INHERITED_HINT)).not.toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    // An agent-less task here has nothing to inherit, so the launch would
    // fail with "no agent configured": what the row shows must be saved.
    expect(config.agent_type).toBe("codex")
    expect(config.label_snapshot?.agent_label).toBe("Codex")
  })

  it("nothing to inherit: saves the placeholder agent it shows", async () => {
    // A fresh install: nothing is configured anywhere, yet the pill highlights
    // an agent (the editor's own placeholder) — the same trap without any agent
    // being disabled.
    registry(agent("claude_code"), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Claude Code")
    expect(await screen.findByText(NO_DEFAULT_HINT)).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBe("claude_code")
  })

  it("editing a task that was saved without an agent gives it the one shown", async () => {
    // How a task this bug already broke gets repaired: open it, save it.
    registry(agent("claude_code", { enabled: false }), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor(agentlessFailedTask())
    await shownAgent("Codex")
    expect(await screen.findByText(NO_DEFAULT_HINT)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.agent_type).toBe("codex")
  })

  it("an inherited agent that is disabled here: saves the substitute it shows", async () => {
    // Inheriting would launch Claude Code — the agent this device disabled,
    // and not the one the row presents as the pick.
    inheritance.settingsAgent = "claude_code"
    inheritance.settingsModeId = "plan"
    inheritance.settingsConfig = { model: "opus" }
    registry(agent("claude_code", { enabled: false }), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Codex")
    expect(
      await screen.findByText(
        "Claude Code from task settings isn't available — the selected agent will be saved with the task"
      )
    ).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBe("codex")
    // Claude Code's mode and model are no choice of Codex's.
    expect(config.mode_id).toBeNull()
    expect(config.config_values).toEqual({})
  })

  it("keeps inheriting the task settings' agent while the pill shows it", async () => {
    inheritance.settingsAgent = "codex"
    inheritance.settingsModeId = "auto"
    registry(agent("claude_code"), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Codex")
    expect(await screen.findByText(INHERITED_HINT)).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    // Nothing frozen: the task follows the settings live.
    expect(config.agent_type).toBeNull()
    expect(config.mode_id).toBeNull()
    expect(config.config_values).toEqual({})
  })

  it("keeps inheriting the task settings' agent even when the placeholder is disabled", async () => {
    // The placeholder is substituted before the settings answer; the settings'
    // own agent then takes over and is inherited as usual.
    inheritance.settingsAgent = "open_code"
    registry(
      agent("claude_code", { enabled: false }),
      agent("codex"),
      agent("open_code")
    )
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("OpenCode")
    expect(await screen.findByText(INHERITED_HINT)).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBeNull()
  })

  it("keeps inheriting the folder's default agent while the pill shows it", async () => {
    inheritance.folderDefault = "codex"
    registry(agent("claude_code"), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Codex")
    expect(await screen.findByText(INHERITED_HINT)).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBeNull()
  })

  it("an explicit pick is saved as the task's own agent", async () => {
    inheritance.settingsAgent = "codex"
    registry(agent("claude_code"), agent("codex"))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await shownAgent("Codex")

    await user.click(screen.getByRole("button", { pressed: false }))
    await shownAgent("Claude Code")
    expect(
      screen.getByRole("button", { name: "Reset to inherited" })
    ).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBe("claude_code")
  })

  it("with no agent on show, nothing is saved in its name", async () => {
    // Every agent disabled: the row shows none, so the placeholder behind it
    // must not be written into the task either.
    registry(agent("claude_code", { enabled: false }))
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    expect(
      await screen.findByText(
        enMessages.Folder.chat.agentSelector.noEnabledAgents
      )
    ).toBeInTheDocument()

    const config = await saveBrief(user, onSubmit)
    expect(config.agent_type).toBeNull()
  })

  it("a template keeps inheriting the untouched agent even with nothing to inherit here", async () => {
    // A blueprint is global: whether there is anything to inherit is for the
    // folder the task is later created in to settle, not this one.
    registry(agent("claude_code"), agent("codex"))
    const user = userEvent.setup()
    renderEditor()
    await shownAgent("Claude Code")
    expect(await screen.findByText(NO_DEFAULT_HINT)).toBeInTheDocument()
    await fillBrief(user)

    await user.click(screen.getByRole("button", { name: "Templates" }))
    await user.click(
      await screen.findByRole("button", { name: "Save current as template" })
    )

    await waitFor(() => expect(templateSave).toHaveBeenCalled())
    const draft = templateSave.mock.calls[0][0] as Parameters<
      typeof workTaskTemplateSave
    >[0]
    expect(draft.config.agent_type).toBeNull()
  })
})

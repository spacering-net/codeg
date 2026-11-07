import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { AgentType, Automation, AutomationDraft } from "@/lib/types"

// The selections each render handed to the config bar: what the editor opens
// its permission / model pickers on.
const barSelections = vi.hoisted(() => ({ values: [] as unknown[] }))
// The mode the bar holds, so a pick made here can be asserted to travel to the
// saved draft (and to the shared memory the chat composer reads).
const barMode = vi.hoisted(() => ({ value: null as string | null }))

vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    folders: [
      {
        id: 1,
        name: "proj",
        alias: null,
        parent_id: null,
        kind: "regular",
        path: "/tmp/proj",
        default_agent_type: null,
      },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})

// The agent pill only has to report a pick; the registry itself is the task
// editor's subject, not this one's.
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: ({ onSelect }: { onSelect: (agent: AgentType) => void }) => (
    <button type="button" onClick={() => onSelect("codex")}>
      pick codex
    </button>
  ),
}))

// Stands in for the probe-backed bar: it renders what the editor holds and
// offers one concrete pick, exactly like the inline (`allowInherit: false`)
// surface does.
vi.mock("./agent-config-section", () => ({
  AgentConfigSection: (props: {
    modeId: string | null
    configValues: Record<string, string>
    onModeChange: (modeId: string | null) => void
    onConfigChange: (optionId: string, valueId: string | null) => void
  }) => {
    barSelections.values.push(props.configValues)
    barMode.value = props.modeId
    return (
      <div>
        <span data-testid="config">{JSON.stringify(props.configValues)}</span>
        <span data-testid="mode">{props.modeId ?? ""}</span>
        <button type="button" onClick={() => props.onModeChange("yolo")}>
          pick yolo
        </button>
        <button
          type="button"
          onClick={() => props.onConfigChange("sandbox", "read-only")}
        >
          pick read-only
        </button>
      </div>
    )
  },
  effectiveSelections: (
    _snapshot: unknown,
    modeId: string | null,
    configValues: Record<string, string>
  ) => ({ mode_id: modeId, config_values: configValues }),
  snapshotLabels: () => ({}),
}))

vi.mock("./use-agent-options", () => ({
  useAgentOptions: (agentType: AgentType) => ({
    snapshot: {
      agent_type: agentType,
      modes: {
        current_mode_id: "default",
        available_modes: [
          { id: "default", name: "Default", description: null },
          { id: "yolo", name: "YOLO", description: null },
        ],
      },
      config_options: [],
      available_commands: [],
    },
    snapshotAgentType: agentType,
    loading: false,
    error: null,
    reload: vi.fn(),
    ensure: () =>
      Promise.resolve({
        agent_type: agentType,
        modes: {
          current_mode_id: "default",
          available_modes: [
            { id: "default", name: "Default", description: null },
            { id: "yolo", name: "YOLO", description: null },
          ],
        },
        config_options: [],
        available_commands: [],
      }),
  }),
}))

vi.mock("@/components/chat/composer/rich-composer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react")
  return {
    RichComposer: forwardRef(function Stub(
      props: { ariaLabel?: string },
      ref: React.Ref<unknown>
    ) {
      useImperativeHandle(ref, () => ({
        getText: () => "deploy it",
        getEditor: () => null,
        focus: () => {},
      }))
      return <textarea aria-label={props.ariaLabel} defaultValue="deploy it" />
    }),
  }
})

vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => ({ results: [], loading: false }),
}))
vi.mock("@/components/chat/composer/use-composer-mention-labels", () => ({
  useComposerMentionLabels: () => ({
    groupLabels: {},
    uiLabels: {},
  }),
}))
vi.mock("@/components/chat/composer/use-composer-chrome-focus", () => ({
  useComposerChromeFocus: () => ({}),
}))
vi.mock("./composer-invocations", () => ({
  ComposerInvocationsPopup: () => null,
  useComposerInvocations: () => ({
    knownInvocations: [],
    detect: () => {},
    isOpen: false,
    onKeyDown: () => {},
  }),
}))
vi.mock("./cron-builder-dialog", () => ({ CronBuilderDialog: () => null }))
vi.mock("@/components/shared/branch-picker", () => ({
  BranchPicker: () => null,
}))
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: () => null,
}))
vi.mock("@/lib/api", () => ({
  automationComputeNextRun: () => Promise.resolve(null),
}))

import { AutomationEditor } from "./automation-editor"

function seedSelections(
  agentType: string,
  prefs: { modeId?: string; configValues?: Record<string, string> }
) {
  localStorage.setItem(
    "codeg:selector-prefs",
    JSON.stringify({ [agentType]: prefs })
  )
}

function renderEditor(automation: Automation | null = null) {
  const onSubmit = vi.fn<(draft: AutomationDraft) => Promise<void>>(() =>
    Promise.resolve()
  )
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AutomationEditor
        automation={automation}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />
    </NextIntlClientProvider>
  )
  return onSubmit
}

beforeEach(() => {
  // The editor reads the user's last selector picks out of localStorage; one
  // test's picks must not leak into the next.
  localStorage.clear()
  barSelections.values = []
  barMode.value = null
})

describe("AutomationEditor config defaults", () => {
  it("a new automation opens on the agent's last chosen mode and permissions", async () => {
    // What the chat composer (and the task editor) last saved for this agent:
    // the permission chosen once must not have to be chosen again on every
    // new automation.
    seedSelections("claude_code", {
      modeId: "yolo",
      configValues: { sandbox: "read-only" },
    })
    renderEditor()
    await waitFor(() =>
      expect(screen.getByTestId("config")).toHaveTextContent(
        JSON.stringify({ sandbox: "read-only" })
      )
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("yolo")
  })

  it("an existing automation keeps the config it was saved with", async () => {
    seedSelections("claude_code", {
      modeId: "yolo",
      configValues: { sandbox: "read-only" },
    })
    renderEditor({
      id: 1,
      name: "Deploy",
      enabled: true,
      trigger_kind: "schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
      next_run_at: null,
      agent_type: "claude_code",
      root_folder_id: 1,
      isolation: "worktree_per_run",
      branch: null,
      is_remote_branch: false,
      config: {
        prompt_blocks: [{ type: "text", text: "deploy it" }],
        display_text: "deploy it",
        mode_id: "default",
        config_values: { sandbox: "danger-full-access" },
      },
      last_run_at: null,
      last_run_status: null,
      last_run_conversation_id: null,
      unseen_failures: 0,
      created_at: "2026-09-29T00:00:00Z",
      updated_at: "2026-09-29T00:00:00Z",
    })
    await waitFor(() =>
      expect(screen.getByTestId("config")).toHaveTextContent(
        JSON.stringify({ sandbox: "danger-full-access" })
      )
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("default")
  })

  it("a pick here is remembered for the next conversation, and saved", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await user.click(screen.getByRole("button", { name: "pick read-only" }))
    await user.click(screen.getByRole("button", { name: "pick yolo" }))

    // Same memory the chat composer reads: the last choice, per agent.
    expect(
      JSON.parse(localStorage.getItem("codeg:selector-prefs") ?? "{}")
    ).toEqual({
      claude_code: { modeId: "yolo", configValues: { sandbox: "read-only" } },
    })

    await user.type(screen.getByLabelText("Name"), "Deploy")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted.config?.mode_id).toBe("yolo")
    expect(submitted.config?.config_values).toEqual({ sandbox: "read-only" })
  })
})

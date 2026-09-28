import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskDraft } from "@/lib/types"

const branchesMock = vi.fn()

vi.mock("@/lib/api", () => ({
  gitListAllBranches: (...args: unknown[]) => branchesMock(...args),
  workTaskSettingsEffective: () =>
    Promise.resolve({
      default_agent_type: null,
      mode_id: null,
      config_values: {},
      auto_process: false,
      max_concurrent: 2,
      merge_strategy: "squash",
      auto_merge: false,
      delete_worktree_default: true,
      auto_compact_percent: 0,
    }),
  workTaskTemplateList: () => Promise.resolve([]),
  workTaskTemplateSave: () => Promise.resolve(undefined),
  workTaskTemplateDelete: () => Promise.resolve(undefined),
}))

// The agent surface probes a live CLI; none of it is under test here.
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: () => <div data-testid="agent-selector" />,
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
  useAgentOptions: () => ({
    snapshot: null,
    snapshotAgentType: "claude_code",
    loading: false,
    error: null,
    reload: vi.fn(),
    ensure: () => Promise.resolve(null),
  }),
}))

// The real composer is a Tiptap editor; the editor dialog only reads text and
// prompt blocks back off its handle.
vi.mock("./task-message-composer", async () => {
  const { forwardRef, useImperativeHandle, useState } = await import("react")
  type StubProps = {
    defaultText?: string
    ariaLabel?: string
    onChange?: (text: string) => void
  }
  return {
    TaskMessageComposer: forwardRef(function Stub(
      props: StubProps,
      ref: React.Ref<unknown>
    ) {
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
    folders: [
      {
        id: 1,
        name: "proj",
        alias: null,
        parent_id: null,
        kind: "regular",
        path: "/tmp/proj",
        default_agent_type: "claude_code",
      },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})

import { TaskEditorDialog } from "./task-editor-dialog"

function ranTask(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Polish the feature",
    config: {
      prompt_blocks: [{ type: "text", text: "do it" }],
      display_text: "do it",
      config_values: {},
    },
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: 3,
    connection_id: null,
    base_branch: "feature",
    base_sha: "abc",
    work_branch: "task/7",
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
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
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

async function fillBrief(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Polish the feature")
  await user.type(screen.getByLabelText("Task description"), "do it")
}

beforeEach(() => {
  branchesMock.mockReset().mockResolvedValue({
    local: ["main", "feature"],
    remote: ["origin/release"],
    worktree_branches: [],
    main_worktree_branch: null,
  })
})

describe("TaskEditorDialog base branch", () => {
  it("saves the branch the task was created for", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await fillBrief(user)

    await user.click(screen.getByRole("button", { name: "Base branch" }))
    await user.click(await screen.findByText("feature"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBe("feature")
  })

  it("leaves the base unset when nothing is picked", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await fillBrief(user)

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // Null, not "": the engine reads that as "the project folder's current
    // branch when the task starts" — what a task did before the choice existed.
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBeNull()
  })

  it("switching project drops a branch picked for the previous one", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    await fillBrief(user)

    await user.click(screen.getByRole("button", { name: "Base branch" }))
    await user.click(await screen.findByText("feature"))
    // Re-picking the same folder is still a folder choice — the handler that
    // clears the branch is the one under test.
    await user.click(screen.getByRole("button", { name: "proj" }))
    await user.click(await screen.findByRole("option", { name: /proj/ }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBeNull()
  })

  it("shows the recorded base of a task that already ran, read-only", async () => {
    renderEditor(ranTask())

    const trigger = await screen.findByRole("button", { name: "Base branch" })
    expect(trigger).toHaveTextContent("feature")
    // The base is recorded when the worktree is minted and every later
    // decision reads it from there, so it is history, not a setting.
    expect(trigger).toBeDisabled()
  })

  it("saving a task that already ran keeps the request it was created with", async () => {
    const user = userEvent.setup()
    // Created without a choice — it branched from the checkout, which happened
    // to be `feature`. Editing the title must not turn that accident into a
    // standing request for `feature`.
    const onSubmit = renderEditor(ranTask({ status: "failed" }))

    await user.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBeNull()
  })

  it("keeps an explicit choice across an edit", async () => {
    const user = userEvent.setup()
    // The other half of the rule: dropping the record as a state source must
    // not drop a branch the user actually asked for.
    const onSubmit = renderEditor(
      ranTask({
        status: "failed",
        config: {
          prompt_blocks: [{ type: "text", text: "do it" }],
          display_text: "do it",
          config_values: {},
          base_branch: "feature",
        },
      })
    )

    await user.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBe("feature")
  })

  it("a task whose worktree was cleaned up does not inherit its old base", async () => {
    const user = userEvent.setup()
    // The accept-and-remove path detaches the worktree (and deletes the work
    // branch) while leaving `base_branch` on the row, so the picker is live
    // again — showing the request (none), not the branch it happened to run on.
    const onSubmit = renderEditor(
      ranTask({ status: "failed", worktree_folder_id: null })
    )

    const trigger = await screen.findByRole("button", { name: "Base branch" })
    expect(trigger).toBeEnabled()
    expect(trigger).toHaveTextContent("Current branch")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].config.base_branch).toBeNull()
  })

  it("offers no branch on a pull-request task, whose base is the review's", async () => {
    renderEditor(ranTask({ source_kind: "forge_pr" }))

    await screen.findByRole("button", { name: "proj" })
    expect(
      screen.queryByRole("button", { name: "Base branch" })
    ).not.toBeInTheDocument()
  })
})

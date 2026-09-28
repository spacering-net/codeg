import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { PromptInputBlock, WorkTask, WorkTaskDraft } from "@/lib/types"

const branchesMock = vi.fn()
const templatesMock = vi.fn()

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
  workTaskTemplateList: () => templatesMock(),
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
    defaultBlocks?: PromptInputBlock[] | null
    ariaLabel?: string
    onChange?: (text: string) => void
    onAttachmentsChange?: (count: number) => void
  }
  return {
    TaskMessageComposer: forwardRef(function Stub(
      props: StubProps,
      ref: React.Ref<unknown>
    ) {
      const [text, setText] = useState(
        props.defaultBlocks?.find((block) => block.type === "text")?.text ??
          props.defaultText ??
          ""
      )
      const [attachmentBlocks, setAttachmentBlocks] = useState<
        PromptInputBlock[]
      >(props.defaultBlocks?.filter((block) => block.type !== "text") ?? [])
      useImperativeHandle(
        ref,
        () => ({
          getText: () => text,
          getPromptBlocks: () => [
            ...(text ? [{ type: "text", text }] : []),
            ...attachmentBlocks,
          ],
          hasAttachments: () => attachmentBlocks.length > 0,
          hasUploadingImage: () => false,
          focus: () => {},
        }),
        [text, attachmentBlocks]
      )
      return (
        <>
          <textarea
            aria-label={props.ariaLabel}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              props.onChange?.(e.target.value)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setAttachmentBlocks((blocks) => [
                ...blocks,
                {
                  type: "image",
                  data: "aGk=",
                  mime_type: "image/png",
                  uri: null,
                },
              ])
              props.onAttachmentsChange?.(attachmentBlocks.length + 1)
            }}
          >
            Attach image
          </button>
          <button
            type="button"
            onClick={() => {
              setAttachmentBlocks([])
              props.onAttachmentsChange?.(0)
            }}
          >
            Remove attachments
          </button>
        </>
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
  templatesMock.mockReset().mockResolvedValue([])
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

describe("TaskEditorDialog one-field briefs", () => {
  it("uses a title-only brief as the actual agent prompt", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.type(screen.getByLabelText("Title"), "  Fix the login flow  ")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Fix the login flow",
      config: {
        display_text: "Fix the login flow",
        prompt_blocks: [{ type: "text", text: "Fix the login flow" }],
      },
    })
  })

  it("derives a short title from the first nonempty body line and keeps the full brief", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()
    const body = "\n  Improve onboarding  \nKeep screenshots and references."

    await user.type(screen.getByLabelText("Task description"), body)
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Improve onboarding",
      config: {
        display_text: body.trim(),
        prompt_blocks: [
          { type: "text", text: body },
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("limits a body-derived title to 80 characters", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.type(screen.getByLabelText("Task description"), "A".repeat(90))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].title).toBe("A".repeat(80))
  })

  it("adds the title as the prompt while keeping a title-only brief's attachment", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.type(screen.getByLabelText("Title"), "Inspect this screenshot")
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Inspect this screenshot",
      config: {
        display_text: "Inspect this screenshot",
        prompt_blocks: [
          { type: "text", text: "Inspect this screenshot" },
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("gives an attachment-only brief a localized title without adding text", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Task with attachment",
      config: {
        display_text: "",
        prompt_blocks: [
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("keeps separately entered title and body without replacing either", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.type(screen.getByLabelText("Title"), "Short board label")
    await user.type(
      screen.getByLabelText("Task description"),
      "Detailed instructions for the agent"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Short board label",
      config: {
        display_text: "Detailed instructions for the agent",
        prompt_blocks: [
          { type: "text", text: "Detailed instructions for the agent" },
        ],
      },
    })
  })

  it("rejects a brief with no title, body, or attachment", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor()

    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a title or task description"
    )
  })

  it("normalizes a title-only edit after the old body is cleared", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor(ranTask({ status: "failed" }))

    await user.clear(screen.getByLabelText("Task description"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Polish the feature",
      config: {
        display_text: "Polish the feature",
        prompt_blocks: [{ type: "text", text: "Polish the feature" }],
      },
    })
  })

  it("derives a title when an edited task keeps only its new body", async () => {
    const user = userEvent.setup()
    const onSubmit = renderEditor(ranTask({ status: "failed" }))

    await user.clear(screen.getByLabelText("Title"))
    await user.clear(screen.getByLabelText("Task description"))
    await user.type(
      screen.getByLabelText("Task description"),
      "Rewrite the API\nKeep compatibility"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: "Rewrite the API",
      config: {
        display_text: "Rewrite the API\nKeep compatibility",
        prompt_blocks: [
          { type: "text", text: "Rewrite the API\nKeep compatibility" },
        ],
      },
    })
  })
})

describe("TaskEditorDialog saved brief provenance", () => {
  function taskFromDraft(draft: WorkTaskDraft): WorkTask {
    return ranTask({
      title: draft.title,
      config: draft.config,
      status: "todo",
      worktree_folder_id: null,
    })
  }

  it("reopens a title-only task with an empty body and updates the actual prompt when the title changes", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.type(screen.getByLabelText("Title"), "Fix login")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]
    expect(saved.config.brief_origin).toBe("title")

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    expect(screen.getByLabelText("Task description")).toHaveValue("")
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "Fix signup")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Fix signup",
      config: {
        brief_origin: "title",
        display_text: "Fix signup",
        prompt_blocks: [{ type: "text", text: "Fix signup" }],
      },
    })
  })

  it("reopens a title-and-attachment task without losing the attachment or sending the old title", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.type(screen.getByLabelText("Title"), "Inspect old")
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    expect(screen.getByLabelText("Task description")).toHaveValue("")
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "Inspect new")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0].config.prompt_blocks).toEqual([
      { type: "text", text: "Inspect new" },
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ])
  })

  it("removes only the generated first text block while retaining rich references and images", async () => {
    const user = userEvent.setup()
    const resource: PromptInputBlock = {
      type: "resource_link",
      uri: "file:///src/login.ts",
      name: "login.ts",
    }
    const image: PromptInputBlock = {
      type: "image",
      data: "aGk=",
      mime_type: "image/png",
      uri: null,
    }
    const edit = renderEditor(
      ranTask({
        title: "Inspect login",
        config: {
          prompt_blocks: [
            { type: "text", text: "Inspect login" },
            resource,
            image,
          ],
          display_text: "Inspect login",
          brief_origin: "title",
          config_values: {},
        },
      })
    )
    expect(screen.getByLabelText("Task description")).toHaveValue("")
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "Inspect signup")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0].config.prompt_blocks).toEqual([
      { type: "text", text: "Inspect signup" },
      resource,
      image,
    ])
  })

  it("treats an inconsistent title marker as explicit stored text", async () => {
    const user = userEvent.setup()
    const edit = renderEditor(
      ranTask({
        title: "Current title",
        config: {
          prompt_blocks: [{ type: "text", text: "Actual description" }],
          display_text: "Actual description",
          brief_origin: "title",
          config_values: {},
        },
      })
    )
    expect(screen.getByLabelText("Task description")).toHaveValue(
      "Actual description"
    )
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "New title")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0].config).toMatchObject({
      display_text: "Actual description",
      prompt_blocks: [{ type: "text", text: "Actual description" }],
    })
    expect(edit.mock.calls[0][0].config.brief_origin).toBeUndefined()
  })

  it("keeps an attachment-only task attachment-only when reopened and saved unchanged", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]
    expect(saved.config.brief_origin).toBe("attachment")

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Task with attachment",
      config: {
        brief_origin: "attachment",
        display_text: "",
        prompt_blocks: [
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("rejects an untouched attachment-only brief after its only attachment is removed", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.click(screen.getByRole("button", { name: "Remove attachments" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(edit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add an attachment or edit the title to use it as an instruction"
    )
  })

  it("accepts a title deliberately edited after the only attachment is removed", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.click(screen.getByRole("button", { name: "Remove attachments" }))
    await user.clear(screen.getByLabelText("Title"))
    await user.type(
      screen.getByLabelText("Title"),
      "Inspect another screenshot"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Inspect another screenshot",
      config: {
        brief_origin: "title",
        display_text: "Inspect another screenshot",
        prompt_blocks: [{ type: "text", text: "Inspect another screenshot" }],
      },
    })
  })

  it("rejects a description-derived task when both the body and its automatic title are cleared", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.type(screen.getByLabelText("Task description"), "First plan")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.clear(screen.getByLabelText("Task description"))
    expect(screen.getByLabelText("Title")).toHaveValue("")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(edit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a title or task description"
    )
  })

  it("uses an explicitly changed title as the prompt on an attachment-only task", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.click(screen.getByRole("button", { name: "Attach image" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "Compare screenshots")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Compare screenshots",
      config: {
        brief_origin: "title",
        display_text: "Compare screenshots",
        prompt_blocks: [
          { type: "text", text: "Compare screenshots" },
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("refreshes a derived title from the edited body's first line until the title is changed", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.type(
      screen.getByLabelText("Task description"),
      "First plan\nDetails"
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]
    expect(saved.config.brief_origin).toBe("description")

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.clear(screen.getByLabelText("Task description"))
    await user.type(
      screen.getByLabelText("Task description"),
      "Revised plan\nMore details"
    )
    expect(screen.getByLabelText("Title")).toHaveValue("Revised plan")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Revised plan",
      config: {
        brief_origin: "description",
        display_text: "Revised plan\nMore details",
      },
    })
  })

  it("keeps an explicitly edited title while the derived task body changes", async () => {
    const user = userEvent.setup()
    const create = renderEditor()
    await user.type(screen.getByLabelText("Task description"), "First plan")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const saved = create.mock.calls[0][0]

    cleanup()
    const edit = renderEditor(taskFromDraft(saved))
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "My title")
    await user.clear(screen.getByLabelText("Task description"))
    await user.type(screen.getByLabelText("Task description"), "Revised plan")
    expect(screen.getByLabelText("Title")).toHaveValue("My title")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "My title",
      config: { display_text: "Revised plan" },
    })
    expect(edit.mock.calls[0][0].config.brief_origin).toBeUndefined()
  })

  it("does not guess provenance for a legacy task whose explicit title equals its body", async () => {
    const user = userEvent.setup()
    const edit = renderEditor(
      ranTask({
        title: "Same words",
        config: {
          prompt_blocks: [{ type: "text", text: "Same words" }],
          display_text: "Same words",
          config_values: {},
        },
      })
    )
    expect(screen.getByLabelText("Task description")).toHaveValue("Same words")
    await user.clear(screen.getByLabelText("Title"))
    await user.type(screen.getByLabelText("Title"), "Different title")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0].config.prompt_blocks).toEqual([
      { type: "text", text: "Same words" },
    ])
    expect(edit.mock.calls[0][0].config.brief_origin).toBeUndefined()
  })

  it("does not replace an externally edited title under a stale description marker", async () => {
    const user = userEvent.setup()
    const edit = renderEditor(
      ranTask({
        title: "My custom label",
        config: {
          prompt_blocks: [{ type: "text", text: "Fix login" }],
          display_text: "Fix login",
          brief_origin: "description",
          config_values: {},
        },
      })
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "My custom label",
      config: {
        display_text: "Fix login",
        prompt_blocks: [{ type: "text", text: "Fix login" }],
      },
    })
    expect(edit.mock.calls[0][0].config.brief_origin).toBeUndefined()
  })

  it("does not replace an explicit title under a stale attachment marker with body text", async () => {
    const user = userEvent.setup()
    const edit = renderEditor(
      ranTask({
        title: "My custom label",
        config: {
          prompt_blocks: [{ type: "text", text: "Fix login" }],
          display_text: "Fix login",
          brief_origin: "attachment",
          config_values: {},
        },
      })
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "My custom label",
      config: {
        display_text: "Fix login",
        prompt_blocks: [{ type: "text", text: "Fix login" }],
      },
    })
    expect(edit.mock.calls[0][0].config.brief_origin).toBeUndefined()
  })

  it("keeps a legacy image-only task image-only when reopened and saved", async () => {
    const user = userEvent.setup()
    const edit = renderEditor(
      ranTask({
        title: "Old screenshot task",
        config: {
          prompt_blocks: [
            { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
          ],
          display_text: "",
          config_values: {},
        },
      })
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
    expect(edit.mock.calls[0][0]).toMatchObject({
      title: "Old screenshot task",
      config: {
        brief_origin: "attachment",
        display_text: "",
        prompt_blocks: [
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })

  it("keeps a legacy image-only template image-only when applied and saved", async () => {
    templatesMock.mockResolvedValue([
      {
        id: 1,
        name: "Screenshot template",
        title: "Screenshot task",
        config: {
          prompt_blocks: [
            { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
          ],
          display_text: "",
          config_values: {},
        },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    ])
    const user = userEvent.setup()
    const create = renderEditor()
    await user.click(screen.getByRole("button", { name: "Templates" }))
    await user.click(
      await screen.findByRole("button", { name: "Screenshot template" })
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0][0]).toMatchObject({
      title: "Screenshot task",
      config: {
        brief_origin: "attachment",
        display_text: "",
        prompt_blocks: [
          { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
        ],
      },
    })
  })
})

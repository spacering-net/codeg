import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { resetAssistantsStore } from "@/stores/assistants-store"

/**
 * The resume row: a `resume_delegation` call drawn as the delegation row of
 * the sub-agent that came back, through the reply renderer the way the thread
 * draws it. Binding resolution lives in `useDelegatedSubSession`; this row's
 * angle on it is that it asks by TASK ID (its own tool_call_id is never a
 * binding key), so the hook is stubbed and its `fallbackTaskId` asserted.
 */

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => ({
      subscribeKey: () => () => {},
      getConnection: () => undefined,
      getConnectPending: () => undefined,
      getConnectError: () => undefined,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
    }),
  }
})

vi.mock("@/components/message/sub-agent-session-dialog", () => ({
  SubAgentSessionDialog: ({
    open,
    childConversationId,
  }: {
    open: boolean
    childConversationId: number
  }) =>
    open ? (
      <div
        data-testid="sub-agent-session-dialog"
        data-conversation-id={childConversationId}
      />
    ) : null,
}))

const { useDelegatedSubSession } =
  await import("@/hooks/use-delegated-sub-session")
const mockedHook = vi.mocked(useDelegatedSubSession)
const { ContentPartsRenderer } = await import("../../content-parts-renderer")

const TASK_ID = "b0858712-9257-45a1-850e-c80e75291939"

const RESUME_INPUT = JSON.stringify({
  task_id: TASK_ID,
  reason: "the app was killed mid-run",
})

/** What the companion persists for a successful resume: the whole
 *  `DelegationTaskReport`. */
const PERSISTED_ACK = JSON.stringify({
  agent_type: "codex",
  child_conversation_id: 9,
  message: `Delegation resumed. task_id=${TASK_ID} (unchanged). Call get_delegation_status with this id in the task_ids array.`,
  status: "running",
  task_id: TASK_ID,
})

function bindingOf(overrides: Partial<DelegationBinding>): DelegationBinding {
  return {
    parentConnectionId: "p1",
    // The ORIGINAL delegate call's id — deliberately not the resume's.
    parentToolUseId: "tu-original-delegate",
    childConnectionId: "c1",
    childConversationId: 9,
    agentType: "codex",
    status: "running",
    task: null,
    taskId: TASK_ID,
    assistantId: null,
    assistantName: null,
    ...overrides,
  }
}

function bind(binding: DelegationBinding | undefined) {
  mockedHook.mockReturnValue({
    binding,
    detail: null,
    loading: false,
    error: null,
  })
}

function resume(
  props: {
    input?: string | null
    output?: string | null
    meta?: Record<string, unknown> | null
  } = {}
): AdaptedContentPart {
  return {
    type: "tool-call",
    toolCallId: "tu-resume",
    toolName: "mcp__codeg-mcp__resume_delegation",
    input: props.input === undefined ? RESUME_INPUT : props.input,
    state: "output-available",
    output: props.output === undefined ? PERSISTED_ACK : props.output,
    meta: props.meta ?? null,
  }
}

function renderRow(part: AdaptedContentPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

function row(): HTMLElement {
  const li = document.querySelector("li")
  if (!li) throw new Error("no row")
  return li as HTMLElement
}

/** The header button that opens the row's panel, when it has one. */
function toggle(): HTMLElement | null {
  return row().querySelector(":scope > button")
}

const isResumeRow = () =>
  screen.queryByTestId("delegation-resumed-mark") !== null

beforeEach(() => {
  resetAssistantsStore()
  bind(undefined)
})

describe("delegation resume row", () => {
  // Reopening from history: nothing in the reloaded turn but the resume's own
  // persisted report names the sub-agent, and that alone draws the row.
  it("draws the sub-agent from the persisted report, with no live binding", () => {
    renderRow(resume())
    expect(isResumeRow()).toBe(true)
    expect(within(row()).getAllByText("Codex").length).toBeGreaterThan(0)
    expect(within(row()).getByText(`#${TASK_ID.slice(0, 8)}`)).toBeVisible()
    // A running ack is not a result.
    expect(within(row()).getByText("running")).toBeInTheDocument()
    expect(within(row()).queryByText("done")).not.toBeInTheDocument()
    // "Resumed" is the ring's corner mark and what the ring says, not text on
    // the title line.
    expect(screen.getByTitle("Resumed")).toBeInTheDocument()
    expect(
      screen.getByRole("img", { name: "Delegated task, Resumed, running" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Resumed")).not.toBeInTheDocument()
  })

  it("prefers the live binding, looked up by the task id in its arguments", () => {
    bind(bindingOf({ status: "ok", task: "Build the /test4 sandbox page" }))
    renderRow(resume())
    expect(mockedHook).toHaveBeenCalledWith(
      "tu-resume",
      expect.objectContaining({ fallbackTaskId: TASK_ID })
    )
    // The child finished; the row tracks it past the `running` the ack froze.
    expect(within(row()).getByText("done")).toBeInTheDocument()
    expect(
      screen.getByText("Build the /test4 sandbox page")
    ).toBeInTheDocument()
  })

  it("reads the child's task and status from injected historical meta", () => {
    renderRow(
      resume({
        meta: {
          "codeg.delegation": {
            status: "completed",
            child_conversation_id: 9,
            agent_type: "codex",
            task_id: TASK_ID,
            task_preview: "Build the /test4 sandbox page",
          },
        },
      })
    )
    expect(within(row()).getByText("done")).toBeInTheDocument()
    expect(
      screen.getByText("Build the /test4 sandbox page")
    ).toBeInTheDocument()
  })

  it("opens the child conversation", () => {
    renderRow(resume())
    fireEvent.click(screen.getByRole("button", { name: /Open conversation/ }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "9"
    )
  })

  it("opens to the resume reason — never the raw report", () => {
    renderRow(resume())
    expect(
      screen.queryByText("the app was killed mid-run")
    ).not.toBeInTheDocument()
    fireEvent.click(toggle()!)
    expect(screen.getByText("the app was killed mid-run")).toHaveAttribute(
      "dir",
      "auto"
    )
    expect(screen.getByText("Resume reason")).toBeInTheDocument()
    expect(screen.queryByText(/Delegation resumed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/get_delegation_status/)).not.toBeInTheDocument()
    expect(screen.queryByText(/"agent_type"/)).not.toBeInTheDocument()
  })

  it("does not open with no reason and no task cut short", () => {
    renderRow(resume({ input: JSON.stringify({ task_id: TASK_ID }) }))
    expect(isResumeRow()).toBe(true)
    expect(toggle()).toBeNull()
  })

  it("holds the task in full above the reason", () => {
    const task = "Build the /test4 sandbox page\nwith a seeded fixture"
    renderRow(
      resume({
        meta: {
          "codeg.delegation": {
            status: "running",
            child_conversation_id: 9,
            agent_type: "codex",
            task_id: TASK_ID,
            task_preview: task,
          },
        },
      })
    )
    fireEvent.click(toggle()!)
    const reason = screen.getByTestId("delegation-resume-reason")
    expect(reason).toHaveTextContent("Resume reasonthe app was killed mid-run")
    const taskText = reason.previousElementSibling
    expect(taskText?.textContent).toBe(task)
    expect(taskText).toHaveAttribute("dir", "auto")
    fireEvent.click(toggle()!)
    expect(
      screen.queryByTestId("delegation-resume-reason")
    ).not.toBeInTheDocument()
  })

  // `not_resumable` answers with the task's ACTUAL status and its identity, so
  // only `error_code` tells it from a resume that happened. Drawn as the
  // sub-agent, it would report a revival that never was.
  it.each([
    ["already completed", "completed"],
    ["still running", "running"],
  ])("states a refusal instead (%s)", (_label, status) => {
    renderRow(
      resume({
        output: JSON.stringify({
          task_id: TASK_ID,
          status,
          error_code: "not_resumable",
          agent_type: "codex",
          child_conversation_id: 9,
          message:
            "Not resumed: the task already completed — resume only applies to a canceled task.",
        }),
      })
    )
    expect(isResumeRow()).toBe(false)
    expect(
      screen.queryByRole("button", { name: /Open conversation/ })
    ).not.toBeInTheDocument()
  })

  describe("on a host that kept only the message text", () => {
    const ACK_TEXT = `Delegation resumed. task_id=${TASK_ID} (unchanged). Call get_delegation_status with this id.`

    it("states a refusal that arrived as text", () => {
      renderRow(resume({ output: "Not resumed: the task already completed." }))
      expect(isResumeRow()).toBe(false)
    })

    it("still adopts the live binding when the ack affirms the resume", () => {
      bind(bindingOf({ task: "Build the /test4 sandbox page" }))
      renderRow(resume({ output: ACK_TEXT }))
      expect(isResumeRow()).toBe(true)
      expect(
        screen.getByText("Build the /test4 sandbox page")
      ).toBeInTheDocument()
    })

    it("refuses the binding when the result reports an unknown task", () => {
      bind(
        bindingOf({
          parentConnectionId: "other-conversation",
          parentToolUseId: "tu-some-other-delegate",
          childConversationId: 77,
          agentType: "claude_code",
          status: "ok",
          task: "Somebody else's task",
        })
      )
      renderRow(
        resume({
          output:
            "Unknown task id — it never existed, isn't owned by this session.",
        })
      )
      expect(screen.queryByText("Somebody else's task")).not.toBeInTheDocument()
      expect(isResumeRow()).toBe(false)
    })
  })

  // A task id is an argument the model wrote, and the lookup scans every
  // binding in the workspace.
  it("ignores a task-id binding the call's own result does not corroborate", () => {
    bind(
      bindingOf({
        parentConnectionId: "other-conversation",
        parentToolUseId: "tu-some-other-delegate",
        childConversationId: 77,
        agentType: "claude_code",
        status: "ok",
        task: "Somebody else's task",
      })
    )
    renderRow(resume())
    expect(screen.queryByText("Somebody else's task")).not.toBeInTheDocument()
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument()
    expect(within(row()).getAllByText("Codex").length).toBeGreaterThan(0)
  })

  // A refused resume started no run, so the checks after it are still about
  // the delegation before it — which must end with them.
  it.each([
    ["completed", "done"],
    ["failed", "failed"],
  ])(
    "leaves the delegation before a refused resume its checks (%s)",
    (ending, word) => {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ContentPartsRenderer
            role="assistant"
            parts={[
              {
                type: "tool-call",
                toolCallId: "tu-original-delegate",
                toolName: "mcp__codeg-mcp__delegate_to_agent",
                input: JSON.stringify({ agent_type: "codex", task: "Review" }),
                state: "output-available",
                output: JSON.stringify({ task_id: TASK_ID, status: "started" }),
                meta: null,
              },
              resume({
                output: JSON.stringify({
                  task_id: TASK_ID,
                  status: "running",
                  error_code: "not_resumable",
                  agent_type: "codex",
                  child_conversation_id: 9,
                  message: "Not resumed: the task is still running.",
                }),
              }),
              {
                type: "delegation-status-group",
                polls: [
                  {
                    type: "tool-call",
                    toolCallId: "tu-poll",
                    toolName: "mcp__codeg-mcp__get_delegation_status",
                    input: JSON.stringify({ task_ids: [TASK_ID] }),
                    state: "output-available",
                    output: JSON.stringify({
                      task_id: TASK_ID,
                      status: ending,
                      text: "Reviewed.",
                    }),
                    meta: null,
                  },
                ],
              },
            ]}
          />
        </NextIntlClientProvider>
      )
      const delegationRow = document.querySelector<HTMLElement>(
        'li[data-step-key="tool:tu-original-delegate"]'
      )!
      // Still marked running, it would also stay in view once the turn folds.
      expect(within(delegationRow).queryByText("running")).toBeNull()
      expect(within(delegationRow).getByText(word)).toBeInTheDocument()
      expect(isResumeRow()).toBe(false)
    }
  )
})

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ResumedDelegationCard } from "./resumed-delegation-card"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"

// Binding resolution lives in `useDelegatedSubSession`; this card's angle on it
// is that it must ask by TASK ID (its own tool_call_id is never a binding key —
// the broker re-binds the child to the original `delegate_to_agent` call). So
// the hook is stubbed and its `fallbackTaskId` argument asserted; the lookup
// itself is covered in `delegation-context.test.tsx`.
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
const mockedSubSession = vi.mocked(useDelegatedSubSession)

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const TASK_ID = "b0858712-9257-45a1-850e-c80e75291939"

const RESUME_INPUT = JSON.stringify({
  task_id: TASK_ID,
  reason: "the app was killed mid-run",
})

/** What the companion persists for a successful resume: `render_task_report`'s
 *  `structuredContent`, i.e. the whole `DelegationTaskReport`. */
const PERSISTED_ACK = JSON.stringify({
  agent_type: "codex",
  child_conversation_id: 9,
  message: `Delegation resumed. task_id=${TASK_ID} (unchanged). Call get_delegation_status with this id in the task_ids array.`,
  status: "running",
  task_id: TASK_ID,
})

describe("ResumedDelegationCard", () => {
  beforeEach(() => {
    mockedSubSession.mockReset()
    mockedSubSession.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
  })

  // The reported bug: reopening the conversation from history showed only a
  // bare "Resuming task <uuid>" row, because nothing in the reloaded turn ever
  // named the sub-agent — the live card had come from a phantom tool call. The
  // persisted report alone must now draw the whole card.
  it("draws the sub-agent from the persisted report, with no live binding", () => {
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    expect(screen.getByTestId("resumed-delegation-card")).toBeInTheDocument()
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
    expect(screen.getByText(`#${TASK_ID.slice(0, 8)}`)).toBeInTheDocument()
    // A running ack is NOT a result — the badge must not read "done".
    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.queryByText("done")).not.toBeInTheDocument()
    // "Resumed" is carried by the avatar's corner marker only — a text chip on
    // the task line just crowded out the task itself.
    expect(screen.getByTitle("Resumed")).toBeInTheDocument()
    expect(screen.queryByText("Resumed")).not.toBeInTheDocument()
  })

  it("prefers the live binding, looked up by the task id in its arguments", () => {
    const binding: DelegationBinding = {
      parentConnectionId: "p1",
      // The ORIGINAL delegate call's id — deliberately not this card's.
      parentToolUseId: "tu-original-delegate",
      childConnectionId: "c1",
      childConversationId: 9,
      agentType: "codex",
      status: "ok",
      task: "Build the /test4 sandbox page",
      taskId: TASK_ID,
    }
    mockedSubSession.mockReturnValue({
      binding,
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    // The task id — not this card's tool_call_id — is what can find the binding.
    expect(mockedSubSession).toHaveBeenCalledWith(
      "tu-resume",
      expect.objectContaining({ fallbackTaskId: TASK_ID })
    )
    // The child finished; the card tracks it past the `running` its own ack froze.
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(
      screen.getByText("Build the /test4 sandbox page")
    ).toBeInTheDocument()
  })

  it("reads the child's task text and status from injected historical meta", () => {
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
        meta={{
          "codeg.delegation": {
            status: "completed",
            child_conversation_id: 9,
            agent_type: "codex",
            task_id: TASK_ID,
            task_preview: "Build the /test4 sandbox page",
          },
        }}
      />
    )
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(
      screen.getByText("Build the /test4 sandbox page")
    ).toBeInTheDocument()
  })

  it("opens the child conversation from the card", () => {
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "9"
    )
  })

  it("reveals only the resume reason on expand — never the raw report", () => {
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    expect(
      screen.queryByText("the app was killed mid-run")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume details" }))
    expect(screen.getByText("the app was killed mid-run")).toBeInTheDocument()
    // The report text is addressed to the LLM ("Call get_delegation_status with
    // this id …") and the persisted form is the bare report JSON — every fact
    // in it is already on the row, so it must not be dumped under the reason.
    expect(screen.queryByText(/Delegation resumed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/get_delegation_status/)).not.toBeInTheDocument()
    expect(screen.queryByText(/"agent_type"/)).not.toBeInTheDocument()
  })

  it("offers no expander when the resume carried no reason", () => {
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={JSON.stringify({ task_id: TASK_ID })}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    expect(screen.getByTestId("resumed-delegation-card")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Resume details" })
    ).not.toBeInTheDocument()
  })

  // A refused resume revived nothing, so there is no sub-agent card to draw —
  // only a reason to read. The caller's `CodegMcpToolCard` takes over.
  //
  // The realistic refusal is the dangerous one: `not_resumable_report` answers
  // with the task's ACTUAL status and its full identity, so it is
  // indistinguishable from a successful resume by everything except
  // `error_code`. Left unchecked it renders as a done Codex row — a resume
  // that never happened, reported as one that did.
  it.each([
    ["already completed", "completed"],
    ["still running", "running"],
  ])("falls back when the resume was refused (%s)", (_label, status) => {
    const refused = JSON.stringify({
      task_id: TASK_ID,
      status,
      error_code: "not_resumable",
      agent_type: "codex",
      child_conversation_id: 9,
      message:
        "Not resumed: the task already completed — resume only applies to a canceled task.",
    })
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={refused}
        state="output-available"
        fallback={<div data-testid="fallback-card" />}
      />
    )
    expect(screen.getByTestId("fallback-card")).toBeInTheDocument()
    expect(
      screen.queryByTestId("resumed-delegation-card")
    ).not.toBeInTheDocument()
  })

  // Hosts that drop `structuredContent` (OpenCode) leave only the message
  // text, so both verdicts have to survive on words alone.
  describe("on a host that kept only the message text", () => {
    const ACK_TEXT = `Delegation resumed. task_id=${TASK_ID} (unchanged). Call get_delegation_status with this id.`

    it("falls back on a refusal that arrived as text", () => {
      renderWithIntl(
        <ResumedDelegationCard
          toolCallId="tu-resume"
          input={RESUME_INPUT}
          output="Not resumed: the task already completed."
          state="output-available"
          fallback={<div data-testid="fallback-card" />}
        />
      )
      expect(screen.getByTestId("fallback-card")).toBeInTheDocument()
    })

    // The corroboration guard must not strand this case: with no child id in
    // the report there is nothing to match, so the ack's own words are what
    // let the card keep tracking its child.
    it("still adopts the live binding when the ack affirms the resume", () => {
      mockedSubSession.mockReturnValue({
        binding: {
          parentConnectionId: "p1",
          parentToolUseId: "tu-original-delegate",
          childConnectionId: "c1",
          childConversationId: 9,
          agentType: "codex",
          status: "running",
          task: "Build the /test4 sandbox page",
          taskId: TASK_ID,
        },
        detail: null,
        loading: false,
        error: null,
      })
      renderWithIntl(
        <ResumedDelegationCard
          toolCallId="tu-resume"
          input={RESUME_INPUT}
          output={ACK_TEXT}
          state="output-available"
        />
      )
      expect(
        screen.getByText("Build the /test4 sandbox page")
      ).toBeInTheDocument()
      expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
    })

    // …but an unknown task must still be refused the binding: this is the
    // foreign-task-id path with no structure left to check against.
    it("refuses the binding when the result reports an unknown task", () => {
      mockedSubSession.mockReturnValue({
        binding: {
          parentConnectionId: "other-conversation",
          parentToolUseId: "tu-some-other-delegate",
          childConnectionId: "c9",
          childConversationId: 77,
          agentType: "claude",
          status: "ok",
          task: "Somebody else's task",
          taskId: TASK_ID,
        },
        detail: null,
        loading: false,
        error: null,
      })
      renderWithIntl(
        <ResumedDelegationCard
          toolCallId="tu-resume"
          input={RESUME_INPUT}
          output="Unknown task id — it never existed, isn't owned by this session."
          state="output-available"
          fallback={<div data-testid="fallback-card" />}
        />
      )
      expect(screen.queryByText("Somebody else's task")).not.toBeInTheDocument()
      expect(screen.getByTestId("fallback-card")).toBeInTheDocument()
    })
  })

  // `findByTaskId` scans every binding in the workspace, and the task id is an
  // argument the model wrote. A foreign id must not drag another
  // conversation's sub-agent — and a button into its session — onto this card.
  it("ignores a task-id binding the call's own result does not corroborate", () => {
    mockedSubSession.mockReturnValue({
      binding: {
        parentConnectionId: "other-conversation",
        parentToolUseId: "tu-some-other-delegate",
        childConnectionId: "c9",
        childConversationId: 77, // NOT the child this call's report names.
        agentType: "claude",
        status: "ok",
        task: "Somebody else's task",
        taskId: TASK_ID,
      },
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(
      <ResumedDelegationCard
        toolCallId="tu-resume"
        input={RESUME_INPUT}
        output={PERSISTED_ACK}
        state="output-available"
      />
    )
    expect(screen.queryByText("Somebody else's task")).not.toBeInTheDocument()
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument()
    // The report's own identity still stands on its own.
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
  })
})

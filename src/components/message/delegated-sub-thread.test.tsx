import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DelegatedSubThread } from "./delegated-sub-thread"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

// The slim card is a status + navigation affordance: it reads `binding` from
// the delegation hook and the child's live `pendingPermission` from the
// connections store (to badge "awaiting approval"). It renders no body and
// answers no permission inline — so those are the only contexts to stub.
let mockChildConnection: unknown = undefined

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => ({
      subscribeKey: () => () => {},
      getConnection: () => mockChildConnection,
      getConnectPending: () => undefined,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
    }),
  }
})

// SubAgentSessionDialog pulls in MessageListView + useConversationRuntime, which
// would require the full runtime provider tree. Stub it to a sentinel exposing
// the open state + child id so we can assert the "Open conversation" button
// toggles it with the right target. The dialog's own behavior (live bridge,
// permission rendering) is covered by its dedicated test file.
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

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function bindingOf(overrides: Partial<DelegationBinding>): DelegationBinding {
  return {
    parentConnectionId: "p1",
    parentToolUseId: "pt-1",
    childConnectionId: "c1",
    childConversationId: 99,
    agentType: "codex",
    status: "running",
    task: null,
    taskId: null,
    ...overrides,
  }
}

/** A child ConnectionState carrying an optional pending permission. */
function childConnWith(pendingPermission: unknown) {
  return {
    connectionId: "c1",
    contextKey: "c1",
    agentType: "codex",
    workingDir: null,
    status: "connected",
    promptCapabilities: { image: false, audio: false, embedded_context: false },
    supportsFork: false,
    selectorsReady: true,
    sessionId: null,
    modes: null,
    configOptions: null,
    availableCommands: null,
    usage: null,
    liveMessage: null,
    pendingPermission,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    claudeApiRetry: null,
    error: null,
    loadError: null,
    lastAppliedSeq: 0,
    isDelegationChild: true,
    parentToolUseId: "pt-1",
    parentConnectionId: "p1",
  }
}

describe("DelegatedSubThread", () => {
  beforeEach(() => {
    mockChildConnection = undefined
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
  })

  it("renders nothing when there's no binding and no parseable input", () => {
    const { container } = renderWithIntl(
      <DelegatedSubThread parentToolUseId="pt-1" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders agent label + running badge when delegation is in-flight", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
    expect(screen.getByText("running")).toBeInTheDocument()
  })

  it("renders the task line directly from input even without a binding", () => {
    const input = JSON.stringify({
      agent_type: "codex",
      task: "summarize the failing tests",
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)
    expect(screen.getByText("summarize the failing tests")).toBeInTheDocument()
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
  })

  it("labels the card from the live binding when the input is empty (Cursor)", () => {
    // Cursor announces the MCP call with raw_input "{}" and never re-sends
    // the arguments — the binding's task/taskId (from delegation_started) are
    // the live card's only label source.
    mockedHook.mockReturnValue({
      binding: bindingOf({
        agentType: "claude_code",
        task: "执行 pnpm build",
        taskId: "task-uuid-42",
      }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input="{}" />)
    expect(screen.getByText("执行 pnpm build")).toBeInTheDocument()
    expect(screen.getByText("#task-uui")).toBeInTheDocument()
  })

  it("renders from broker meta alone (persisted Cursor shape after refresh)", () => {
    // Persisted transcript: raw_input "{}", live binding gone. The
    // broker-stamped meta must be sufficient to render the delegate card with
    // its label and the open-conversation affordance.
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input="{}"
        meta={{
          "codeg.delegation": {
            status: "completed",
            child_conversation_id: 321,
            task_preview: "执行 pnpm build",
            task_id: "task-uuid-9",
          },
        }}
      />
    )
    expect(screen.getByText("执行 pnpm build")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "321"
    )
  })

  it("shows the 'starting' badge (not 'running') and no button before the child binds", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "set things up" })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)
    expect(screen.getByText("starting")).toBeInTheDocument()
    expect(screen.queryByText("running")).not.toBeInTheDocument()
    // No child conversation yet → no "Open conversation" button (and the card
    // has no expand toggle at all under the slim design).
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("set things up")).toBeInTheDocument()
  })

  it("renders the open-conversation button when the child id is known and toggles the dialog on click", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    expect(
      screen.queryByTestId("sub-agent-session-dialog")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    const dialog = screen.getByTestId("sub-agent-session-dialog")
    expect(dialog).toBeInTheDocument()
    // The dialog receives the binding's childConversationId — not the parent's.
    expect(dialog).toHaveAttribute("data-conversation-id", "99")
  })

  it("hides the open-conversation button when the child id is unknown", () => {
    const input = JSON.stringify({
      agent_type: "codex",
      task: "no child id available",
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)
    expect(
      screen.queryByRole("button", { name: "Open conversation" })
    ).not.toBeInTheDocument()
  })

  it("recovers the open-conversation link from the broker output (synthetic fallback)", () => {
    // Synthetic-fallback case: the broker minted a `delegation-*` tool_use_id,
    // so no binding/meta — but the tool output carries `child_conversation_id`.
    const input = JSON.stringify({ agent_type: "codex", task: "run the audit" })
    const output = JSON.stringify({
      kind: "ok",
      text: "Audit complete.",
      child_conversation_id: 1234,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="delegation-abc"
        input={input}
        output={output}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "1234"
    )
  })

  it("recovers the open-conversation link from a wrapped MCP CallToolResult output", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "ship it" })
    const structured = {
      kind: "ok",
      text: "Shipped.",
      child_conversation_id: 4321,
      turn_count: 1,
    }
    const output = JSON.stringify({
      content: [{ type: "text", text: structured.text }],
      isError: false,
      structuredContent: structured,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="delegation-xyz"
        input={input}
        output={output}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "4321"
    )
  })

  it("shows the error badge with the localized code", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "err", errorCode: "timeout" }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    expect(screen.getByText("timeout")).toBeInTheDocument()
  })

  it("never renders the child's result text inline — only the badge + open-conversation button", () => {
    // The card is navigation-only: even a terminal `ok` binding with result
    // text in the output must NOT surface that text on the card. The user
    // reads it via "Open conversation".
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "ok" }),
      detail: null,
      loading: false,
      error: null,
    })
    const output = JSON.stringify({
      kind: "ok",
      text: "All good, the build passed.",
      child_conversation_id: 99,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        output={output}
        state="output-available"
      />
    )
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open conversation" }))
    expect(
      screen.queryByText(/All good, the build passed\./)
    ).not.toBeInTheDocument()
  })

  it("badges 'awaiting approval' when the child has a pending permission (answered in the dialog, not inline)", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    mockChildConnection = childConnWith({
      request_id: "req-9",
      tool_call: { title: "Run bash", kind: "execute" },
      options: [{ id: "approve", label: "Approve", kind: "allow_once" }],
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    // The waiting cue overrides the running badge.
    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(screen.queryByText("running")).not.toBeInTheDocument()
    // No inline permission UI on the card — it lives in the dialog.
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    // The open-conversation button is still the way in.
    expect(
      screen.getByRole("button", { name: "Open conversation" })
    ).toBeInTheDocument()
  })

  it.each<{ shape: string; input: string; expectedTask: string }>([
    {
      shape: "{name, arguments}",
      input: JSON.stringify({
        name: "delegate_to_agent",
        arguments: { agent_type: "codex", task: "wrapped via arguments" },
      }),
      expectedTask: "wrapped via arguments",
    },
    {
      shape: "{params: {input: {...}}}",
      input: JSON.stringify({
        params: {
          input: { agent_type: "codex", task: "wrapped via params.input" },
        },
      }),
      expectedTask: "wrapped via params.input",
    },
    {
      shape: "{_meta, agent_type, task}",
      input: JSON.stringify({
        _meta: { claudeCode: { toolName: "delegate_to_agent" } },
        agent_type: "codex",
        task: "direct fields next to _meta",
      }),
      expectedTask: "direct fields next to _meta",
    },
    {
      shape: "double-encoded JSON string",
      input: JSON.stringify(
        JSON.stringify({ agent_type: "codex", task: "double-encoded task" })
      ),
      expectedTask: "double-encoded task",
    },
  ])(
    "extracts the task line out of the $shape wrapper",
    ({ input, expectedTask }) => {
      renderWithIntl(
        <DelegatedSubThread parentToolUseId="pt-1" input={input} />
      )
      expect(screen.getByText(expectedTask)).toBeInTheDocument()
    }
  )
})

// Async delegation: the parent `delegate_to_agent` output is a *running ack*
// (the result arrives later). The badge must read "running", never a premature
// "done", and the child id must still drive "Open conversation".
describe("DelegatedSubThread (async ack semantics)", () => {
  beforeEach(() => {
    mockChildConnection = undefined
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
  })

  const ackOutput = JSON.stringify({
    content: [{ type: "text", text: "Delegated; running in background" }],
    isError: false,
    structuredContent: {
      task_id: "t1",
      status: "running",
      child_conversation_id: 99,
    },
  })

  it("a running ack with no binding/meta shows 'running', never a premature 'done'", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={input}
        output={ackOutput}
        state="output-available"
      />
    )
    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.queryByText("done")).not.toBeInTheDocument()
  })

  it("recognizes a running ack inlined in content[0].text with no structuredContent", () => {
    const report = JSON.stringify({
      task_id: "t1",
      status: "running",
      child_conversation_id: 4242,
    })
    const output = JSON.stringify({
      content: [{ type: "text", text: report }],
      isError: false,
    })
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="delegation-inline"
        input={input}
        output={output}
        state="output-available"
      />
    )
    expect(screen.getByText("running")).toBeInTheDocument()
    expect(screen.queryByText("done")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "4242"
    )
  })

  it("surfaces the broker task_id (short form) after the agent name from the structured ack", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={input}
        output={ackOutput}
        state="output-available"
      />
    )
    // structuredContent.task_id = "t1" → "#t1" (slice(0,8) of a short id).
    expect(screen.getByText("#t1")).toBeInTheDocument()
  })

  it("recovers the task_id from the live ack message text (task_id=<id>)", () => {
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    // Live wire: only the CallToolResult content text is forwarded.
    const output =
      "Delegated; the sub-agent is running in the background. " +
      "task_id=abcdef12-3456-7890. Call get_delegation_status with this id in " +
      "the task_ids array."
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={input}
        output={output}
        state="output-available"
      />
    )
    expect(screen.getByText("#abcdef12")).toBeInTheDocument()
  })

  it("recognizes a Codex-wrapped running ack in content[0].text (Wall time prefix, no structuredContent)", () => {
    const report = JSON.stringify({
      status: "running",
      child_conversation_id: 909,
    })
    const wrapped = `Wall time: 1 seconds\nOutput:\n${report}_`
    const output = JSON.stringify({
      content: [{ type: "text", text: wrapped }],
      isError: false,
    })
    const input = JSON.stringify({ agent_type: "codex", task: "do x" })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="delegation-codex"
        input={input}
        output={output}
        state="output-available"
      />
    )
    expect(screen.getByText("running")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }))
    expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
      "data-conversation-id",
      "909"
    )
  })
})

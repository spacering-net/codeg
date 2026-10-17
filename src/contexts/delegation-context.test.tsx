import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import {
  DelegationProvider,
  useDelegation,
} from "@/contexts/delegation-context"
import type { EventEnvelope } from "@/lib/types"

// Capture the envelope handler the provider registers via `useAcpEvent` so
// each test can drive the provider with synthetic acp://event envelopes.
// `useAcpEvent` runs during render, so the handler is captured synchronously
// on mount.
let capturedHandler: ((envelope: EventEnvelope) => void) | null = null

const mockAttach = vi.fn()
const mockDetach = vi.fn()

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: mockAttach,
    detachDelegationChild: mockDetach,
  }),
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

/** Render-side probe that exposes the binding lookup as text so tests can
 *  read the binding state by `data-testid="status"` without depending on
 *  any UI component. */
function BindingProbe({ parentToolUseId }: { parentToolUseId: string }) {
  const { findByParentToolUseId } = useDelegation()
  const binding = findByParentToolUseId(parentToolUseId)
  if (!binding) return <div data-testid="status">none</div>
  return (
    <div>
      <div data-testid="status">{binding.status}</div>
      <div data-testid="error-code">{binding.errorCode ?? "-"}</div>
      <div data-testid="agent">{binding.agentType}</div>
      <div data-testid="assistant">
        {binding.assistantId ?? "-"}:{binding.assistantName ?? "-"}
      </div>
    </div>
  )
}

/** Same idea for the task-id lookup `ResumedDelegationCard` depends on. */
function TaskIdProbe({ taskId }: { taskId: string }) {
  const { findByTaskId } = useDelegation()
  const binding = findByTaskId(taskId)
  return (
    <div>
      <div data-testid="by-task-id">{binding?.parentToolUseId ?? "none"}</div>
      <div data-testid="by-task-id-status">{binding?.status ?? "-"}</div>
    </div>
  )
}

function renderProvider(children: ReactNode = null) {
  return render(
    <DelegationProvider>
      <BindingProbe parentToolUseId="pt-1" />
      {children}
    </DelegationProvider>
  )
}

/** Wait until the provider has registered its `useAcpEvent` handler. The
 *  capture is synchronous on mount, so this resolves on the first check; it
 *  stays a waitFor for resilience and must run with REAL timers. */
async function awaitHandlerCaptured() {
  await waitFor(() => expect(capturedHandler).not.toBeNull())
}

/** Drive a synthetic envelope through the provider's captured handler.
 *  Assumes `awaitHandlerCaptured` has already run. Works with fake
 *  timers because it's a synchronous dispatch. */
function dispatch(envelope: EventEnvelope) {
  if (!capturedHandler) {
    throw new Error(
      "capturedHandler not set — call awaitHandlerCaptured() with real timers first"
    )
  }
  act(() => {
    capturedHandler!(envelope)
  })
}

describe("DelegationProvider", () => {
  beforeEach(() => {
    // Fake timers are activated PER-TEST after the provider's async
    // subscribe-handler capture has resolved. Doing it in beforeEach
    // breaks waitFor (which polls via setTimeout) and stalls every test.
    capturedHandler = null
    mockAttach.mockReset()
    mockDetach.mockReset()
  })

  afterEach(() => {
    // Defensive: clear any test-local fake-timer install. Real timers
    // are the harness default; useRealTimers is a no-op if no fakes
    // are active.
    vi.useRealTimers()
  })

  it("flips binding to err when delegation_completed arrives with kind=err and schedules a detach", async () => {
    // Regression for the termination-cascade gap
    // (.docs/issues/2026-05-24-delegation-termination-cascade.md): every
    // broker terminal path now emits DelegationCompleted, so the context's
    // existing `delegation_completed` branch has to flip the binding to
    // err — not stay at "running" — and the detach grace timer has to
    // fire on err as well as ok.
    renderProvider()
    await awaitHandlerCaptured()
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("status")).toHaveTextContent("running")
    expect(mockAttach).toHaveBeenCalledTimes(1)

    // Install fake timers BEFORE the completed event so the setTimeout
    // scheduled by `cancelDetachTimer + setTimeout` registers as a fake
    // timer we can advance below.
    vi.useFakeTimers()
    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      result: { kind: "err", error_code: "canceled" },
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("status")).toHaveTextContent("err")
    expect(screen.getByTestId("error-code")).toHaveTextContent("canceled")

    // Detach is delayed by CHILD_DETACH_GRACE_MS (2_000ms). Before the
    // timer fires the detach has been *scheduled* but not yet *called*.
    expect(mockDetach).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(mockDetach).toHaveBeenCalledWith("c1")
  })

  it("flips binding to ok and detaches when delegation_completed arrives with kind=ok", async () => {
    // Cover the happy-path detach so the err and ok paths share coverage.
    // Previously only the ok branch was exercised end-to-end (via the
    // broker happy-path → lifecycle.forward_turn_complete_to_broker emit).
    renderProvider()
    await awaitHandlerCaptured()
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
    } as unknown as EventEnvelope)

    vi.useFakeTimers()
    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      result: { kind: "ok", duration_ms: 1234 },
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("status")).toHaveTextContent("ok")

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(mockDetach).toHaveBeenCalledWith("c1")
  })

  it("synthesizes a minimal binding when delegation_completed arrives without a prior delegation_started", async () => {
    // Context-mount-after-start path (e.g. user switched tabs mid-delegation).
    // The completed event has to still update the binding so the parent UI
    // shows the terminal state instead of dropping the event silently.
    renderProvider()
    await awaitHandlerCaptured()

    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      result: { kind: "err", error_code: "timeout" },
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("status")).toHaveTextContent("err")
    expect(screen.getByTestId("error-code")).toHaveTextContent("timeout")
    // Regression lock (Medium): with no prior delegation_started, the binding
    // must take the agent_type the completion now carries — not a hardcoded
    // default — so the card shows the correct agent icon/label.
    expect(screen.getByTestId("agent")).toHaveTextContent("codex")
  })

  it("carries the assistant a delegation runs as, from either event", async () => {
    renderProvider()
    await awaitHandlerCaptured()
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      assistant_id: 3,
      assistant_name: "Reviewer",
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("assistant")).toHaveTextContent("3:Reviewer")

    // A completion that arrives without its start still names the assistant.
    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-2",
      child_connection_id: "c2",
      child_conversation_id: 100,
      agent_type: "codex",
      assistant_id: 4,
      assistant_name: "Planner",
      result: { kind: "ok" },
    } as unknown as EventEnvelope)
    // The probe watches pt-1; a plain agent delegation names none.
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("assistant")).toHaveTextContent("-:-")
  })

  it("cancels a pending detach when delegation_started replays for the same parent_tool_use_id", async () => {
    // Defensive: a reconnect / replay can re-emit delegation_started for
    // an entry currently mid-grace-period. The detach timer must be
    // canceled so the synthetic child state isn't torn down right as it
    // returns.
    renderProvider()
    await awaitHandlerCaptured()
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
    } as unknown as EventEnvelope)
    vi.useFakeTimers()
    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      result: { kind: "ok", duration_ms: 100 },
    } as unknown as EventEnvelope)
    // Re-emit started before grace period expires
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
    } as unknown as EventEnvelope)
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    // Detach was canceled by the re-arriving start event.
    expect(mockDetach).not.toHaveBeenCalled()
  })

  // `resume_delegation` re-binds the child to the ORIGINAL delegate call's
  // tool_use_id, so the resume card's own id matches no binding. The broker
  // task id — which the resumed run deliberately keeps — is its only handle.
  it("finds a binding by the broker task id", async () => {
    render(
      <DelegationProvider>
        <TaskIdProbe taskId="task-abc" />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()
    expect(screen.getByTestId("by-task-id")).toHaveTextContent("none")

    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-original",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      task_id: "task-abc",
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("by-task-id")).toHaveTextContent("pt-original")

    // The task id survives the child's completion, so the resumed card keeps
    // tracking it to its terminal status.
    dispatch({
      type: "delegation_completed",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-original",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      result: { kind: "ok", duration_ms: 100 },
    } as unknown as EventEnvelope)
    expect(screen.getByTestId("by-task-id-status")).toHaveTextContent("ok")
  })

  it("does not match a different task id, or an empty one", async () => {
    render(
      <DelegationProvider>
        <TaskIdProbe taskId="task-other" />
        <TaskIdProbe taskId="" />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()
    dispatch({
      type: "delegation_started",
      parent_connection_id: "p1",
      parent_tool_use_id: "pt-original",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      task_id: "task-abc",
    } as unknown as EventEnvelope)
    for (const probe of screen.getAllByTestId("by-task-id")) {
      expect(probe).toHaveTextContent("none")
    }
  })
})

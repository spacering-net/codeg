import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SubAgentOverlay } from "./sub-agent-overlay"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"

// The rows resolve their model from `useDelegatedSubSession` (live binding) and
// the connections store (child pending-permission). Stub both — the same
// contexts DelegatedSubThread's own test stubs.
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

// SubAgentSessionDialog pulls in MessageListView + the runtime provider tree.
// Stub it to a sentinel exposing the open state + target conversation id.
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

/** Per-parentToolUseId binding map the mocked hook reads from. */
let bindings: Record<string, DelegationBinding | undefined> = {}

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

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function source(
  parentToolUseId: string,
  args: Record<string, unknown>
): DelegationCardSource {
  return { parentToolUseId, input: JSON.stringify(args) }
}

describe("SubAgentOverlay", () => {
  beforeEach(() => {
    bindings = {}
    mockedHook.mockReset()
    mockedHook.mockImplementation((id: string) => ({
      binding: bindings[id],
      detail: null,
      loading: false,
      error: null,
    }))
  })

  it("renders nothing when there are no delegations", () => {
    const { container } = renderWithIntl(
      <SubAgentOverlay delegations={[]} overlayKey="k-empty" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("collapses to a pill summarizing the count by default", () => {
    const delegations = [
      source("pt-1", { agent_type: "codex", task: "Investigate flaky test" }),
      source("pt-2", { agent_type: "claude_code", task: "Write the fix" }),
    ]
    renderWithIntl(
      <SubAgentOverlay delegations={delegations} overlayKey="k-1" />
    )
    expect(screen.getByText("Sub-agents 2")).toBeInTheDocument()
    // Rows are hidden while collapsed.
    expect(screen.queryByText("Investigate flaky test")).not.toBeInTheDocument()
  })

  it("clicking the pill expands the list with icon/name/task per sub-agent", () => {
    const delegations = [
      source("pt-1", { agent_type: "codex", task: "Investigate flaky test" }),
      source("pt-2", { agent_type: "claude_code", task: "Write the fix" }),
    ]
    renderWithIntl(
      <SubAgentOverlay delegations={delegations} overlayKey="k-2" />
    )
    fireEvent.click(screen.getByText("Sub-agents 2").closest("button")!)

    // Header title + both rows (one per delegation).
    expect(screen.getByText("Sub-agents")).toBeInTheDocument()
    expect(screen.getAllByTestId("sub-agent-row")).toHaveLength(2)
    expect(screen.getByText("Investigate flaky test")).toBeInTheDocument()
    expect(screen.getByText("Write the fix")).toBeInTheDocument()
  })

  it("opens the child session dialog when a row with a child id is clicked", () => {
    bindings["pt-1"] = bindingOf({
      parentToolUseId: "pt-1",
      childConversationId: 77,
      status: "running",
    })
    const delegations = [
      source("pt-1", { agent_type: "codex", task: "Investigate flaky test" }),
    ]
    renderWithIntl(
      <SubAgentOverlay
        delegations={delegations}
        overlayKey="k-3"
        defaultExpanded
      />
    )
    expect(
      screen.queryByTestId("sub-agent-session-dialog")
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByText("Investigate flaky test").closest("button")!
    )

    const dialog = screen.getByTestId("sub-agent-session-dialog")
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute("data-conversation-id", "77")
  })

  it("renders a graceful fallback row for a delegation with unparseable input", () => {
    const delegations = [
      source("pt-1", { agent_type: "codex", task: "Real task" }),
      { parentToolUseId: "pt-2", input: "not-json" } as DelegationCardSource,
    ]
    renderWithIntl(
      <SubAgentOverlay
        delegations={delegations}
        overlayKey="k-4"
        defaultExpanded
      />
    )
    // The collapsed count never disagrees with the list: both rows render.
    expect(screen.getAllByTestId("sub-agent-row")).toHaveLength(2)
    expect(screen.getByText("Real task")).toBeInTheDocument()
    // The unresolvable one degrades to the "Sub-agent" (unknown agent) label.
    expect(screen.getByText("Sub-agent")).toBeInTheDocument()
  })

  it("renders fallback rows even when every delegation is unresolvable", () => {
    const delegations = [
      { parentToolUseId: "pt-1", input: "not-json" } as DelegationCardSource,
      { parentToolUseId: "pt-2", input: "also-bad" } as DelegationCardSource,
    ]
    renderWithIntl(
      <SubAgentOverlay
        delegations={delegations}
        overlayKey="k-5"
        defaultExpanded
      />
    )
    expect(screen.getAllByTestId("sub-agent-row")).toHaveLength(2)
    expect(screen.getAllByText("Sub-agent")).toHaveLength(2)
  })

  it("shows the broker task id (short, #-prefixed) after each agent name", () => {
    const delegations: DelegationCardSource[] = [
      {
        ...source("pt-1", { agent_type: "codex", task: "Investigate" }),
        // The ack output carries the broker-minted task_id.
        output: JSON.stringify({ task_id: "abc12345def67890" }),
      },
    ]
    renderWithIntl(
      <SubAgentOverlay
        delegations={delegations}
        overlayKey="k-taskid"
        defaultExpanded
      />
    )
    // Truncated to 8 chars in the row, full id in the tooltip.
    const badge = screen.getByText("#abc12345")
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute("title", "abc12345def67890")
  })

  it("omits the task id badge when no id has been minted yet", () => {
    const delegations = [
      source("pt-1", { agent_type: "codex", task: "Investigate" }),
    ]
    renderWithIntl(
      <SubAgentOverlay
        delegations={delegations}
        overlayKey="k-noid"
        defaultExpanded
      />
    )
    expect(screen.getByTestId("sub-agent-row")).toBeInTheDocument()
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen, waitFor, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import type { HandoffPlan, HandoffResult } from "@/lib/api"

const h = vi.hoisted(() => ({
  plan: vi.fn(),
  handoff: vi.fn(),
  openTab: vi.fn(),
  bind: vi.fn(),
  refresh: vi.fn(async () => {}),
  disconnect: vi.fn(async () => true),
  adopt: vi.fn(async () => {}),
  clear: vi.fn(),
  external: vi.fn(),
  refetch: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  prefs: vi.fn(() => ({
    modeId: "code",
    configValues: { model: "target-model" },
  })),
}))
vi.mock("@/lib/api", () => ({ acpHandoffPlan: h.plan, acpHandoff: h.handoff }))
vi.mock("sonner", () => ({ toast: { success: h.success, info: h.info } }))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: ({
    defaultAgentType,
    onSelect,
    disabled,
  }: {
    defaultAgentType: string
    onSelect: (v: string) => void
    disabled: boolean
  }) => (
    <select
      aria-label="Agent"
      value={defaultAgentType}
      onChange={(e) => onSelect(e.target.value)}
      disabled={disabled}
    >
      <option value="claude_code">Claude Code</option>
      <option value="codex">Codex</option>
      <option value="grok">Grok</option>
    </select>
  ),
}))
vi.mock("@/components/settings/account-management-dialog", () => ({
  AccountManagementDialog: () => (
    <div
      data-testid="account-management"
      role="dialog"
      aria-label="Manage accounts"
    />
  ),
}))
vi.mock("@/hooks/use-agent-accounts", () => ({
  useAgentAccounts: (agentType: string) => ({
    accounts: [
      {
        id: "personal",
        name: "Personal",
        agentType,
        homeDir: "/account",
        removed: false,
      },
    ],
    capability: { supported: true },
    loading: false,
    error: false,
    refresh: vi.fn(),
  }),
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    disconnect: h.disconnect,
    adoptOwnedConnection: h.adopt,
    clearAcpLoadError: h.clear,
  }),
}))
vi.mock("@/stores/tab-store", () => ({
  useTabStore: {
    getState: () => ({
      rawTabs: [
        {
          id: "same-tab",
          conversationId: 10,
          folderId: 1,
          agentType: "claude_code",
          title: "Work",
          runtimeConversationId: -10,
        },
      ],
      openTab: h.openTab,
      bindConversationTab: h.bind,
    }),
  },
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: {
    getState: () => ({ refreshConversations: h.refresh }),
  },
}))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeActions: () => ({
    setExternalId: h.external,
    refetchDetail: h.refetch,
  }),
}))
vi.mock("@/lib/selector-prefs-storage", () => ({
  getSavedPrefsForConnect: h.prefs,
}))

import { AgentHandoffDialog } from "./agent-handoff-dialog"
import { useConversationHandoffStore } from "@/stores/conversation-handoff-store"

function plan(overrides: Partial<HandoffPlan> = {}): HandoffPlan {
  return {
    sourceAgentType: "claude_code",
    sourceAccountId: "source-account",
    sourceExternalId: "source-session",
    targetAgentType: "codex",
    targetAccountId: null,
    path: "context",
    turnCount: 100,
    briefingChars: 0,
    briefingTruncated: false,
    verbatimTurns: 0,
    ...overrides,
  }
}
function result(overrides: Partial<HandoffResult> = {}): HandoffResult {
  return {
    conversationId: 10,
    folderId: 1,
    fromAgentType: "claude_code",
    toAgentType: "codex",
    agentAccountId: null,
    externalId: "target-session",
    path: "context",
    connectionId: "target-connection",
    briefingTruncated: false,
    responseStarted: true,
    workingDir: "/project",
    ...overrides,
  }
}
function mount(initialAccountId?: string | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AgentHandoffDialog
        open
        onOpenChange={vi.fn()}
        conversationId={10}
        folderId={1}
        sourceAgentType="claude_code"
        title="Work"
        initialAccountId={initialAccountId}
      />
    </NextIntlClientProvider>
  )
}
const confirm = () =>
  screen.getByRole("button", {
    name: messages.Folder.chat.agentHandoff.confirm,
  })
async function chooseCodex() {
  fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
    target: { value: "codex" },
  })
  await waitFor(() => expect(confirm()).toBeEnabled())
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useConversationHandoffStore.setState({ busy: {} })
  h.plan.mockImplementation(
    async (_id: number, target: string, account: string | null) =>
      plan({
        targetAgentType: target as HandoffPlan["targetAgentType"],
        targetAccountId: account,
      })
  )
  h.handoff.mockResolvedValue(result())
})
describe("account-aware conversation handoff", () => {
  it("opens on this conversation's account rather than the new-chat preference", async () => {
    h.plan.mockImplementation(
      async (_id: number, target: string, account: string | null) =>
        plan({
          sourceAccountId: "personal",
          targetAgentType: target as HandoffPlan["targetAgentType"],
          targetAccountId: account,
          blocked: account === "personal" ? "same_agent" : undefined,
        })
    )
    mount()
    await waitFor(() =>
      expect(h.plan).toHaveBeenLastCalledWith(10, "claude_code", "personal")
    )
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
      "Personal"
    )
    expect(confirm()).toBeDisabled()
  })

  it("keeps an explicit Default destination chosen in the chat picker", async () => {
    mount(null)
    await waitFor(() => expect(confirm()).toBeEnabled())
    expect(h.plan).toHaveBeenLastCalledWith(10, "claude_code", null)
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
      "Default"
    )
  })
  it("keeps the existing tab and adopts the verified target as owner", async () => {
    mount()
    await chooseCodex()
    expect(screen.getByText(/complete saved chat/)).toBeVisible()
    fireEvent.click(confirm())
    await waitFor(() => expect(h.bind).toHaveBeenCalled())
    expect(h.openTab).not.toHaveBeenCalled()
    expect(h.bind).toHaveBeenCalledWith(
      "same-tab",
      10,
      "codex",
      "Work",
      -10,
      1,
      "/project"
    )
    expect(h.external).toHaveBeenCalledWith(-10, "target-session")
    expect(h.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        contextKey: "same-tab",
        connectionId: "target-connection",
        agentAccountId: null,
      })
    )
    expect(h.handoff).toHaveBeenCalledWith(
      10,
      "codex",
      null,
      "code",
      { model: "target-model" },
      {
        sourceAgentType: "claude_code",
        sourceAccountId: "source-account",
        sourceExternalId: "source-session",
        targetAccountId: null,
      }
    )
    expect(useConversationHandoffStore.getState().busy[10]).toBe(false)
  })
  it("uses the selected native account and its own preferences", async () => {
    mount()
    await chooseCodex()
    fireEvent.click(screen.getByRole("combobox", { name: "Account" }))
    fireEvent.click(await screen.findByRole("option", { name: "Personal" }))
    await waitFor(() =>
      expect(h.plan).toHaveBeenLastCalledWith(10, "codex", "personal")
    )
    await waitFor(() => expect(confirm()).toBeEnabled())
    fireEvent.click(confirm())
    await waitFor(() => expect(h.handoff).toHaveBeenCalled())
    expect(h.prefs).toHaveBeenCalledWith("codex:account:personal")
    expect(h.handoff.mock.calls[0][5].targetAccountId).toBe("personal")
  })
  it("cannot confirm an older plan after the target changes", async () => {
    let resolveOld!: (v: HandoffPlan) => void
    h.plan.mockImplementation((_id: number, target: string) =>
      target === "codex"
        ? new Promise<HandoffPlan>((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve(plan({ blocked: "same_agent" }))
    )
    mount()
    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
      target: { value: "codex" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
      target: { value: "grok" },
    })
    await act(async () => {
      resolveOld(plan())
    })
    expect(confirm()).toBeDisabled()
    expect(
      screen.getByText(messages.Folder.chat.agentHandoff.blockedSameAccount)
    ).toBeVisible()
  })
  it("keeps the source tab when the server refuses the switch", async () => {
    h.handoff.mockRejectedValue(new Error("The saved history changed."))
    mount()
    await chooseCodex()
    fireEvent.click(confirm())
    expect(await screen.findByText("The saved history changed.")).toBeVisible()
    expect(h.bind).not.toHaveBeenCalled()
    expect(h.adopt).not.toHaveBeenCalled()
    expect(useConversationHandoffStore.getState().busy[10]).toBe(false)
  })
  it("blocks repeat clicks and pauses the source while switching", async () => {
    let finish!: (v: HandoffResult) => void
    h.handoff.mockImplementation(
      () =>
        new Promise<HandoffResult>((resolve) => {
          finish = resolve
        })
    )
    mount()
    await chooseCodex()
    fireEvent.click(confirm())
    expect(useConversationHandoffStore.getState().busy[10]).toBe(true)
    expect(
      screen.getByRole("button", {
        name: messages.Folder.chat.agentHandoff.working,
      })
    ).toBeDisabled()
    await act(async () => {
      finish(result())
    })
    expect(h.handoff).toHaveBeenCalledTimes(1)
  })
  it("offers account setup in the same flow", async () => {
    mount()
    await chooseCodex()
    fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }))
    // The mock deliberately has no Radix portal; the rendered management
    // dialog's focus and visibility are covered by the browser test.
    expect(screen.getByTestId("account-management")).toBeInTheDocument()
  })
  it("distinguishes a committed switch from a prompt that needs retrying", async () => {
    h.handoff.mockResolvedValue(result({ responseStarted: false }))
    mount()
    await chooseCodex()
    fireEvent.click(confirm())
    await waitFor(() =>
      expect(h.info).toHaveBeenCalledWith(
        messages.Folder.chat.agentHandoff.continueAfterRetry
      )
    )
    expect(h.bind).toHaveBeenCalled()
  })
})

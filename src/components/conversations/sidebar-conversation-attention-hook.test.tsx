import { StrictMode, useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ConnectionState,
  ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import type { TabItem } from "@/stores/tab-store"

const fake = vi.hoisted(() => ({
  store: null as ConnectionStoreApi | null,
  connections: new Map<string, ConnectionState>(),
  listeners: new Map<string, Set<() => void>>(),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => fake.store,
}))

import { useSidebarConversationCompletion } from "./sidebar-conversation-attention"

const tabs: TabItem[] = [
  {
    id: "tab-11",
    kind: "conversation",
    folderId: 1,
    conversationId: 11,
    agentType: "claude_code",
    title: "conv-11",
    isPinned: false,
  },
]

function connection(status: ConnectionState["status"]): ConnectionState {
  return { contextKey: "tab-11", status } as ConnectionState
}

function CompletionProbe({ testId }: { testId: string }) {
  const completionKeys = useSidebarConversationCompletion(tabs, null)
  return <output data-testid={testId}>{[...completionKeys].join(",")}</output>
}

function notifyConnection(status: ConnectionState["status"]) {
  fake.connections.set("tab-11", connection(status))
  for (const listener of fake.listeners.get("tab-11") ?? []) listener()
}

beforeEach(() => {
  fake.connections = new Map([["tab-11", connection("prompting")]])
  fake.listeners = new Map()
  fake.store = {
    getConnection: (key) => fake.connections.get(key),
    getConnectPending: () => undefined,
    getActiveKey: () => null,
    subscribeKey: (key, callback) => {
      const listeners = fake.listeners.get(key) ?? new Set()
      listeners.add(callback)
      fake.listeners.set(key, listeners)
      return () => {
        listeners.delete(callback)
        if (listeners.size === 0) fake.listeners.delete(key)
      }
    },
    subscribeActiveKey: () => () => {},
  }
})

describe("sidebar completion hook lifecycle", () => {
  it("keeps observing completion after Strict Mode replays effects", async () => {
    render(
      <StrictMode>
        <CompletionProbe testId="completion" />
      </StrictMode>
    )

    await waitFor(() => {
      expect(fake.listeners.get("tab-11")?.size).toBeGreaterThan(0)
    })

    act(() => notifyConnection("connected"))

    expect(screen.getByTestId("completion").textContent).toBe("claude_code:11")
  })

  it("preserves unread completion while the sidebar consumer is unmounted", async () => {
    function Harness() {
      const [showSidebar, setShowSidebar] = useState(true)
      return (
        <>
          <CompletionProbe testId="bridge" />
          {showSidebar ? <CompletionProbe testId="sidebar" /> : null}
          <button onClick={() => setShowSidebar((value) => !value)}>
            Toggle sidebar
          </button>
        </>
      )
    }

    render(<Harness />)

    await waitFor(() => {
      expect(fake.listeners.get("tab-11")?.size).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }))

    act(() => notifyConnection("connected"))

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }))
    expect(screen.getByTestId("sidebar").textContent).toBe("claude_code:11")
  })
})

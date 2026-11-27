import { type ComponentProps, type ReactElement } from "react"
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import type { InstalledPlugin } from "@/lib/host-plugins"
import {
  clearMessageInputDraftV2,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import type { Transport } from "@/lib/transport"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  isMobile: false,
  handleSend: vi.fn(),
  composers: new Map<string, RichComposerHandle>(),
  activeDraftKey: "",
}))

vi.mock("@/components/chat/composer/rich-composer", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/chat/composer/rich-composer")
    >()
  const React = await import("react")
  const Captured = React.forwardRef<
    RichComposerHandle,
    ComponentProps<typeof actual.RichComposer>
  >((props, ref) => {
    const boxRef = React.useRef<HTMLDivElement | null>(null)
    const assign = (handle: RichComposerHandle | null) => {
      const cardId = boxRef.current
        ?.closest("[data-canvas-card]")
        ?.getAttribute("data-canvas-card")
      if (cardId) {
        if (handle) h.composers.set(cardId, handle)
        else h.composers.delete(cardId)
      }
      if (typeof ref === "function") ref(handle)
      else if (ref) ref.current = handle
    }
    return React.createElement(
      "div",
      { ref: boxRef },
      React.createElement(actual.RichComposer, { ...props, ref: assign })
    )
  })
  Captured.displayName = "CanvasCapturedRichComposer"
  return { ...actual, RichComposer: Captured }
})

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
  },
}))
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => h.isMobile,
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { send_message: "enter", newline_in_message: "shift+enter" },
  }),
}))
vi.mock("@/hooks/use-agent-skills", () => ({ useAgentSkills: () => [] }))
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({
    enabledIds: new Set(),
    ready: false,
    supported: true,
  }),
}))
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => async () => [],
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationContextBar: () => null,
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: () => false,
}))
vi.mock("@/components/chat/composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("@/components/chat/composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/chat/remote-control-strip", () => ({
  RemoteControlStrip: () => null,
}))
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: () => null,
}))
vi.mock("@/components/chat/question-dialog", () => ({
  QuestionDialog: () => null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: () => null,
}))
vi.mock("@/components/chat/plan-approval-card", () => ({
  PlanApprovalCard: () => null,
}))
vi.mock("@/components/message/message-list-view", () => ({
  MessageListView: () => <div data-testid="canvas-transcript" />,
}))
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: () => null,
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    registerLiveMessageSink: () => () => {},
    answerQuestion: vi.fn(),
    answerPlanApproval: vi.fn(),
    dismissSessionFailures: vi.fn(),
  }),
  getCachedSelectors: () => null,
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [] }),
}))
vi.mock("@/hooks/use-connection-lifecycle", () => ({
  useConnectionLifecycle: () => ({
    conn: {
      connectionId: "conn-1",
      status: "connected",
      promptCapabilities: {
        image: false,
        audio: false,
        embedded_context: false,
      },
      modes: null,
      configOptions: null,
      availableCommands: [],
      claudeApiRetry: null,
      sessionFailures: [],
      remoteControl: null,
      pendingPermission: null,
      pendingQuestion: null,
      pendingAskQuestion: null,
      pendingPlanApproval: null,
      promptSuggestion: null,
      isViewer: false,
      agentType: "claude_code",
    },
    modeLoading: false,
    configOptionsLoading: false,
    selectorsLoading: false,
    autoConnectError: null,
    handleFocus: vi.fn(),
    handleSend: h.handleSend,
    handleSetConfigOption: vi.fn(),
    handleCancel: vi.fn(),
    handleRespondPermission: vi.fn(),
  }),
}))
vi.mock("@/hooks/use-conversation-detail", () => ({
  useConversationDetail: (conversationId: number) => ({
    detail: {
      summary: { id: conversationId, external_id: `ext-${conversationId}` },
    },
    loading: false,
    error: null,
    acpLoadError: null,
  }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    refreshConversations: vi.fn(),
    upsertFolder: vi.fn(),
    conversations: [
      { id: 101, folder_id: 1, title: "Card A" },
      { id: 102, folder_id: 1, title: "Card B" },
      { id: 103, folder_id: 1, title: "Card C" },
    ],
    allFolders: [{ id: 1, name: "repo", path: "/repo", kind: "regular" }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  useStore.setState = () => {}
  useStore.subscribe = () => () => {}
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => async () => {},
}))
vi.mock("@/stores/conversation-runtime-store", () => {
  const emptyMap = new Map()
  const state = {
    byConversationId: emptyMap,
    appendOptimisticTurn: vi.fn(),
    removeOptimisticTurn: vi.fn(),
    completeTurn: vi.fn(),
    migrateConversation: vi.fn(),
    refetchDetail: vi.fn(),
    setDbConversationId: vi.fn(),
    setExternalId: vi.fn(),
    setLiveMessage: vi.fn(),
    setSyncState: vi.fn(),
    syncTurnMetadata: vi.fn(),
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return {
    getTimelineTurns: () => [],
    useConversationRuntimeStore: useStore,
    useConversationRuntimeActions: () => state,
  }
})
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
  openUrl: vi.fn(async () => {}),
}))
vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => async () => {},
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  quickMessagesList: vi.fn(async () => []),
  uploadAttachment: vi.fn(() => new Promise(() => {})),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}))
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

import { CanvasConversationSurface } from "./canvas-conversation-surface"

class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  peer!: FakeMessagePort

  postMessage(data: unknown) {
    if (this.closed) return
    if (this.peer && !this.peer.closed) {
      this.peer.onmessage?.({ data })
    }
  }

  close() {
    this.closed = true
  }
}

class FakeMessageChannel {
  port1: FakeMessagePort
  port2: FakeMessagePort

  constructor() {
    this.port1 = new FakeMessagePort()
    this.port2 = new FakeMessagePort()
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

function connectIframe(iframe: HTMLIFrameElement) {
  const srcDoc = iframe.getAttribute("srcdoc") ?? ""
  const match = srcDoc.match(/const key = "([0-9a-f]+)"/)
  if (!match) throw new Error("Handshake key missing from srcDoc")
  const key = match[1]
  const received: unknown[] = []
  let framePort: FakeMessagePort | null = null

  const fakeWindow = {
    postMessage: (data: unknown, _origin: string, transfer?: unknown[]) => {
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { type?: string }).type === "codeg-plugin-port" &&
        Array.isArray(transfer) &&
        transfer[0] instanceof FakeMessagePort
      ) {
        framePort = transfer[0]
        framePort.onmessage = ({ data: msg }) => {
          received.push(msg)
        }
        framePort.postMessage({ type: "authenticate", key })
      }
    },
  }

  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: fakeWindow,
  })

  const readyEvent = new Event("message")
  Object.defineProperties(readyEvent, {
    origin: { value: "null" },
    source: { value: fakeWindow },
    data: { value: { type: "codeg-plugin-ready", key } },
  })
  window.dispatchEvent(readyEvent)

  return {
    received,
    sendInsertText(id: number, text: string) {
      framePort!.postMessage({
        id,
        operation: "composer",
        json: JSON.stringify({ type: "insertText", text }),
      })
    },
  }
}

function createMockTransport(initial: InstalledPlugin[]) {
  let plugins = initial
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const call = vi.fn(async (method: string) => {
    if (method === "host_plugins_list") return plugins
    if (method === "host_plugins_client_html") return "<p>canvas-plugin</p>"
    return null
  })
  const subscribe = vi.fn(
    async <T,>(channel: string, handler: (payload: T) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const wrapped = handler as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    }
  )
  return {
    transport: {
      call: call as Transport["call"],
      subscribe: subscribe as Transport["subscribe"],
    },
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const handler of listeners.get("host-plugins://changed") ?? []) {
        handler(null)
      }
    },
  }
}

function makeCanvasPlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "acme.canvas-composer",
      name: "Canvas Helper",
      version: "1.0.0",
      client: { entry: "helper.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        clientSurfaces: [
          { id: "insert", title: "Insert Clause", slot: "composer" },
        ],
      },
    },
  }
}

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("CanvasConversationSurface composer plugin text insertion", () => {
  const originalMessageChannel = globalThis.MessageChannel

  beforeEach(() => {
    vi.clearAllMocks()
    h.isMobile = false
    h.composers.clear()
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
  })

  afterEach(() => {
    cleanup()
    globalThis.MessageChannel = originalMessageChannel
    h.transport = null
    clearMessageInputDraftV2("canvas-draft:card-a")
    clearMessageInputDraftV2("canvas-draft:card-b")
  })

  it("inserts into the owning canvas card draft without affecting sibling cards in the same workspace or auto-sending", async () => {
    const mock = createMockTransport([makeCanvasPlugin(true)])
    h.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <div>
          <div data-canvas-card="card-a">
            <CanvasConversationSurface
              contextKey="card-a"
              conversationId={101}
              agentType="claude_code"
              isActive
            />
          </div>
          <div data-canvas-card="card-b">
            <CanvasConversationSurface
              contextKey="card-b"
              conversationId={102}
              agentType="claude_code"
              isActive={false}
            />
          </div>
        </div>
      )
    )

    await waitFor(() => {
      expect(h.composers.get("card-a")?.getEditor()).not.toBeNull()
      expect(h.composers.get("card-b")?.getEditor()).not.toBeNull()
    })

    act(() => {
      h.composers.get("card-a")!.setText("card A: ")
      h.composers.get("card-b")!.setText("card B untouched")
    })

    // Wait for card B's own 300ms debounced draft save to settle and capture its
    // baseline before driving card A's plugin surface, so machine load never
    // races the pending timer against the post-insertion assertion.
    await waitFor(() => {
      expect(loadMessageInputDraftV2("canvas-draft:card-b")).not.toBeNull()
    })
    const cardBBaselineDraft = loadMessageInputDraftV2("canvas-draft:card-b")

    const cardAEl = document.querySelector<HTMLElement>(
      '[data-canvas-card="card-a"]'
    )!
    const triggerA = await within(cardAEl).findByRole("button", {
      name: "Insert Clause",
    })
    await user.click(triggerA)

    const dialog = await screen.findByRole("dialog")
    const iframe = (await within(dialog).findByTitle(
      "Insert Clause"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session = connectIframe(iframe)

    expect(session.received[0]).toEqual({
      type: "context",
      context: {
        type: "clientSurface",
        slot: "composer",
        id: "insert",
        folderId: 1,
        conversationId: 101,
        sessionKey: "card-a",
        locale: "en",
      },
    })

    await act(async () => {
      session.sendInsertText(1, "clause from plugin")
    })

    await waitFor(() => {
      expect(session.received).toContainEqual({
        id: 1,
        ok: true,
        value: { inserted: true, length: "clause from plugin".length },
      })
    })

    expect(h.composers.get("card-a")!.getText()).toBe(
      "card A: clause from plugin"
    )
    expect(h.composers.get("card-b")!.getText()).toBe("card B untouched")
    expect(loadMessageInputDraftV2("canvas-draft:card-a")?.kind).toBe("doc")
    expect(
      JSON.stringify(loadMessageInputDraftV2("canvas-draft:card-a"))
    ).toContain("clause from plugin")
    expect(loadMessageInputDraftV2("canvas-draft:card-b")).toEqual(
      cardBBaselineDraft
    )
    expect(h.handleSend).not.toHaveBeenCalled()

    // Disabling the plugin withdraws the dialog and blocks subsequent writes on the old port
    act(() => {
      mock.setPlugins([makeCanvasPlugin(false)])
    })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    act(() => {
      session.sendInsertText(2, "STALE_AFTER_DISABLE")
    })
    expect(h.composers.get("card-a")!.getText()).toBe(
      "card A: clause from plugin"
    )
  })

  it("rejects stale iframe writes after closing the dialog, switching the canvas card session, or switching the connected host", async () => {
    const host1 = createMockTransport([makeCanvasPlugin(true)])
    const host2 = createMockTransport([makeCanvasPlugin(true)])
    h.transport = host1.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <div data-canvas-card="card-a">
          <CanvasConversationSurface
            contextKey="card-a"
            conversationId={101}
            agentType="claude_code"
            isActive
          />
        </div>
      )
    )

    await waitFor(() => {
      expect(h.composers.get("card-a")?.getEditor()).not.toBeNull()
    })
    act(() => {
      h.composers.get("card-a")!.setText("initial")
    })

    // 1) Open dialog, connect iframe, then close dialog via Escape -> old iframe cannot write
    await user.click(
      await screen.findByRole("button", { name: "Insert Clause" })
    )
    const dialog1 = await screen.findByRole("dialog")
    const iframe1 = (await within(dialog1).findByTitle(
      "Insert Clause"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session1 = connectIframe(iframe1)

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    act(() => {
      session1.sendInsertText(1, "AFTER_CLOSE")
    })
    expect(h.composers.get("card-a")!.getText()).toBe("initial")

    // 2) Reopen dialog, then switch card session (conversationId 101 -> 103 in same workspace) -> withdrawn & blocked
    await user.click(screen.getByRole("button", { name: "Insert Clause" }))
    const dialog2 = await screen.findByRole("dialog")
    const iframe2 = (await within(dialog2).findByTitle(
      "Insert Clause"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session2 = connectIframe(iframe2)

    rerender(
      withIntl(
        <div data-canvas-card="card-a">
          <CanvasConversationSurface
            contextKey="card-a"
            conversationId={103}
            agentType="claude_code"
            isActive
          />
        </div>
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => {
      session2.sendInsertText(2, "AFTER_SESSION_SWITCH")
    })
    expect(h.composers.get("card-a")!.getText()).toBe("initial")

    // 3) Reopen dialog, then switch connected host transport -> old host iframe is blocked immediately
    await user.click(screen.getByRole("button", { name: "Insert Clause" }))
    const dialog3 = await screen.findByRole("dialog")
    const iframe3 = (await within(dialog3).findByTitle(
      "Insert Clause"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session3 = connectIframe(iframe3)

    h.transport = host2.transport
    await act(async () => {
      session3.sendInsertText(3, "AFTER_HOST_SWITCH")
    })
    await waitFor(() => {
      expect(session3.received).toContainEqual({
        id: 3,
        ok: false,
        error: "Plugin composer surface is no longer active",
      })
    })
    expect(h.composers.get("card-a")!.getText()).toBe("initial")
    expect(h.handleSend).not.toHaveBeenCalled()
  })
})

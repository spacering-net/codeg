import { type ReactElement } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type {
  HostPluginSessionContext,
  InstalledPlugin,
} from "@/lib/host-plugins"
import {
  APPEND_TEXT_TO_SESSION_EVENT,
  type AppendTextToSessionDetail,
} from "@/lib/session-attachment-events"
import type { Transport } from "@/lib/transport"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteConnectionId: null as number | null,
  transportListeners: new Set<() => void>(),
  openPluginPanel: vi.fn(),
  openPluginScreen: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  isMobile: false,
}))

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.activeRemoteConnectionId,
  subscribeTransportChange: (listener: () => void) => {
    h.transportListeners.add(listener)
    return () => {
      h.transportListeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
  },
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useOptionalAuxPanelContext: () => ({
    openPluginPanel: h.openPluginPanel,
  }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({
    openPluginScreen: h.openPluginScreen,
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    info: h.toastInfo,
    error: h.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => h.isMobile,
}))

vi.mock("@/lib/api", () => ({
  updateConversationTitle: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversationStatus: vi.fn(),
  updateConversationPinned: vi.fn(),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ closeTab: vi.fn(), openNewConversationTab: vi.fn() }),
}))

vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    updateConversationLocal: vi.fn(),
    refreshConversations: vi.fn(),
    conversations: [] as unknown[],
    allFolders: [
      { id: 7, name: "repo-a", alias: null, parent_id: null, kind: "regular" },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})

vi.mock("@/stores/conversation-runtime-store", () => ({
  getRuntimeSession: () => null,
}))

vi.mock("@/components/conversations/session-details-dialog", () => ({
  SessionDetailsDialog: () => null,
}))

vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationHeaderFolderPicker: () => <span data-testid="folder-picker" />,
}))

import { ComposerStatusStrips } from "@/components/chat/composer-status-strips"
import { ConversationDetailHeader } from "@/components/conversations/conversation-detail-header"
import { PluginComposerPills } from "./plugin-composer-actions"

const MESSAGES = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} as const

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeRichComposerPlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "codeg.composer-pills",
      name: "Composer Review",
      nameTranslations: { "zh-CN": "编辑器审查" },
      version: "1.0.0",
      server: {
        entry: "pills.mjs",
        methods: ["review-checklist", "review-status"],
      },
      client: { entry: "surface.html" },
      contributes: {
        workspacePanels: [
          {
            id: "review-panel",
            title: "Review Panel",
            view: "text",
            text: "ok",
          },
        ],
        commands: [],
        hooks: [],
        clientSurfaces: [
          { id: "review-surface", title: "Review Surface", slot: "composer" },
        ],
        screens: [{ id: "review-screen", title: "Review Screen" }],
        composerPills: [
          {
            id: "review-menu",
            title: "Review tools",
            titleTranslations: { "zh-CN": "审查工具" },
            label: "Review",
            labelTranslations: { "zh-CN": "审查" },
            action: {
              kind: "menu",
              items: [
                {
                  id: "test-plan",
                  title: "Insert a test plan",
                  action: {
                    kind: "insertText",
                    text: "Propose a test plan for these changes.",
                  },
                },
                {
                  id: "checklist",
                  title: "Insert a review checklist",
                  action: {
                    kind: "callMethod",
                    method: "review-checklist",
                  },
                },
              ],
            },
          },
          {
            id: "open-panel",
            title: "Open Panel",
            action: { kind: "openWorkspacePanel", panelId: "review-panel" },
          },
          {
            id: "open-screen",
            title: "Open Screen",
            action: { kind: "openScreen", screenId: "review-screen" },
          },
          {
            id: "open-surface",
            title: "Open Surface",
            action: { kind: "openClientSurface", surfaceId: "review-surface" },
          },
        ],
        sessionActions: [
          {
            id: "review-session",
            title: "Review this session",
            titleTranslations: { "zh-CN": "审查此会话" },
            action: { kind: "callMethod", method: "review-checklist" },
          },
          {
            id: "session-surface",
            title: "Inspect in surface",
            action: { kind: "openClientSurface", surfaceId: "review-surface" },
          },
        ],
        inputActivities: [
          {
            id: "review-available",
            title: "Review checklist",
            method: "review-status",
          },
        ],
      },
    },
  }
}

function createMockTransport(options?: {
  plugins?: InstalledPlugin[]
  onCall?: (params: {
    pluginId: string
    method: string
    input: Record<string, unknown>
  }) => unknown | Promise<unknown>
}) {
  let plugins = options?.plugins ?? []
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: Array<{ method: string; params: unknown }> = []

  const transport: Transport = {
    isDesktop: () => false,
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "host_plugins_list") return plugins
      if (method === "host_plugins_client_html") {
        return "<article>Review Surface</article>"
      }
      if (method === "host_plugins_call" && options?.onCall) {
        return options.onCall(
          params as {
            pluginId: string
            method: string
            input: Record<string, unknown>
          }
        )
      }
      return null
    }) as Transport["call"],
    subscribe: vi.fn(async (event: string, cb: (payload: unknown) => void) => {
      const set = subscribers.get(event) ?? new Set()
      set.add(cb)
      subscribers.set(event, set)
      return () => {
        set.delete(cb)
      }
    }) as Transport["subscribe"],
  }

  return {
    transport,
    calls,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const cb of subscribers.get("host-plugins://changed") ?? []) {
        cb(undefined)
      }
    },
  }
}

function notifyTransportChange() {
  for (const listener of h.transportListeners) {
    listener()
  }
}

function renderWithIntl(
  ui: ReactElement,
  locale: keyof typeof MESSAGES = "en"
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      {ui}
    </NextIntlClientProvider>
  )
}

const SESSION_CTX: HostPluginSessionContext = {
  folderId: 7,
  conversationId: 42,
  sessionKey: "tab-42",
}

describe("PluginComposerPills, PluginInputActivitiesStrip & SessionActions", () => {
  beforeEach(() => {
    h.transport = null
    h.activeRemoteConnectionId = null
    h.transportListeners.clear()
    h.isMobile = false
    window.history.replaceState({}, "", "/")
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it("renders zero DOM during remote boot gating and executes all composer pill actions + withdraws on disable", async () => {
    // 1. Remote boot gating: ?remoteConnectionId=8 while activeRemoteConnectionId === null
    window.history.replaceState({}, "", "/?remoteConnectionId=8")
    h.activeRemoteConnectionId = null
    const localMock = createMockTransport({
      plugins: [makeRichComposerPlugin(true)],
    })
    h.transport = localMock.transport
    const onInsert = vi.fn((text: string) => ({
      inserted: true as const,
      length: text.length,
    }))
    const user = userEvent.setup()

    const { container } = renderWithIntl(
      <PluginComposerPills
        sessionContext={SESSION_CTX}
        onComposerInsertText={onInsert}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(localMock.calls).toHaveLength(0)
    expect(container.firstChild).toBeNull()

    // 2. Activate remote transport
    const methodDeferred = createDeferred<unknown>()
    const callInputs: unknown[] = []
    const remoteMock = createMockTransport({
      plugins: [makeRichComposerPlugin(true)],
      onCall: ({ method, input }) => {
        callInputs.push({ method, input })
        return methodDeferred.promise
      },
    })
    h.activeRemoteConnectionId = 8
    h.transport = remoteMock.transport
    act(() => {
      notifyTransportChange()
    })

    // Menu pill shows `label` ("Review") with accessible name `title` ("Review tools")
    const menuTrigger = await screen.findByRole("button", {
      name: "Review tools",
    })
    expect(menuTrigger).toHaveTextContent("Review")

    // Menu -> insertText
    await user.click(menuTrigger)
    await user.click(await screen.findByText("Insert a test plan"))
    expect(onInsert).toHaveBeenCalledWith(
      "Propose a test plan for these changes.",
      "7:42:tab-42"
    )

    // Menu -> callMethod (sets busy while pending, then inserts + shows notice)
    await user.click(menuTrigger)
    await user.click(await screen.findByText("Insert a review checklist"))
    expect(menuTrigger).toBeDisabled()
    expect(callInputs).toEqual([
      {
        method: "review-checklist",
        input: {
          source: "composerPill",
          itemId: "review-menu",
          menuItemId: "checklist",
          scope: "session",
          folderId: 7,
          conversationId: 42,
          locale: "en",
        },
      },
    ])

    await act(async () => {
      methodDeferred.resolve({
        insertText: "- [ ] Review\r\n- [ ] Test",
        notice: "Checklist ready",
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(menuTrigger).not.toBeDisabled()
    })
    expect(onInsert).toHaveBeenLastCalledWith(
      "- [ ] Review\n- [ ] Test",
      "7:42:tab-42"
    )
    expect(h.toastInfo).toHaveBeenCalledWith("Checklist ready")

    // Leaf navigation actions: openWorkspacePanel, openScreen, openClientSurface
    await user.click(screen.getByRole("button", { name: "Open Panel" }))
    expect(h.openPluginPanel).toHaveBeenCalledWith(
      "codeg.composer-pills:review-panel"
    )

    await user.click(screen.getByRole("button", { name: "Open Screen" }))
    expect(h.openPluginScreen).toHaveBeenCalledWith({
      pluginId: "codeg.composer-pills",
      screenId: "review-screen",
    })

    await user.click(screen.getByRole("button", { name: "Open Surface" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    // Disabling plugin immediately withdraws both dialog and pills
    act(() => {
      remoteMock.setPlugins([makeRichComposerPlugin(false)])
    })
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("renders Input Activities via ComposerStatusStrips/ComposerDockStrip and cancels stale results on switch, disable, and transport replacement", async () => {
    const slowSession42 = createDeferred<unknown>()
    let mode: "visible" | "hidden" | "null" | "error" | "defer" = "visible"

    const mock1 = createMockTransport({
      plugins: [makeRichComposerPlugin(true)],
      onCall: ({ method, input }) => {
        if (method !== "review-status") return null
        if (mode === "defer") return slowSession42.promise
        if (mode === "hidden") {
          return { visible: false, title: "Hidden activity" }
        }
        if (mode === "null") return null
        if (mode === "error") throw new Error("boom")
        return {
          visible: true,
          tone: "warning",
          title: `Review available (${String(input.conversationId)})`,
          detail: "Expandable review guidance.",
        }
      },
    })
    h.transport = mock1.transport
    const user = userEvent.setup()

    const { rerender } = renderWithIntl(
      <ComposerStatusStrips
        status="connected"
        claudeApiRetry={null}
        pluginContext={SESSION_CTX}
      />
    )

    // Visible warning strip with expandable detail
    expect(await screen.findByText("Review available (42)")).toBeInTheDocument()
    const expandBtn = screen.getByRole("button", {
      name: enMessages.Folder.chat.sessionFailure.toggleDetails,
    })
    await user.click(expandBtn)
    expect(screen.getByText("Expandable review guidance.")).toBeInTheDocument()

    // Switch conversation -> immediately clears old strip; late stale response for 42 discarded
    mode = "defer"
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposerStatusStrips
          status="connected"
          claudeApiRetry={null}
          pluginContext={{
            folderId: 7,
            conversationId: 43,
            sessionKey: "tab-43",
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByText("Review available (42)")).not.toBeInTheDocument()

    // Replace Transport before slowSession42 resolves -> stale response ignored
    mode = "hidden"
    const mock2 = createMockTransport({
      plugins: [makeRichComposerPlugin(true)],
      onCall: () => ({ visible: false, title: "Should stay hidden" }),
    })
    h.transport = mock2.transport
    act(() => {
      notifyTransportChange()
    })

    await act(async () => {
      slowSession42.resolve({
        visible: true,
        tone: "muted",
        title: "Stale 42 strip",
      })
      await Promise.resolve()
    })
    expect(screen.queryByText("Stale 42 strip")).not.toBeInTheDocument()
    expect(screen.queryByText("Should stay hidden")).not.toBeInTheDocument()

    // Throwing/erroring activity stays hidden silently
    const mock3 = createMockTransport({
      plugins: [makeRichComposerPlugin(true)],
      onCall: () => {
        throw new Error("rpc failure")
      },
    })
    h.transport = mock3.transport
    act(() => {
      notifyTransportChange()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      document.querySelector('[data-slot="plugin-input-activities"]')
    ).toBeNull()
  })

  it("integrates Session Context Actions into ConversationDetailHeader menu (scoping, callMethod append + notice, and surface dialog)", async () => {
    const appended: AppendTextToSessionDetail[] = []
    const onAppend = (event: Event) => {
      appended.push((event as CustomEvent<AppendTextToSessionDetail>).detail)
    }
    window.addEventListener(APPEND_TEXT_TO_SESSION_EVENT, onAppend)

    try {
      const mock = createMockTransport({
        plugins: [makeRichComposerPlugin(true)],
        onCall: ({ method, input }) => {
          if (method === "review-checklist") {
            expect(input).toEqual({
              source: "sessionAction",
              itemId: "review-session",
              scope: "session",
              folderId: 7,
              conversationId: 42,
              locale: "en",
            })
            return {
              insertText: "- [ ] Session check",
              notice: "Checklist inserted into the draft.",
            }
          }
          return {}
        },
      })
      h.transport = mock.transport
      const user = userEvent.setup()

      const { rerender } = renderWithIntl(
        <ConversationDetailHeader
          tabId="tab-draft"
          title="Draft"
          conversationId={null}
          runtimeConversationId={-1}
          folderId={7}
          folderPath="/repo/a"
          status="in_progress"
        />
      )

      // Draft scope: session-only actions are hidden
      await user.click(
        screen.getByRole("button", {
          name: enMessages.Folder.conversation.moreActions,
        })
      )
      expect(screen.queryByText("Review this session")).not.toBeInTheDocument()
      await user.keyboard("{Escape}")

      // Saved session scope: sessionActions appear and work even after dropdown closes
      rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ConversationDetailHeader
            tabId="tab-42"
            title="Saved Session"
            conversationId={42}
            runtimeConversationId={42}
            folderId={7}
            folderPath="/repo/a"
            status="in_progress"
          />
        </NextIntlClientProvider>
      )

      await user.click(
        screen.getByRole("button", {
          name: enMessages.Folder.conversation.moreActions,
        })
      )
      await user.click(await screen.findByText("Review this session"))

      await waitFor(() => {
        expect(appended).toEqual([
          { tabId: "tab-42", text: "- [ ] Session check" },
        ])
      })
      expect(h.toastInfo).toHaveBeenCalledWith(
        "Checklist inserted into the draft."
      )

      // openClientSurface from session menu opens dialog cleanly after dropdown closes
      await user.click(
        screen.getByRole("button", {
          name: enMessages.Folder.conversation.moreActions,
        })
      )
      await user.click(await screen.findByText("Inspect in surface"))
      expect(await screen.findByRole("dialog")).toBeInTheDocument()
    } finally {
      window.removeEventListener(APPEND_TEXT_TO_SESSION_EVENT, onAppend)
    }
  })
})

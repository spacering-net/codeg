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
import esMessages from "@/i18n/messages/es.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import type { PromptCapabilitiesInfo, PromptDraft } from "@/lib/types"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteConnectionId: null as number | null,
  transportListeners: new Set<() => void>(),
  isMobile: false,
  composerHandle: null as RichComposerHandle | null,
}))

vi.mock("./composer/rich-composer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/rich-composer")>()
  const React = await import("react")
  const Captured = React.forwardRef<
    RichComposerHandle,
    ComponentProps<typeof actual.RichComposer>
  >((props, ref) => {
    const assign = (handle: RichComposerHandle | null) => {
      h.composerHandle = handle
      if (typeof ref === "function") ref(handle)
      else if (ref) ref.current = handle
    }
    return React.createElement(actual.RichComposer, { ...props, ref: assign })
  })
  Captured.displayName = "CapturedRichComposer"
  return { ...actual, RichComposer: Captured }
})

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
  ConversationContextBar: ({
    hasExtraContent,
    extraContent,
  }: {
    hasExtraContent?: boolean
    extraContent?: React.ReactNode
  }) =>
    hasExtraContent ? (
      <div data-testid="composer-context-bar">{extraContent}</div>
    ) : null,
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: () => false,
}))
vi.mock("./composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("./composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
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

import { MessageInput } from "./message-input"

const CAPS: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

const MESSAGES_BY_LOCALE = {
  en: enMessages,
  es: esMessages,
  "zh-CN": zhCNMessages,
} as const

function makeIssuePlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "codeg.issue-attachments",
      name: "Issue Attachments",
      version: "1.0.0",
      server: { entry: "issues.mjs", methods: ["search-issues"] },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        attachmentSources: [
          {
            id: "example-issues",
            title: "Example Issues",
            titleTranslations: {
              es: "Incidencias de ejemplo",
              "zh-CN": "示例工单",
            },
            pickerTitle: "Attach an issue",
            pickerTitleTranslations: {
              es: "Adjuntar una incidencia",
              "zh-CN": "附加工单",
            },
            searchPlaceholder: "Search issues by ID or keyword",
            searchPlaceholderTranslations: {
              es: "Buscar por ID o palabra clave",
              "zh-CN": "按编号或关键词搜索工单",
            },
            method: "search-issues",
          },
        ],
      },
    },
  }
}

const DEMO_ISSUES = [
  {
    id: "issue-104",
    identifier: "DEMO-104",
    title: "Document the first-run workflow",
    subtitle: "Docs · Open",
    url: "https://example.com/issues/DEMO-104",
    text: "DEMO-104 · Document the first-run workflow\n\nAdd instructions for creating a workspace and opening a first session.",
    resourceType: "issue",
  },
  {
    id: "issue-108",
    identifier: "DEMO-108",
    title: "Show an empty state for archived workspaces",
    subtitle: "UI · In progress",
    url: "https://example.com/issues/DEMO-108",
    text: "DEMO-108 · Show an empty state for archived workspaces\n\nExplain how to restore a workspace when the archive is empty.",
    resourceType: "issue",
  },
]

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

function createMockTransport(options?: {
  plugins?: InstalledPlugin[]
  onPluginCall?: (payload: {
    pluginId: string
    method: string
    input: {
      query: string
      folderId: number | null
      conversationId: number | null
      locale: string
    }
  }) => unknown | Promise<unknown>
}) {
  let plugins = options?.plugins ?? []
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: Array<{ method: string; params: unknown }> = []

  const transport: Transport = {
    isDesktop: () => false,
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_call" && options?.onPluginCall) {
        return options.onPluginCall(
          params as {
            pluginId: string
            method: string
            input: {
              query: string
              folderId: number | null
              conversationId: number | null
              locale: string
            }
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
  locale: keyof typeof MESSAGES_BY_LOCALE = "en"
) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES_BY_LOCALE[locale]}
    >
      {ui}
    </NextIntlClientProvider>
  )
}

describe("Composer attachment sources integration", () => {
  beforeEach(() => {
    h.transport = null
    h.activeRemoteConnectionId = null
    h.transportListeners.clear()
    h.isMobile = false
    h.composerHandle = null
    window.history.replaceState({}, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("renders zero extra DOM when no enabled plugin attachment sources exist", async () => {
    const mock = createMockTransport({ plugins: [makeIssuePlugin(false)] })
    h.transport = mock.transport
    const user = userEvent.setup()

    renderWithIntl(
      <MessageInput
        onSend={vi.fn()}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: 7,
          conversationId: 42,
          sessionKey: "tab-empty",
        }}
      />
    )

    await waitFor(() => {
      expect(mock.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-source"]')
    ).toBeNull()
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-pill"]')
    ).toBeNull()
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-picker"]')
    ).toBeNull()
  })

  it("searches, localizes in zh-CN, attaches removable pill, submits full text snapshot, and clears on send", async () => {
    const searchInputs: unknown[] = []
    const mock = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: ({ input }) => {
        searchInputs.push(input)
        const q = input.query.trim().toLowerCase()
        return {
          items: q
            ? DEMO_ISSUES.filter((i) =>
                `${i.identifier} ${i.title}`.toLowerCase().includes(q)
              )
            : DEMO_ISSUES,
        }
      },
    })
    h.transport = mock.transport
    const onSend = vi.fn<(draft: PromptDraft, modeId?: string | null) => void>()
    const user = userEvent.setup()

    renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: 7,
          conversationId: 42,
          sessionKey: "tab-saved",
        }}
      />,
      "zh-CN"
    )

    await waitFor(() => {
      expect(mock.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    // Open "+" menu and click localized zh-CN source
    await user.click(screen.getByRole("button", { name: "添加" }))
    const sourceItem = await screen.findByRole("menuitem", { name: "示例工单" })
    await user.click(sourceItem)

    // Picker opens with localized title and placeholder, immediately searching with query: ""
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("附加工单")).toBeInTheDocument()
    const searchbox = within(dialog).getByRole("searchbox", {
      name: "按编号或关键词搜索工单",
    })
    await waitFor(() => {
      expect(searchInputs[0]).toEqual({
        query: "",
        folderId: 7,
        conversationId: 42,
        locale: "zh-CN",
      })
    })
    expect(
      await within(dialog).findByText("Document the first-run workflow")
    ).toBeInTheDocument()

    // Type search query -> debounced call filters results
    await user.type(searchbox, "DEMO-108")
    await waitFor(() => {
      expect(searchInputs).toContainEqual({
        query: "DEMO-108",
        folderId: 7,
        conversationId: 42,
        locale: "zh-CN",
      })
    })
    await waitFor(() => {
      expect(
        within(dialog).queryByText("Document the first-run workflow")
      ).not.toBeInTheDocument()
    })

    // Select item -> attaches pill and closes dialog
    await user.click(
      within(dialog).getByRole("button", {
        name: /DEMO-108.*Show an empty state for archived workspaces/i,
      })
    )
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    const pill = document.querySelector(
      '[data-slot="composer-plugin-attachment-pill"]'
    ) as HTMLElement
    expect(pill).not.toBeNull()
    expect(within(pill).getByText("DEMO-108")).toBeInTheDocument()
    expect(
      within(pill).getByText("Show an empty state for archived workspaces")
    ).toBeInTheDocument()

    // Also attach a second item and remove the first to verify pill removal
    await user.click(screen.getByRole("button", { name: "添加" }))
    await user.click(await screen.findByRole("menuitem", { name: "示例工单" }))
    const secondDialog = await screen.findByRole("dialog")
    await user.click(
      await within(secondDialog).findByRole("button", {
        name: /DEMO-104.*Document the first-run workflow/i,
      })
    )

    expect(
      document.querySelectorAll('[data-slot="composer-plugin-attachment-pill"]')
    ).toHaveLength(2)

    await user.click(
      screen.getByRole("button", {
        name: "移除 DEMO-108 · Show an empty state for archived workspaces",
      })
    )
    expect(
      document.querySelectorAll('[data-slot="composer-plugin-attachment-pill"]')
    ).toHaveLength(1)

    // Add prose and submit -> draft.blocks carries BOTH prose and full DEMO-104 snapshot
    act(() => {
      h.composerHandle?.setText("Please review this issue")
    })
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(onSend).toHaveBeenCalledTimes(1)
    const [submittedDraft] = onSend.mock.calls[0]
    expect(submittedDraft.displayText).toBe("Please review this issue")
    expect(submittedDraft.blocks).toEqual([
      { type: "text", text: "Please review this issue" },
      { type: "text", text: DEMO_ISSUES[0].text },
    ])

    // Pills cleared after send
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-pill"]')
    ).toBeNull()
  })

  it("supports attachment-only submission and works on 390px mobile + folderless chat", async () => {
    h.isMobile = true
    const searchInputs: unknown[] = []
    const mock = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: ({ input }) => {
        searchInputs.push(input)
        return { items: [DEMO_ISSUES[0]] }
      },
    })
    h.transport = mock.transport
    const onSend = vi.fn<(draft: PromptDraft, modeId?: string | null) => void>()
    const user = userEvent.setup()

    renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: null,
          conversationId: null,
          sessionKey: "chat-draft-1",
        }}
      />,
      "es"
    )

    await waitFor(() => {
      expect(mock.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    await user.click(screen.getByRole("button", { name: "Añadir" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Incidencias de ejemplo" })
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText("Adjuntar una incidencia")
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(searchInputs[0]).toEqual({
        query: "",
        folderId: null,
        conversationId: null,
        locale: "es",
      })
    })

    await user.click(
      await within(dialog).findByRole("button", {
        name: /DEMO-104/i,
      })
    )

    // Attachment-only send works without typing prose
    await user.click(screen.getByRole("button", { name: "Enviar" }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toEqual({
      displayText: "DEMO-104 · Document the first-run workflow",
      blocks: [{ type: "text", text: DEMO_ISSUES[0].text }],
    })
  })

  it("discards stale out-of-order search responses when a newer query resolves first", async () => {
    const firstRequest = createDeferred<{ items: typeof DEMO_ISSUES }>()
    const secondRequest = createDeferred<{ items: typeof DEMO_ISSUES }>()
    let callCount = 0

    const mock = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: () => {
        callCount += 1
        return callCount === 1 ? firstRequest.promise : secondRequest.promise
      },
    })
    h.transport = mock.transport
    const user = userEvent.setup()

    renderWithIntl(
      <MessageInput
        onSend={vi.fn()}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: 3,
          conversationId: null,
          sessionKey: "tab-race",
        }}
      />
    )

    await waitFor(() => {
      expect(mock.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    )
    const dialog = await screen.findByRole("dialog")
    const searchbox = within(dialog).getByRole("searchbox")

    await user.type(searchbox, "108")
    await waitFor(() => {
      expect(callCount).toBe(2)
    })

    // Second (newer) request resolves first with DEMO-108
    await act(async () => {
      secondRequest.resolve({ items: [DEMO_ISSUES[1]] })
      await Promise.resolve()
    })
    expect(await within(dialog).findByText("DEMO-108")).toBeInTheDocument()

    // First (stale) request resolves later with DEMO-104 -> MUST be discarded
    await act(async () => {
      firstRequest.resolve({ items: [DEMO_ISSUES[0]] })
      await Promise.resolve()
    })
    expect(within(dialog).getByText("DEMO-108")).toBeInTheDocument()
    expect(within(dialog).queryByText("DEMO-104")).not.toBeInTheDocument()
  })

  it("isolates draft pills across sessions and withdraws picker + stale results on session switch, plugin disable, and transport replacement", async () => {
    const pendingSearch = createDeferred<{ items: typeof DEMO_ISSUES }>()
    let deferNext = false

    const mock1 = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: () =>
        deferNext ? pendingSearch.promise : { items: [DEMO_ISSUES[0]] },
    })
    h.transport = mock1.transport
    const onSend = vi.fn()
    const user = userEvent.setup()

    const { rerender } = renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: 1,
          conversationId: 10,
          sessionKey: "tab-A",
        }}
      />
    )

    await waitFor(() => {
      expect(mock1.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    // Attach DEMO-104 to Session A
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    )
    const dialogA = await screen.findByRole("dialog")
    await user.click(
      await within(dialogA).findByRole("button", { name: /DEMO-104/i })
    )
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-pill"]')
    ).not.toBeNull()

    // Open picker again with a deferred search in Session A, then switch to Session B
    deferNext = true
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    )
    await screen.findByRole("dialog")

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPS}
          pluginContext={{
            folderId: 1,
            conversationId: 11,
            sessionKey: "tab-B",
          }}
        />
      </NextIntlClientProvider>
    )

    // Picker is immediately withdrawn and Session A's pill does NOT leak into Session B
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-pill"]')
    ).toBeNull()

    // Resolving the stale Session A search does not resurrect anything
    await act(async () => {
      pendingSearch.resolve({ items: [DEMO_ISSUES[1]] })
      await Promise.resolve()
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    // Open picker in Session B, then disable the plugin -> picker closes and menu hides source
    const disablePending = createDeferred<{ items: typeof DEMO_ISSUES }>()
    const mock2 = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: () => disablePending.promise,
    })
    window.history.replaceState({}, "", "/?remoteConnectionId=5")
    h.activeRemoteConnectionId = 5
    h.transport = mock2.transport
    act(() => {
      notifyTransportChange()
    })

    await waitFor(() => {
      expect(mock2.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    )
    await screen.findByRole("dialog")

    // Replace Transport under the SAME remoteConnectionId=5 -> picker must immediately withdraw
    const mock3 = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: () => ({ items: [DEMO_ISSUES[0]] }),
    })
    h.transport = mock3.transport
    act(() => {
      notifyTransportChange()
    })

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    // Resolve stale search from replaced transport -> must be discarded
    await act(async () => {
      disablePending.resolve({ items: [DEMO_ISSUES[1]] })
      await Promise.resolve()
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    // Open picker on mock3, then disable the plugin -> withdraws picker and menu entry
    await waitFor(() => {
      expect(mock3.calls.some((c) => c.method === "host_plugins_list")).toBe(
        true
      )
    })
    await user.click(screen.getByRole("button", { name: "Add" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    )
    await screen.findByRole("dialog")

    act(() => {
      mock3.setPlugins([makeIssuePlugin(false)])
    })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-source"]')
    ).toBeNull()
  })

  it("never queries local transport while ?remoteConnectionId=N is still booting", async () => {
    window.history.replaceState({}, "", "/?remoteConnectionId=9")
    h.activeRemoteConnectionId = null
    const localMock = createMockTransport({
      plugins: [makeIssuePlugin(true)],
    })
    h.transport = localMock.transport
    const user = userEvent.setup()

    renderWithIntl(
      <MessageInput
        onSend={vi.fn()}
        promptCapabilities={CAPS}
        pluginContext={{
          folderId: 2,
          conversationId: null,
          sessionKey: "remote-boot",
        }}
      />
    )

    // Give effects a tick; local transport must NOT be queried while remote is booting
    await act(async () => {
      await Promise.resolve()
    })
    expect(localMock.calls).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(
      document.querySelector('[data-slot="composer-plugin-attachment-source"]')
    ).toBeNull()
    await user.keyboard("{Escape}")

    // Once remoteConnectionId=9 becomes ready, remote transport is queried
    const remoteMock = createMockTransport({
      plugins: [makeIssuePlugin(true)],
      onPluginCall: () => ({ items: [DEMO_ISSUES[0]] }),
    })
    h.activeRemoteConnectionId = 9
    h.transport = remoteMock.transport
    act(() => {
      notifyTransportChange()
    })

    await waitFor(() => {
      expect(
        remoteMock.calls.some((c) => c.method === "host_plugins_list")
      ).toBe(true)
    })
    expect(localMock.calls).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(
      await screen.findByRole("menuitem", { name: "Example Issues" })
    ).toBeInTheDocument()
  })
})

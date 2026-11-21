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
import type { PromptCapabilitiesInfo } from "@/lib/types"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
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

import { ChatInput } from "./chat-input"

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
    get port() {
      return framePort!
    },
    sendInsertText(id: number, text: unknown) {
      framePort!.postMessage({
        id,
        operation: "composer",
        json: JSON.stringify({ type: "insertText", text }),
      })
    },
  }
}

const CAPS: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

function createMockTransport(initial: InstalledPlugin[]) {
  let plugins = initial
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const call = vi.fn(async (method: string) => {
    if (method === "host_plugins_list") return plugins
    if (method === "host_plugins_client_html") return "<p>composer-surface</p>"
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
    call,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const handler of listeners.get("host-plugins://changed") ?? []) {
        handler(null)
      }
    },
  }
}

function makeComposerPlugin(
  enabled = true,
  extraSurfaces: NonNullable<
    InstalledPlugin["manifest"]["contributes"]["clientSurfaces"]
  > = []
): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "acme.composer",
      name: "Prompt Helper",
      version: "1.0.0",
      client: { entry: "composer.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        clientSurfaces: [
          { id: "templates", title: "Templates", slot: "composer" },
          { id: "hdr", title: "Header Only", slot: "sessionHeader" },
          ...extraSurfaces,
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

async function waitForEditor() {
  await waitFor(() => {
    expect(h.composerHandle?.getEditor()).not.toBeNull()
  })
  return h.composerHandle!
}

describe("ChatInput / MessageInput composer plugin slot", () => {
  const originalMessageChannel = globalThis.MessageChannel

  beforeEach(() => {
    vi.clearAllMocks()
    h.isMobile = false
    h.composerHandle = null
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
  })

  afterEach(() => {
    cleanup()
    globalThis.MessageChannel = originalMessageChannel
    h.transport = null
    clearMessageInputDraftV2("draft-conv-42")
    clearMessageInputDraftV2("draft-conv-43")
    clearMessageInputDraftV2("draft-mobile")
    clearMessageInputDraftV2("draft-hidden")
  })

  it("renders composer plugin triggers, opens the iframe, and does not cancel queue edit on Escape", async () => {
    const mock = createMockTransport([makeComposerPlugin(true)])
    h.transport = mock.transport
    const onCancelQueueEdit = vi.fn()

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          isEditingQueueItem
          onCancelQueueEdit={onCancelQueueEdit}
          pluginContext={{
            folderId: 7,
            conversationId: 42,
            sessionKey: "tab-42",
          }}
        />
      )
    )

    const trigger = await screen.findByRole("button", { name: "Templates" })
    expect(screen.queryByRole("button", { name: "Header Only" })).toBeNull()

    await user.click(trigger)
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Templates")
    ).toBeInTheDocument()

    // Pressing Escape closes the plugin dialog without leaking to composer's queue-edit cancel
    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    expect(onCancelQueueEdit).not.toHaveBeenCalled()

    // Reopen, then switch conversation -> withdrawn
    await user.click(screen.getByRole("button", { name: "Templates" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Templates")
    ).toBeInTheDocument()

    rerender(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          isEditingQueueItem
          onCancelQueueEdit={onCancelQueueEdit}
          pluginContext={{
            folderId: 7,
            conversationId: 43,
            sessionKey: "tab-43",
          }}
        />
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()

    // Reopen, then disable plugin -> trigger & dialog withdrawn
    await user.click(screen.getByRole("button", { name: "Templates" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Templates")
    ).toBeInTheDocument()

    act(() => {
      mock.setPlugins([makeComposerPlugin(false)])
    })

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.queryByRole("button", { name: "Templates" })).toBeNull()
    })
  })

  it("inserts literal text at the active caret/selection, syncs draft storage, and never auto-sends", async () => {
    const mock = createMockTransport([makeComposerPlugin(true)])
    h.transport = mock.transport
    const onSend = vi.fn()

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-conv-42"
          pluginContext={{
            folderId: 7,
            conversationId: 42,
            sessionKey: "tab-42",
          }}
        />
      )
    )

    const composer = await waitForEditor()
    act(() => {
      composer.setText("hello world!")
      // Select "world" (positions 7..12 inside the paragraph starting at pos 1).
      composer.getEditor()!.commands.setTextSelection({ from: 7, to: 12 })
    })

    await user.click(await screen.findByRole("button", { name: "Templates" }))
    const dialog = await screen.findByRole("dialog")
    const iframe = (await within(dialog).findByTitle(
      "Templates"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session = connectIframe(iframe)

    // Replace selected word with multi-line literal text (including markdown/HTML lookalikes)
    await act(async () => {
      session.sendInsertText(
        1,
        "Codeg\r\n[not-a-file](file:///etc/passwd) <span data-reference>"
      )
    })

    await waitFor(() => {
      expect(session.received).toContainEqual({
        id: 1,
        ok: true,
        value: {
          inserted: true,
          length:
            "Codeg\n[not-a-file](file:///etc/passwd) <span data-reference>"
              .length,
        },
      })
    })

    expect(composer.getText()).toBe(
      "hello Codeg\n[not-a-file](file:///etc/passwd) <span data-reference>!"
    )
    // Must stay literal text (no hydrated reference badge nodes from untrusted plugin input).
    let referenceNodeCount = 0
    composer.getEditor()!.state.doc.descendants((node) => {
      if (node.type.name === "reference") referenceNodeCount += 1
      return true
    })
    expect(referenceNodeCount).toBe(0)

    // Never auto-sends.
    expect(onSend).not.toHaveBeenCalled()

    // Draft storage synced via the standard v2 draft path.
    const saved = loadMessageInputDraftV2("draft-conv-42")
    expect(saved?.kind).toBe("doc")
    expect(JSON.stringify(saved)).toContain("Codeg")

    // Reject oversized text without mutating editor or draft.
    await act(async () => {
      session.sendInsertText(2, "z".repeat(16 * 1024 + 1))
    })
    await waitFor(() => {
      expect(session.received).toContainEqual({
        id: 2,
        ok: false,
        error: "Composer text exceeds 16 KiB limit",
      })
    })
    expect(composer.getText()).toBe(
      "hello Codeg\n[not-a-file](file:///etc/passwd) <span data-reference>!"
    )
  })

  it("blocks stale iframe insertions when switching conversations in the same workspace, hiding a tab, or disabling a plugin", async () => {
    const mock = createMockTransport([makeComposerPlugin(true)])
    h.transport = mock.transport
    const onSend = vi.fn()

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-conv-42"
          pluginContext={{
            folderId: 7,
            conversationId: 42,
            sessionKey: "tab-42",
          }}
        />
      )
    )

    const composer = await waitForEditor()
    act(() => {
      composer.setText("conv-42 draft")
    })

    await user.click(await screen.findByRole("button", { name: "Templates" }))
    const dialog1 = await screen.findByRole("dialog")
    const iframe1 = (await within(dialog1).findByTitle(
      "Templates"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session1 = connectIframe(iframe1)

    // 1) Switch to another conversation in the SAME workspace (folderId: 7)
    rerender(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-conv-43"
          pluginContext={{
            folderId: 7,
            conversationId: 43,
            sessionKey: "tab-43",
          }}
        />
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => {
      composer.setText("conv-43 draft")
    })
    await waitFor(() => {
      expect(loadMessageInputDraftV2("draft-conv-43")).not.toBeNull()
    })
    const conv43BaselineDraft = loadMessageInputDraftV2("draft-conv-43")
    // Stale frame attempts to write after conversation switch -> must NOT touch conv-43 draft
    act(() => {
      session1.sendInsertText(1, "STALE_CONV_42")
    })
    expect(composer.getText()).toBe("conv-43 draft")
    expect(loadMessageInputDraftV2("draft-conv-43")).toEqual(
      conv43BaselineDraft
    )

    // 2) Reopen in conv-43, then hide keep-alive tab (pluginSlotEnabled -> false)
    await user.click(screen.getByRole("button", { name: "Templates" }))
    const dialog2 = await screen.findByRole("dialog")
    const iframe2 = (await within(dialog2).findByTitle(
      "Templates"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session2 = connectIframe(iframe2)

    rerender(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-hidden"
          pluginSlotEnabled={false}
          pluginContext={{
            folderId: 7,
            conversationId: 43,
            sessionKey: "tab-43",
          }}
        />
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => {
      session2.sendInsertText(2, "STALE_HIDDEN")
    })
    expect(composer.getText()).toBe("conv-43 draft")

    // 3) Show tab again, reopen, then disable the plugin via catalog update
    rerender(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-conv-43"
          pluginSlotEnabled
          pluginContext={{
            folderId: 7,
            conversationId: 43,
            sessionKey: "tab-43",
          }}
        />
      )
    )
    await user.click(await screen.findByRole("button", { name: "Templates" }))
    const dialog3 = await screen.findByRole("dialog")
    const iframe3 = (await within(dialog3).findByTitle(
      "Templates"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session3 = connectIframe(iframe3)

    act(() => {
      mock.setPlugins([makeComposerPlugin(false)])
    })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    act(() => {
      session3.sendInsertText(3, "STALE_DISABLED")
    })
    expect(composer.getText()).toBe("conv-43 draft")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("skips plugin queries when pluginSlotEnabled is false for hidden keep-alive tabs", () => {
    const mock = createMockTransport([makeComposerPlugin(true)])
    h.transport = mock.transport

    render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          pluginContext={{
            folderId: 7,
            conversationId: 42,
            sessionKey: "tab-hidden",
          }}
          pluginSlotEnabled={false}
        />
      )
    )

    expect(mock.call).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Templates" })).toBeNull()
  })

  it("supports controlled draft insertion from compact triggers and overflow menus on narrow mobile viewports", async () => {
    h.isMobile = true
    const mock = createMockTransport([
      makeComposerPlugin(true, [
        { id: "snippets", title: "Snippets", slot: "composer" },
      ]),
    ])
    h.transport = mock.transport
    const onSend = vi.fn()

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={onSend}
          onCancel={vi.fn()}
          draftStorageKey="draft-mobile"
          pluginContext={{
            folderId: 7,
            conversationId: null,
            sessionKey: "draft-mobile",
          }}
        />
      )
    )

    const composer = await waitForEditor()
    const menuTrigger = await screen.findByRole("button", {
      name: "Plugin actions",
    })
    expect(menuTrigger.textContent).toBe("")

    await user.click(menuTrigger)
    await user.click(await screen.findByRole("menuitem", { name: /Snippets/ }))

    const dialog = await screen.findByRole("dialog")
    const iframe = (await within(dialog).findByTitle(
      "Snippets"
    )) as HTMLIFrameElement
    await act(async () => {})
    const session = connectIframe(iframe)

    await act(async () => {
      session.sendInsertText(1, "mobile snippet")
    })

    await waitFor(() => {
      expect(session.received).toContainEqual({
        id: 1,
        ok: true,
        value: { inserted: true, length: "mobile snippet".length },
      })
    })
    expect(composer.getText()).toBe("mobile snippet")
    expect(onSend).not.toHaveBeenCalled()
  })
})

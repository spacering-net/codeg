import { type ReactElement } from "react"
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
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import type { PromptCapabilitiesInfo } from "@/lib/types"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  isMobile: false,
}))

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

function makeComposerPlugin(enabled = true): InstalledPlugin {
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

describe("ChatInput / MessageInput composer plugin slot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.isMobile = false
  })

  afterEach(() => {
    cleanup()
    h.transport = null
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

  it("renders compact icon triggers in the composer on narrow mobile viewports", async () => {
    h.isMobile = true
    const mock = createMockTransport([makeComposerPlugin(true)])
    h.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <ChatInput
          status="connected"
          promptCapabilities={CAPS}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          pluginContext={{
            folderId: 7,
            conversationId: null,
            sessionKey: "draft-mobile",
          }}
        />
      )
    )

    const trigger = await screen.findByRole("button", { name: "Templates" })
    expect(trigger.textContent).toBe("")

    await user.click(trigger)
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Templates")
    ).toBeInTheDocument()
  })
})

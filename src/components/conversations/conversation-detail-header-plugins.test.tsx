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
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  isMobile: false,
  allFolders: [
    { id: 1, name: "repo-a", alias: null, parent_id: null, kind: "regular" },
    { id: 2, name: "repo-b", alias: null, parent_id: null, kind: "regular" },
    { id: 9, name: "Chat", alias: null, parent_id: null, kind: "chat" },
  ],
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
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
    allFolders: h.allFolders,
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/stores/conversation-runtime-store", () => ({
  getRuntimeSession: () => null,
}))
vi.mock("./session-details-dialog", () => ({
  SessionDetailsDialog: () => null,
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationHeaderFolderPicker: () => <span data-testid="folder-picker" />,
}))

import { ConversationDetailHeader } from "./conversation-detail-header"

type Props = ComponentProps<typeof ConversationDetailHeader>

function createMockTransport(initial: InstalledPlugin[]) {
  let plugins = initial
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const call = vi.fn(async (method: string) => {
    if (method === "host_plugins_list") return plugins
    if (method === "host_plugins_client_html") return "<p>header-surface</p>"
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

function makeHeaderPlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "acme.header",
      name: "Header Inspector",
      version: "1.0.0",
      client: { entry: "header.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        clientSurfaces: [
          { id: "inspect", title: "Inspect Session", slot: "sessionHeader" },
          { id: "compose", title: "Composer Only", slot: "composer" },
        ],
      },
    },
  }
}

const TAB_A: Props = {
  tabId: "tab-a",
  conversationId: 10,
  runtimeConversationId: null,
  folderId: 1,
  folderPath: "/repo-a",
  title: "Conversation A",
  status: "in_progress",
}

const TAB_B: Props = {
  tabId: "tab-b",
  conversationId: 20,
  runtimeConversationId: null,
  folderId: 2,
  folderPath: "/repo-b",
  title: "Conversation B",
  status: "in_progress",
}

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("ConversationDetailHeader sessionHeader plugin slot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.isMobile = false
  })

  afterEach(() => {
    cleanup()
    h.transport = null
  })

  it("mounts sessionHeader plugin buttons in the real header and withdraws on tab switch or disable", async () => {
    const mock = createMockTransport([makeHeaderPlugin(true)])
    h.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(<ConversationDetailHeader {...TAB_A} />)
    )

    const button = await screen.findByRole("button", {
      name: "Inspect Session",
    })
    expect(screen.queryByRole("button", { name: "Composer Only" })).toBeNull()

    await user.click(button)
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Inspect Session"
      )
    ).toBeInTheDocument()

    // Switching to another tab/workspace closes the open plugin dialog
    rerender(withIntl(<ConversationDetailHeader {...TAB_B} />))
    expect(screen.queryByRole("dialog")).toBeNull()

    // Reopen in tab B, then disable plugin -> button and dialog both withdraw
    await user.click(screen.getByRole("button", { name: "Inspect Session" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Inspect Session"
      )
    ).toBeInTheDocument()

    act(() => {
      mock.setPlugins([makeHeaderPlugin(false)])
    })

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(
        screen.queryByRole("button", { name: "Inspect Session" })
      ).toBeNull()
    })
  })

  it("keeps the header compact on narrow mobile viewports", async () => {
    h.isMobile = true
    const mock = createMockTransport([makeHeaderPlugin(true)])
    h.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(withIntl(<ConversationDetailHeader {...TAB_A} />))

    const button = await screen.findByRole("button", {
      name: "Inspect Session",
    })
    expect(button.textContent).toBe("")
    expect(screen.getByText("Conversation A")).toBeInTheDocument()

    await user.click(button)
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Inspect Session"
      )
    ).toBeInTheDocument()
  })

  it("isolates folderless chat-mode header sessions from workspace folders", async () => {
    const mock = createMockTransport([makeHeaderPlugin(true)])
    h.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <ConversationDetailHeader
          {...TAB_A}
          tabId="chat-tab"
          folderId={9}
          folderPath="/chat-scratch"
          conversationId={55}
        />
      )
    )

    await user.click(
      await screen.findByRole("button", { name: "Inspect Session" })
    )
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Inspect Session"
      )
    ).toBeInTheDocument()

    // Switching from chat-mode session to a regular workspace session withdraws the open dialog
    rerender(withIntl(<ConversationDetailHeader {...TAB_A} />))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

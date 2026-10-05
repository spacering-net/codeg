import { type ComponentProps, type ReactElement } from "react"
import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi, beforeEach } from "vitest"

import enMessages from "@/i18n/messages/en.json"

// The header is a SINGLE instance reused across active tabs, and the global
// tab-switch / close-tab shortcuts still fire while a rename/delete dialog is
// open. These tests pin the regression Codex flagged: a confirm must act on the
// conversation the dialog was OPENED for, not whatever is active at confirm
// time. We open the dialog for A, rerender the same instance as B (simulating a
// mid-dialog tab switch), then confirm — and assert A is mutated, never B.
const h = vi.hoisted(() => ({
  updateConversationTitle: vi.fn(async () => {}),
  deleteConversation: vi.fn(async () => {}),
  updateConversationStatus: vi.fn(async () => {}),
  updateConversationPinned: vi.fn(async () => {}),
  closeTab: vi.fn(),
  openNewConversationTab: vi.fn(),
  updateConversationLocal: vi.fn(),
  refreshConversations: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  updateConversationTitle: h.updateConversationTitle,
  deleteConversation: h.deleteConversation,
  updateConversationStatus: h.updateConversationStatus,
  updateConversationPinned: h.updateConversationPinned,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    closeTab: h.closeTab,
    openNewConversationTab: h.openNewConversationTab,
  }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    updateConversationLocal: h.updateConversationLocal,
    refreshConversations: h.refreshConversations,
    conversations: [] as unknown[],
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
// The header now embeds the folder picker (self-contained, store-driven); stub
// it so these tests exercise only the header's own menu/dialog logic.
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationHeaderFolderPicker: () => null,
}))
vi.mock("./session-quota-chip", () => ({
  SessionQuotaChip: () => null,
}))

import { ConversationDetailHeader } from "./conversation-detail-header"

type Props = ComponentProps<typeof ConversationDetailHeader>

const A: Props = {
  tabId: "tab-a",
  conversationId: 1,
  runtimeConversationId: null,
  folderId: 1,
  folderPath: "/a",
  title: "conv-a",
  status: "in_progress",
  agentType: "claude_code",
}
const B: Props = {
  ...A,
  tabId: "tab-b",
  conversationId: 2,
  title: "conv-b",
}

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("ConversationDetailHeader dialog target snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("deletes the conversation the dialog was opened for, even after the active tab switches", async () => {
    // pointerEventsCheck off: Radix toggles body pointer-events while a menu is
    // open, which user-event's default guard would trip on in jsdom.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender, getByLabelText, getByRole } = render(
      withIntl(<ConversationDetailHeader {...A} />)
    )

    await user.click(getByLabelText("More actions"))
    await user.click(getByRole("menuitem", { name: "Delete" }))

    // Simulate a mid-dialog tab switch: same header instance, now scoped to B.
    rerender(withIntl(<ConversationDetailHeader {...B} />))

    await user.click(getByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(h.deleteConversation).toHaveBeenCalledWith(1)
      // `recordForReopen: false`: the row is deleted, so "reopen closed tab"
      // must not be able to mint a tab pointing back at it.
      expect(h.closeTab).toHaveBeenCalledWith("tab-a", {
        recordForReopen: false,
      })
    })
    expect(h.deleteConversation).not.toHaveBeenCalledWith(2)
    expect(h.closeTab).not.toHaveBeenCalledWith("tab-b", expect.anything())
  })

  it("renames the conversation the dialog was opened for, even after the active tab switches", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender, getByLabelText, getByRole } = render(
      withIntl(<ConversationDetailHeader {...A} />)
    )

    await user.click(getByLabelText("More actions"))
    await user.click(getByRole("menuitem", { name: "Rename" }))

    rerender(withIntl(<ConversationDetailHeader {...B} />))

    const input = getByRole("textbox")
    await user.clear(input)
    await user.type(input, "renamed")
    await user.click(getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(h.updateConversationTitle).toHaveBeenCalledWith(1, "renamed")
    })
    expect(h.updateConversationTitle).not.toHaveBeenCalledWith(2, "renamed")
  })
})

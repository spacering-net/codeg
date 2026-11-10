import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FolderDetail } from "@/lib/types"
import { FolderTabsEmptyState } from "./folder-tabs-empty-state"

const h = vi.hoisted(() => ({
  activeFolder: null as Partial<FolderDetail> | null,
  openNewConversationTab: vi.fn(),
  openChatModeTab: vi.fn(),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: h.activeFolder }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: h.openNewConversationTab,
    openChatModeTab: h.openChatModeTab,
  }),
}))

function renderEmpty() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FolderTabsEmptyState />
    </NextIntlClientProvider>
  )
}

describe("FolderTabsEmptyState", () => {
  beforeEach(() => {
    h.openNewConversationTab.mockClear()
    h.openChatModeTab.mockClear()
  })

  it("names the selected folder and starts a conversation in it", () => {
    h.activeFolder = {
      id: 3,
      path: "/repo3",
      name: "repo3",
      alias: "Web",
      kind: "regular",
    }
    renderEmpty()
    expect(
      screen.getByText("No open conversations in Web [ repo3 ]")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New Conversation" }))
    expect(h.openNewConversationTab).toHaveBeenCalledWith(3, "/repo3")
    expect(h.openChatModeTab).not.toHaveBeenCalled()
  })

  it("offers a new chat for the chat scope, which has no folder", () => {
    h.activeFolder = null
    renderEmpty()
    expect(screen.getByText("No open chats")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(h.openChatModeTab).toHaveBeenCalledTimes(1)
    expect(h.openNewConversationTab).not.toHaveBeenCalled()
  })
})

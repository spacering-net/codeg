import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem } from "@/stores/tab-store"

const h = vi.hoisted(() => ({
  tabs: [] as TabItem[],
  activeTabId: "tab-1" as string | null,
  switchTab: vi.fn(),
  openConversations: vi.fn(),
  allFolders: [] as { id: number; name: string }[],
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: <T,>(
    selector: (state: { tabs: TabItem[]; activeTabId: string | null }) => T
  ) => selector({ tabs: h.tabs, activeTabId: h.activeTabId }),
  useTabActions: () => ({ switchTab: h.switchTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: h.openConversations }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: <T,>(
    selector: (state: { allFolders: { id: number; name: string }[] }) => T
  ) => selector({ allFolders: h.allFolders }),
}))

import { MobileTabSwitcher } from "./mobile-tab-switcher"

function tab(
  id: string,
  title: string,
  overrides: Partial<TabItem> = {}
): TabItem {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId: 1,
    agentType: "claude_code",
    title,
    isPinned: false,
    ...overrides,
  }
}

function renderSwitcher() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MobileTabSwitcher />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.tabs = [
    tab("tab-1", "First conversation"),
    tab("tab-2", "Second conversation", { status: "in_progress" }),
  ]
  h.activeTabId = "tab-1"
  h.allFolders = [{ id: 1, name: "codeg" }]
  h.switchTab.mockClear()
  h.openConversations.mockClear()
})

describe("MobileTabSwitcher", () => {
  it("lists open tabs with folder names and marks the active one", async () => {
    renderSwitcher()
    await userEvent.click(screen.getByRole("button", { name: "Open tabs" }))

    expect(await screen.findAllByRole("menuitem")).toHaveLength(2)
    expect(
      screen.getByRole("menuitem", { name: /First conversation/ })
    ).toHaveAttribute("aria-current", "true")
    expect(
      screen.getByRole("menuitem", { name: /Second conversation/ })
    ).not.toHaveAttribute("aria-current")
    expect(screen.getAllByText("codeg")).toHaveLength(2)
  })

  it("switches to the chosen tab after returning to the conversation workspace", async () => {
    renderSwitcher()
    await userEvent.click(screen.getByRole("button", { name: "Open tabs" }))
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Second conversation/ })
    )

    expect(h.openConversations).toHaveBeenCalledTimes(1)
    expect(h.switchTab).toHaveBeenCalledWith("tab-2")
  })

  it("disables the trigger when no tab is open", () => {
    h.tabs = []
    renderSwitcher()

    expect(screen.getByRole("button", { name: "Open tabs" })).toBeDisabled()
  })
})

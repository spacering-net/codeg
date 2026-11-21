import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"

const scene = vi.hoisted(() => ({
  isOpen: false,
  restored: true,
  activeTab: "session_details" as AuxPanelTab,
  folderId: 1 as number | null,
  chatMode: false,
  isConversations: true,
  /** The forge the project's remote resolves to. */
  provider: null as "github" | "gitlab" | "gitea" | null,
  /** Every folder the label lookup asked the forge about, in order. */
  providerAsked: [] as (number | null)[],
}))
const openTab = vi.hoisted(() => vi.fn())

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: scene.isOpen,
    restored: scene.restored,
    activeTab: scene.activeTab,
    openTab,
  }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolderId: scene.folderId }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ isConversations: scene.isConversations }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => scene.chatMode,
}))
// The active folder is its own project here: no worktrees in this scene.
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.folderId,
}))
vi.mock("@/lib/forge-provider-cache", () => ({
  useFolderForgeProvider: (folderId: number | null) => {
    scene.providerAsked.push(folderId)
    return folderId == null ? null : scene.provider
  },
}))

import enMessages from "@/i18n/messages/en.json"
import { NextIntlClientProvider } from "next-intl"
import { resetAuxTabOrderCacheForTests } from "@/lib/aux-panel-tab-order"

import { AuxPanelCollapsedRail } from "./aux-panel-collapsed-rail"

const KEY = "workspace:right-sidebar-tab-order"

/** The fold in the built-in order, by name. */
const BUILT_IN = [
  "Session Details",
  "Files",
  "Changes",
  "Commits",
  "Automations",
  "To-dos",
  "Issues",
  "Pull requests",
]

function renderFold() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AuxPanelCollapsedRail />
    </NextIntlClientProvider>
  )
}

/** The fold's buttons, top to bottom, by name. */
function foldTabs(): string[] {
  const el = document.querySelector<HTMLElement>("[data-aux-collapsed-rail]")
  if (!el) throw new Error("no collapsed rail rendered")
  return Array.from(el.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? ""
  )
}

describe("AuxPanelCollapsedRail", () => {
  beforeEach(() => {
    localStorage.clear()
    resetAuxTabOrderCacheForTests()
    Object.assign(scene, {
      isOpen: false,
      restored: true,
      activeTab: "session_details",
      folderId: 1,
      chatMode: false,
      isConversations: true,
      provider: null,
      providerAsked: [],
    })
    openTab.mockReset()
  })

  it("lists every tab while the panel is closed", () => {
    renderFold()
    expect(foldTabs()).toEqual(BUILT_IN)
    expect(
      document.querySelector("[data-aux-collapsed-rail]")
    ).toBeInTheDocument()
  })

  it("opens the panel on the pressed tab", async () => {
    const user = userEvent.setup()
    renderFold()
    await user.click(screen.getByRole("button", { name: "Files" }))
    expect(openTab).toHaveBeenCalledWith("file_tree")
  })

  it("follows the stored order", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        "tasks",
        "file_tree",
        "session_details",
        "issues",
        "git_log",
        "changes",
        "pull_requests",
        "automations",
      ])
    )
    renderFold()
    expect(foldTabs()).toEqual([
      "To-dos",
      "Files",
      "Session Details",
      "Issues",
      "Commits",
      "Changes",
      "Pull requests",
      "Automations",
    ])
  })

  it("renders nothing while the panel is open", () => {
    scene.isOpen = true
    const { container } = renderFold()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing before the persisted state is restored", () => {
    scene.restored = false
    const { container } = renderFold()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing in chat mode", () => {
    scene.chatMode = true
    const { container } = renderFold()
    expect(container).toBeEmptyDOMElement()
    // The lone Session Details tab needs no switcher, so no forge lookup.
    expect(scene.providerAsked.every((id) => id == null)).toBe(true)
  })

  it("renders nothing with no folder open", () => {
    scene.folderId = null
    const { container } = renderFold()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing while a full-page route covers the workspace", () => {
    scene.isConversations = false
    const { container } = renderFold()
    expect(container).toBeEmptyDOMElement()
  })

  it("names the change-request tab after the project's forge", () => {
    scene.provider = "gitlab"
    renderFold()
    expect(foldTabs()).toContain("Merge requests")
    expect(foldTabs()).not.toContain("Pull requests")
    // Asked about the project the fold is showing.
    expect(scene.providerAsked).toContain(1)
  })
})

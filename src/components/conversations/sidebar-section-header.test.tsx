import { type ReactElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { SidebarSectionHeader } from "./sidebar-section-header"
import enMessages from "@/i18n/messages/en.json"

// The hover-reveal action buttons carry only an aria-label (icon, no text), so
// getByLabelText addresses them unambiguously. CSS hides them until hover, but
// fireEvent dispatches directly on the node regardless of pointer-events, so the
// wiring is testable without a real pointer.
const onToggle = vi.fn()
const onNewChat = vi.fn()
const onOpenFolder = vi.fn()
const onCloneRepository = vi.fn()
const onNewFolderGroup = vi.fn()

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  onToggle.mockClear()
  onNewChat.mockClear()
  onOpenFolder.mockClear()
  onCloneRepository.mockClear()
  onNewFolderGroup.mockClear()
})

describe("SidebarSectionHeader folders-section actions", () => {
  it("renders Open Folder and Clone Repository buttons on the folders section", () => {
    const { getByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="folders"
        expanded
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
      />
    )
    expect(getByLabelText("Open Folder")).not.toBeNull()
    expect(getByLabelText("Clone Repository")).not.toBeNull()
  })

  it("invokes the matching handler without toggling the section", () => {
    const { getByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="folders"
        expanded
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
      />
    )

    fireEvent.click(getByLabelText("Open Folder"))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)

    fireEvent.click(getByLabelText("Clone Repository"))
    expect(onCloneRepository).toHaveBeenCalledTimes(1)

    // The actions are siblings of the toggle button (never nested), so clicking
    // them never collapses/expands the section.
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("renders only the actions whose callbacks are provided", () => {
    const { getByLabelText, queryByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="folders"
        expanded
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
      />
    )
    expect(getByLabelText("Open Folder")).not.toBeNull()
    expect(queryByLabelText("Clone Repository")).toBeNull()
  })

  it("renders New group alongside the three add-a-folder actions", () => {
    const { getByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="folders"
        expanded
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
        onNewFolderGroup={onNewFolderGroup}
      />
    )
    // Four hover actions now share this cluster; the sidebar's 300px minimum
    // leaves room, but all four must actually be present and addressable.
    expect(getByLabelText("New group")).not.toBeNull()
    expect(getByLabelText("Open Folder")).not.toBeNull()
    expect(getByLabelText("Clone Repository")).not.toBeNull()

    fireEvent.click(getByLabelText("New group"))
    expect(onNewFolderGroup).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("gates New group on the folders section, like the other folder actions", () => {
    const { queryByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="chats"
        expanded
        onToggle={onToggle}
        onNewFolderGroup={onNewFolderGroup}
      />
    )
    expect(queryByLabelText("New group")).toBeNull()
  })

  it("still toggles the section when the header label is clicked", () => {
    const { getByText } = renderWithIntl(
      <SidebarSectionHeader
        section="folders"
        expanded
        onToggle={onToggle}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
      />
    )
    fireEvent.click(getByText("Folders"))
    expect(onToggle).toHaveBeenCalledWith("folders")
  })
})

describe("SidebarSectionHeader action gating by section", () => {
  it("offers only New chat on the chats section, never the folder actions", () => {
    // Pass the folder callbacks too: they must be gated by `section`, not merely
    // by callback presence.
    const { getByLabelText, queryByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="chats"
        expanded
        onToggle={onToggle}
        onNewChat={onNewChat}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
      />
    )
    expect(getByLabelText("New chat")).not.toBeNull()
    expect(queryByLabelText("Open Folder")).toBeNull()
    expect(queryByLabelText("Clone Repository")).toBeNull()
  })

  it("offers no action buttons on the pinned section", () => {
    const { queryByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="pinned"
        expanded
        onToggle={onToggle}
        onNewChat={onNewChat}
        onOpenFolder={onOpenFolder}
        onCloneRepository={onCloneRepository}
      />
    )
    expect(queryByLabelText("New chat")).toBeNull()
    expect(queryByLabelText("Open Folder")).toBeNull()
    expect(queryByLabelText("Clone Repository")).toBeNull()
  })
})

// Radix arms its document-level pointer-down listener in a `setTimeout(0)`, and
// jsdom has no `PointerEvent`, so open the menu with real `MouseEvent`s under
// the pointer-event names (same recipe as nested-layer-dismiss.test.tsx).
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}
function click(target: Element) {
  fireMouse(target, "pointerdown")
  fireMouse(target, "pointerup")
  fireMouse(target, "click")
}

describe("SidebarSectionHeader recent-section filter", () => {
  const onRecentFilterChange = vi.fn()

  beforeEach(() => {
    onRecentFilterChange.mockClear()
  })

  it("opens a labelled All / Chat / Folders menu and reports the pick", async () => {
    renderWithIntl(
      <SidebarSectionHeader
        section="recent"
        expanded
        onToggle={onToggle}
        onNewChat={onNewChat}
        recentFilter="all"
        onRecentFilterChange={onRecentFilterChange}
      />
    )
    await settle()
    const trigger = screen.getByLabelText("Show in Recent: All")
    click(trigger)
    await settle()
    expect(screen.getByText("Show in Recent")).toBeInTheDocument()
    // The open menu disables pointer events outside it, so the row loses its
    // hover; the trigger has to hold itself visible off its own open state.
    expect(trigger).toHaveAttribute("data-state", "open")
    expect(trigger).toHaveClass("data-[state=open]:opacity-100")
    const options = screen.getAllByRole("menuitemradio")
    expect(options.map((o) => o.textContent)).toEqual([
      "All",
      "Chat",
      "Folders",
    ])
    expect(options[0]).toHaveAttribute("aria-checked", "true")
    click(screen.getByRole("menuitemradio", { name: "Chat" }))
    expect(onRecentFilterChange).toHaveBeenCalledWith("chats")
    expect(onToggle).not.toHaveBeenCalled()
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it("names the active filter on the trigger and keeps it visible", () => {
    const header = (recentFilter: "all" | "chats" | "folders") => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SidebarSectionHeader
          section="recent"
          expanded
          onToggle={onToggle}
          recentFilter={recentFilter}
          onRecentFilterChange={onRecentFilterChange}
        />
      </NextIntlClientProvider>
    )
    const { getByLabelText, rerender } = render(header("chats"))
    const chats = getByLabelText("Show in Recent: Chat")
    expect(chats).toHaveAttribute("data-recent-filter", "chats")
    // jsdom applies no stylesheet, so the classes are the visibility contract:
    // a narrowing filter pins the trigger on, instead of hover-revealing it.
    expect(chats).toHaveClass("opacity-100")
    expect(chats).not.toHaveClass("opacity-0")

    rerender(header("folders"))
    const folders = getByLabelText("Show in Recent: Folders")
    expect(folders).toHaveAttribute("data-recent-filter", "folders")
    expect(folders).toHaveClass("opacity-100")

    // Back on "all" nothing is narrowed, so it hides with the other actions.
    rerender(header("all"))
    const all = getByLabelText("Show in Recent: All")
    expect(all).toHaveClass("opacity-0")
    expect(all).not.toHaveClass("opacity-100")
  })

  it("renders no filter menu on other sections", () => {
    const { queryByLabelText } = renderWithIntl(
      <SidebarSectionHeader
        section="chats"
        expanded
        onToggle={onToggle}
        recentFilter="all"
        onRecentFilterChange={onRecentFilterChange}
      />
    )
    expect(queryByLabelText(/Show in Recent/)).toBeNull()
  })
})

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { LeftEdgeChrome } from "./left-edge-chrome"
import enMessages from "@/i18n/messages/en.json"

const spies = vi.hoisted(() => ({
  setSearchOpen: vi.fn(),
  toggleSidebar: vi.fn(),
}))

vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: spies.toggleSidebar }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ open: false, setOpen: spies.setSearchOpen }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMac: false }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { toggle_search: "mod+k", toggle_sidebar: "mod+b" },
  }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))

function renderChrome() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LeftEdgeChrome />
    </NextIntlClientProvider>
  )
}

describe("LeftEdgeChrome", () => {
  beforeEach(() => {
    spies.setSearchOpen.mockClear()
    spies.toggleSidebar.mockClear()
  })

  it("opens the shared search dialog from the search button", () => {
    renderChrome()
    fireEvent.click(screen.getByRole("button", { name: "Search" }))
    expect(spies.setSearchOpen).toHaveBeenCalledWith(true)
  })

  it("advertises the search shortcut on the button's tooltip", () => {
    renderChrome()
    // isMac=false → "mod" formats as "Ctrl". The sidebar row this replaced
    // carried the hint as a visible badge; here it lives in the title.
    expect(screen.getByRole("button", { name: "Search" }).title).toBe(
      "Search (Ctrl+K)"
    )
  })

  it("no longer carries the remote-workspace picker", () => {
    renderChrome()
    // It moved to the sidebar list's context menu + the status bar's quick
    // actions; this always-visible slot went to the far more frequent search.
    expect(
      screen.queryByRole("button", { name: "Open remote workspace" })
    ).toBeNull()
    // Only the two intended controls remain.
    expect(screen.getAllByRole("button")).toHaveLength(2)
  })

  it("keeps the sidebar toggle", () => {
    renderChrome()
    fireEvent.click(screen.getByRole("button", { name: /Hide Sidebar/ }))
    expect(spies.toggleSidebar).toHaveBeenCalled()
  })
})

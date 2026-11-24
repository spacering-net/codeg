import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isRemoteDesktopWindow: vi.fn(() => false),
}))

vi.mock("@/lib/platform", () => ({
  isRemoteDesktopWindow: mocks.isRemoteDesktopWindow,
}))

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

import { OpenInSubContent } from "./open-in-menu"

const handlers = {
  onOpenExplorer: vi.fn(),
  onOpenTerminal: vi.fn(),
  onOpenCode: vi.fn(),
}

function renderMenu(explorerDisabled?: boolean) {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="target">folder</ContextMenuTrigger>
      <ContextMenuContent>
        {/* The submenu is pinned open: the row's disabled state is what's
            under test, not Radix's hover-to-open choreography. */}
        <ContextMenuSub open>
          <ContextMenuSubTrigger>Open in</ContextMenuSubTrigger>
          <OpenInSubContent
            explorerLabel="Explorer"
            terminalLabel="Terminal"
            codeLabel="VS Code"
            explorerDisabled={explorerDisabled}
            {...handlers}
          />
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name })
}

describe("OpenInSubContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isRemoteDesktopWindow.mockReturnValue(false)
  })

  it("offers Explorer, Terminal and VS Code", () => {
    renderMenu()
    expect(item("Explorer")).toBeTruthy()
    expect(item("Terminal")).toBeTruthy()
    expect(item("VS Code")).toBeTruthy()
  })

  it("runs the VS Code action when the workspace host is this machine", () => {
    renderMenu()
    fireEvent.click(item("VS Code"))
    expect(handlers.onOpenCode).toHaveBeenCalledTimes(1)
  })

  it("disables VS Code in a remote-desktop window", () => {
    // `open_in_code` runs on the host that owns the path, so on a remote
    // workspace the editor would open over there and read as a no-op here.
    mocks.isRemoteDesktopWindow.mockReturnValue(true)
    renderMenu()
    expect(item("VS Code").getAttribute("data-disabled")).not.toBeNull()
    fireEvent.click(item("VS Code"))
    expect(handlers.onOpenCode).not.toHaveBeenCalled()
    // The two rows that stay useful over a remote connection are untouched.
    expect(item("Terminal").getAttribute("data-disabled")).toBeNull()
    fireEvent.click(item("Terminal"))
    expect(handlers.onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it("passes the caller's explorer gate through", () => {
    renderMenu(true)
    expect(item("Explorer").getAttribute("data-disabled")).not.toBeNull()
    fireEvent.click(item("Explorer"))
    expect(handlers.onOpenExplorer).not.toHaveBeenCalled()
  })
})

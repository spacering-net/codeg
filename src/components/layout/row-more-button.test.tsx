import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// `next-intl`'s `useTranslations` returns the leaf string for the requested
// key. Stub it to a fixed value so the tests only check button behaviour, not
// translation plumbing.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `tr:${key}`,
}))

import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

import { RowMoreButton } from "./row-more-button"

/**
 * The button only makes sense inside the thing it opens, so every test renders
 * a real Radix `ContextMenu` around a real file-tree row — the same wiring the
 * file tree uses. A test that fires at a bare `<div>` cannot tell a working
 * button from one whose trigger never made it into the DOM.
 */
function renderRow(
  row: (actions: ReactNode) => ReactNode,
  options: { keyboardNavigation?: boolean } = {}
) {
  // `onSelect` is what a click on the row itself fires (open the preview /
  // select the folder) — the handler the button must not leak into.
  const onRowSelect = vi.fn()
  render(
    <FileTree
      keyboardNavigation={options.keyboardNavigation ?? false}
      expanded={new Set(["dir"])}
      onSelect={onRowSelect}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {row(<RowMoreButton />)}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={vi.fn()}>rename</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </FileTree>
  )
  return { button: screen.getByLabelText("tr:moreActions"), onRowSelect }
}

const fileRow = (actions: ReactNode) => (
  <FileTreeFile path="dir/file.ts" name="file.ts" depth={1} actions={actions} />
)

const folderRow = (actions: ReactNode) => (
  <FileTreeFolder path="dir" name="dir" depth={0} actions={actions} />
)

function openMenuTexts(): string[] {
  return [...document.querySelectorAll("[data-slot=context-menu-content]")].map(
    (node) => node.textContent ?? ""
  )
}

describe("RowMoreButton", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a labelled menu button with the icon hidden from AT", () => {
    const { button } = renderRow(fileRow)
    expect(button.tagName).toBe("BUTTON")
    expect(button).toHaveAttribute("aria-label", "tr:moreActions")
    expect(button).toHaveAttribute("aria-haspopup", "menu")
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden")
  })

  it.each([
    ["file", fileRow],
    ["folder", folderRow],
  ])("opens the row's own context menu on a %s row", (_kind, row) => {
    const { button } = renderRow(row)
    expect(openMenuTexts()).toEqual([])
    fireEvent.click(button)
    expect(openMenuTexts()).toEqual(["rename"])
  })

  it("anchors the menu at the button's box, not at the click point", () => {
    const { button } = renderRow(fileRow)
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 48,
      left: 120,
    } as DOMRect)
    const seen = vi.fn()
    button.addEventListener("contextmenu", seen as EventListener)

    // A keyboard activation (Enter/Space on a focused button) reports
    // clientX/clientY as 0 — anchoring on those would park the menu in the
    // viewport's top-left corner instead of next to the row.
    fireEvent.click(button, { clientX: 0, clientY: 0 })

    const event = seen.mock.calls[0][0] as MouseEvent
    expect(event.type).toBe("contextmenu")
    expect(event.button).toBe(2)
    expect(event.bubbles).toBe(true)
    expect(event.cancelable).toBe(true)
    expect([event.clientX, event.clientY]).toEqual([120, 48])
  })

  it.each([
    ["file", fileRow],
    ["folder", folderRow],
  ])("does not leak the click into the %s row's own handler", (_kind, row) => {
    const { button, onRowSelect } = renderRow(row)
    fireEvent.click(button)
    expect(onRowSelect).not.toHaveBeenCalled()
  })

  it("stays out of the tab order inside a roving-focus tree", () => {
    // The tree container is the single tab stop and owns the arrow keys; one
    // focusable widget per row would put every row back in the tab sequence.
    const { button } = renderRow(fileRow, { keyboardNavigation: true })
    expect(button.tabIndex).toBe(-1)
  })

  it("keeps its default tab stop in trees without roving focus", () => {
    const { button } = renderRow(fileRow)
    expect(button.tabIndex).toBe(0)
  })
})

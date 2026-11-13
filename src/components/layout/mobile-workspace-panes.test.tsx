import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { initialConversationPanes } from "@/lib/conversation-panes"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import en from "@/i18n/messages/en.json"
import { MobileWorkspacePanes } from "./mobile-workspace-panes"

vi.mock("@/lib/api", () => ({ getFolderConversation: vi.fn() }))

function workspace(showConversation: boolean) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <MobileWorkspacePanes
        showConversation={showConversation}
        files={<div>File preview</div>}
      >
        <textarea aria-label="Draft" />
      </MobileWorkspacePanes>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetTabStore()
  useTabStore.setState({ paneState: initialConversationPanes() })
})

describe("mobile workspace surfaces", () => {
  it("does not reserve an island row while the feature is off", () => {
    useTabStore.setState({ paneState: null })
    const { container } = render(workspace(true))
    expect(screen.queryByRole("button", { name: "Pane: Pane 1" })).toBeNull()
    const surface = container.querySelector(
      '[data-workspace-pane="conversation"]'
    )!
    expect(surface.children).toHaveLength(1)
  })

  it("provides the Pane switcher without requiring the desktop shell", () => {
    render(workspace(true))
    expect(screen.getByRole("button", { name: "Pane: Pane 1" })).toBeDefined()
  })

  it("keeps the editor and draft mounted while files cover the conversation", () => {
    const { container, rerender } = render(workspace(true))
    const editor = screen.getByRole("textbox", { name: "Draft" })
    fireEvent.change(editor, { target: { value: "Keep this draft" } })
    const pane = container.querySelector(
      '[data-workspace-pane="conversation"]'
    )!

    rerender(workspace(false))
    expect(pane).toHaveAttribute("inert")
    expect(pane).toHaveAttribute("aria-hidden", "true")
    expect(editor.isConnected).toBe(true)
    expect(screen.getByText("File preview")).toBeInTheDocument()

    rerender(workspace(true))
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(editor)
    expect(editor).toHaveValue("Keep this draft")
    expect(pane).not.toHaveAttribute("inert")
    expect(screen.queryByText("File preview")).toBeNull()
  })
})

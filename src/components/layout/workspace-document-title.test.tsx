/**
 * The workspace's page title (10.10): the folder, and on the web — where
 * there is no dock to badge — how many assistants have something unread.
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  desktop: false,
  folder: null as { name: string } | null,
  unread: 0,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: h.folder }),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePrimaryAgent: () => ({ snapshot: null, needsOwner: false }),
}))
vi.mock("@/components/layout/sidebar", () => ({
  useAssistantsBadge: () => ({ unreadBots: h.unread, needsOwner: false }),
}))

import { WorkspaceDocumentTitle } from "./workspace-document-title"

afterEach(() => {
  cleanup()
  h.desktop = false
  h.folder = null
  h.unread = 0
})

describe("the workspace's title", () => {
  it("names the folder, and on the web counts the assistants with unread", () => {
    h.folder = { name: "codeg" }
    const { rerender } = render(<WorkspaceDocumentTitle />)
    expect(document.title).toBe("codeg - codeg")
    h.unread = 2
    rerender(<WorkspaceDocumentTitle />)
    expect(document.title).toBe("(2) codeg - codeg")
    h.unread = 0
    rerender(<WorkspaceDocumentTitle />)
    expect(document.title).toBe("codeg - codeg")
  })

  it("leaves the count to the dock on the desktop", () => {
    h.desktop = true
    h.unread = 3
    render(<WorkspaceDocumentTitle />)
    expect(document.title).toBe("codeg")
  })
})

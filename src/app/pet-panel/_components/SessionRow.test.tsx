import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mocks MUST be declared before importing the component under test.
vi.mock("@/lib/pet/api", () => ({
  closePetPanel: vi.fn(() => Promise.resolve()),
  focusConversation: vi.fn(() => Promise.resolve()),
}))
vi.mock("./PanelPermissionCard", () => ({
  PanelPermissionCard: ({ connectionId }: { connectionId: string }) => (
    <div data-testid="permission-card">{connectionId}</div>
  ),
}))

import { SessionRow } from "./SessionRow"
import { closePetPanel, focusConversation } from "@/lib/pet/api"
import enMessages from "@/i18n/messages/en.json"
import type { PetSessionEntry } from "@/lib/pet/types"

const mockFocus = vi.mocked(focusConversation)
const mockClose = vi.mocked(closePetPanel)

const pending = {
  requestId: "r1",
  toolCall: {},
  options: [],
}

function rootSession(): PetSessionEntry {
  return {
    connectionId: "conn-parent",
    conversationId: 7,
    folderId: 3,
    agentType: "claude_code",
    title: "Refactor the parser",
    status: "prompting",
  }
}

/** The #447 shape: a delegation child kept in the payload because it is
 *  blocked on a permission, carrying its parent's ids for navigation. */
function subAgentSession(): PetSessionEntry {
  return {
    connectionId: "conn-child",
    conversationId: 42,
    folderId: 9,
    agentType: "codex",
    title: "Run the tests",
    status: "prompting",
    pending,
    parent: {
      conversationId: 7,
      folderId: 3,
      agentType: "claude_code",
      title: "Refactor the parser",
    },
  }
}

function renderRow(session: PetSessionEntry) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionRow session={session} />
    </NextIntlClientProvider>
  )
}

describe("SessionRow", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("jumps to its own conversation for an ordinary session", () => {
    renderRow(rootSession())
    expect(screen.queryByText(/Sub-agent of/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(mockFocus).toHaveBeenCalledWith(3, 7, "claude_code")
  })

  it("names the parent on a delegation sub-agent row", () => {
    renderRow(subAgentSession())
    expect(screen.getByText("Run the tests")).toBeInTheDocument()
    expect(
      screen.getByText(/Sub-agent of · Refactor the parser/)
    ).toBeInTheDocument()
  })

  it("leads a sub-agent row with the assistant it runs as", () => {
    renderRow({ ...subAgentSession(), assistantName: "Reviewer" })
    expect(screen.getByText("Reviewer · Run the tests")).toBeInTheDocument()
    cleanup()
    renderRow({ ...subAgentSession(), assistantName: "Reviewer", title: "" })
    expect(screen.getByText("Reviewer")).toBeInTheDocument()
  })

  it("jumps to the PARENT conversation from a sub-agent row", async () => {
    // The child is not openable as a tab, so the row must navigate to whoever
    // delegated it — never to the child's own ids.
    renderRow(subAgentSession())
    fireEvent.click(screen.getByRole("button"))
    expect(mockFocus).toHaveBeenCalledWith(3, 7, "claude_code")
    await vi.waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1))
  })

  it("answers a sub-agent's permission through the CHILD connection", () => {
    // The whole point of listing the row: approving must reach the connection
    // that is actually blocked, not the parent's.
    renderRow(subAgentSession())
    expect(screen.getByTestId("permission-card")).toHaveTextContent(
      "conn-child"
    )
  })
})

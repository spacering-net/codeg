import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  createRemoteWorkspaceConnection: vi.fn(),
  updateRemoteWorkspaceConnection: vi.fn(),
  deleteRemoteWorkspaceConnection: vi.fn(),
  reorderRemoteWorkspaceConnections: vi.fn(),
}))

vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: mocks.listRemoteWorkspaceConnections,
  createRemoteWorkspaceConnection: mocks.createRemoteWorkspaceConnection,
  updateRemoteWorkspaceConnection: mocks.updateRemoteWorkspaceConnection,
  deleteRemoteWorkspaceConnection: mocks.deleteRemoteWorkspaceConnection,
  reorderRemoteWorkspaceConnections: mocks.reorderRemoteWorkspaceConnections,
}))

import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import enMessages from "@/i18n/messages/en.json"

function connection(
  overrides: Partial<RemoteWorkspaceConnection> = {}
): RemoteWorkspaceConnection {
  return {
    id: 1,
    name: "prod-box",
    base_url: "https://prod.example",
    token: "secret",
    headers: [],
    sort_order: 0,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    ...overrides,
  }
}

async function mount(connections: RemoteWorkspaceConnection[]) {
  mocks.listRemoteWorkspaceConnections.mockResolvedValue(connections)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteWorkspaceManageDialog
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />
    </NextIntlClientProvider>
  )
  await screen.findByDisplayValue(connections[0].name)
}

describe("RemoteWorkspaceManageDialog search", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("says nothing matches when the search filters out every connection", async () => {
    await mount([connection()])

    fireEvent.change(screen.getByPlaceholderText("Search remote workspaces"), {
      target: { value: "no-such-box" },
    })

    expect(
      await screen.findByText("No matching remote connections")
    ).toBeInTheDocument()
    // The search prompt belongs in the field, not in the empty list.
    expect(
      screen.queryByText("Search remote workspaces")
    ).not.toBeInTheDocument()
  })
})

describe("RemoteWorkspaceManageDialog custom headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the editor collapsed when the connection has no headers", async () => {
    await mount([connection()])
    expect(screen.queryByLabelText("Header name")).not.toBeInTheDocument()
  })

  it("opens the editor when the connection already has headers", async () => {
    await mount([
      connection({ headers: [{ name: "CF-Access-Client-Id", value: "abc" }] }),
    ])
    expect(await screen.findByDisplayValue("CF-Access-Client-Id")).toBeVisible()
  })

  it("masks every header value", async () => {
    await mount([connection({ headers: [{ name: "X-Secret", value: "abc" }] })])
    expect(await screen.findByDisplayValue("abc")).toHaveAttribute(
      "type",
      "password"
    )
  })

  it("sends the added header on save and drops a removed one", async () => {
    const saved = connection({
      headers: [{ name: "X-Team", value: "core" }],
    })
    mocks.updateRemoteWorkspaceConnection.mockResolvedValue(saved)
    await mount([connection()])

    await userEvent.click(
      screen.getByRole("button", { name: /Custom headers/ })
    )
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    fireEvent.change(screen.getByLabelText("Header name"), {
      target: { value: "X-Team" },
    })
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: "core" },
    })

    // A second row, then removed again: the payload must hold one header.
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove header" })[1]
    )

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mocks.updateRemoteWorkspaceConnection).toHaveBeenCalledWith(1, {
        name: "prod-box",
        baseUrl: "https://prod.example",
        token: "secret",
        headers: [{ name: "X-Team", value: "core" }],
      })
    })
  })
})

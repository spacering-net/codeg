import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"
import { CanvasConversationDrawer } from "./canvas-conversation-drawer"

/**
 * The side panel is the non-destructive way into a canvas conversation: the
 * whole surface, with the board left exactly as it was. What matters here is
 * the wiring it hands that surface — a wrong `contextKey` starts a second agent
 * for a session that already has one, an editable folder chip would let a bound
 * conversation be moved, and a reused instance across two conversations streams
 * the second one into the first one's runtime session.
 *
 * `CanvasConversationSurface` is stubbed: the real one pulls in the entire chat
 * stack (ACP connections, transcript, composer) and would test that instead.
 */
const { surfaceRendered } = vi.hoisted(() => ({ surfaceRendered: vi.fn() }))

vi.mock("./canvas-conversation-surface", () => ({
  CanvasConversationSurface: (props: Record<string, unknown>) => {
    surfaceRendered(props)
    return <div data-testid="conversation-surface" />
  },
}))

const CONVERSATION: DbConversationSummary = {
  id: 7,
  folder_id: 3,
  title: "Fix the flaky test",
  title_locked: false,
  agent_type: "claude",
  status: "in_progress",
  kind: "regular",
  model: "claude-opus-5",
  git_branch: "main",
  external_id: "sess-1",
  message_count: 4,
  child_count: 0,
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  pinned_at: null,
}

function renderDrawer(props: {
  conversation: DbConversationSummary | null
  contextKey: string | null
  onOpenChange?: (open: boolean) => void
  onOpenInWorkspace?: () => void
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CanvasConversationDrawer
        conversation={props.conversation}
        contextKey={props.contextKey}
        onOpenChange={props.onOpenChange ?? (() => {})}
        onOpenInWorkspace={props.onOpenInWorkspace ?? (() => {})}
      />
    </NextIntlClientProvider>
  )
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("CanvasConversationDrawer", () => {
  it("shows the conversation and hands its surface the panel's own key", async () => {
    renderDrawer({ conversation: CONVERSATION, contextKey: "canvas-drawer-7" })
    await settle()

    expect(screen.getByText("Fix the flaky test")).toBeTruthy()
    expect(screen.getByTestId("conversation-surface")).toBeTruthy()

    const props = surfaceRendered.mock.lastCall![0]
    expect(props.conversationId).toBe(7)
    expect(props.agentType).toBe("claude")
    // Its OWN key, not the card's: with both open, the second surface joins the
    // first one's connection as a viewer instead of spawning another agent.
    expect(props.contextKey).toBe("canvas-drawer-7")
    // Open means being looked at — this surface connects, unlike a card
    // restored from a previous visit.
    expect(props.isActive).toBe(true)
  })

  it("pins the conversation to its own folder", async () => {
    renderDrawer({ conversation: CONVERSATION, contextKey: "canvas-drawer-7" })
    await settle()

    const props = surfaceRendered.mock.lastCall![0] as {
      folderPickerOverride: { folderId: number; editable: boolean }
    }
    // Without the override the chip resolves the workspace's ACTIVE TAB and
    // shows a folder that has nothing to do with this conversation; without
    // `editable: false` a bound conversation could be dragged to another one.
    expect(props.folderPickerOverride.folderId).toBe(3)
    expect(props.folderPickerOverride.editable).toBe(false)
  })

  it("renders nothing while closed", async () => {
    renderDrawer({ conversation: null, contextKey: null })
    await settle()

    // A closed panel must not hold a live surface: it would keep a connection
    // alive for a conversation nobody is looking at.
    expect(screen.queryByTestId("conversation-surface")).toBeNull()
    expect(surfaceRendered).not.toHaveBeenCalled()
  })

  it("hands the conversation over to the workspace on request", async () => {
    const onOpenInWorkspace = vi.fn()
    renderDrawer({
      conversation: CONVERSATION,
      contextKey: "canvas-drawer-7",
      onOpenInWorkspace,
    })
    await settle()

    fireEvent.click(screen.getByRole("button", { name: "Open in workspace" }))

    expect(onOpenInWorkspace).toHaveBeenCalledTimes(1)
  })

  it("remounts the surface for a different conversation", async () => {
    // The surface fixes its runtime session id at mount, so the panel keys it
    // by conversation. Reusing the instance would leave the second conversation
    // streaming into the first one's session.
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/canvas/canvas-conversation-drawer.tsx"
      ),
      "utf8"
    )
    expect(source).toContain("key={conversation.id}")
  })
})

describe("the collapsed card it replaced", () => {
  it("no longer opens a hover bubble", () => {
    // The panel is the answer to "show me more about this card" now. Leaving
    // the bubble in would mean two overlapping ways to read the same
    // conversation, one of them appearing by accident on the way to the dock.
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/canvas/nodes/conversation-card-node.tsx"
      ),
      "utf8"
    )
    expect(source).not.toContain("HoverCard")
  })

  it("is reachable from the dock's card actions", () => {
    const dock = readFileSync(
      resolve(process.cwd(), "src/components/canvas/canvas-dock.tsx"),
      "utf8"
    )
    expect(dock).toContain("openConversationDrawer")
    expect(dock).toContain("openDetailPanel")
  })
})

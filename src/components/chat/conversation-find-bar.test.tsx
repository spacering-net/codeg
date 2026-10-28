import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ConversationFindBar } from "./conversation-find-bar"
import type { ThreadRenderItem } from "@/components/message/message-list-view"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"
import * as api from "@/lib/api"
import type { ConversationMessageMatch } from "@/lib/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values) {
      return `${key}:${JSON.stringify(values)}`
    }
    return key
  },
}))

vi.mock("@/lib/api", () => ({
  searchConversationMessages: vi.fn(),
}))

function createFakeTurnItem(id: string, text: string): ThreadRenderItem {
  return {
    key: `persisted-${id}`,
    kind: "turn",
    group: {
      id,
      role: "assistant",
      parts: [{ type: "text", text }],
      resources: [],
      images: [],
    },
    phase: "persisted",
    isResponseComplete: true,
    showStats: false,
    isRoleTransition: false,
    previousUserIndex: null,
    isLastAssistantRun: false,
    isThreadTail: false,
    sourceTurns: [],
  }
}

describe("ConversationFindBar", () => {
  let scrollApi: MessageScrollContextValue
  let scrollApiRef: { current: MessageScrollContextValue | null }

  beforeEach(() => {
    vi.clearAllMocks()
    scrollApi = {
      scrollToIndex: vi.fn(),
      revealFromAbove: vi.fn(),
    }
    scrollApiRef = { current: scrollApi }
  })

  afterEach(() => {
    cleanup()
  })

  it("renders nothing when closed", () => {
    render(
      <ConversationFindBar
        conversationId={1}
        open={false}
        focusToken={0}
        onClose={vi.fn()}
        threadItems={[]}
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={vi.fn()}
        onActiveTurnChange={vi.fn()}
      />
    )
    expect(screen.queryByRole("search")).toBeNull()
  })

  it("renders input and controls when open", () => {
    render(
      <ConversationFindBar
        conversationId={1}
        open={true}
        focusToken={0}
        onClose={vi.fn()}
        threadItems={[]}
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={vi.fn()}
        onActiveTurnChange={vi.fn()}
      />
    )
    expect(screen.getByRole("search")).toBeDefined()
    expect(screen.getByPlaceholderText("placeholder")).toBeDefined()
    expect(screen.getByLabelText("previous")).toBeDefined()
    expect(screen.getByLabelText("next")).toBeDefined()
    expect(screen.getByLabelText("close")).toBeDefined()
  })

  it("calls onClose when close button is clicked or Escape pressed", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <ConversationFindBar
        conversationId={1}
        open={true}
        focusToken={0}
        onClose={onClose}
        threadItems={[]}
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={vi.fn()}
        onActiveTurnChange={vi.fn()}
      />
    )

    await user.click(screen.getByLabelText("close"))
    expect(onClose).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText("placeholder")
    await user.type(input, "{Escape}")
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("searches via backend API and navigates matches", async () => {
    const mockMatches: ConversationMessageMatch[] = [
      {
        turn_index: 2,
        turn_id: "turn-2",
        role: "user",
        match_count: 1,
        snippet: "find me",
      },
      {
        turn_index: 5,
        turn_id: "turn-5",
        role: "assistant",
        match_count: 2,
        snippet: "another find",
      },
    ]
    vi.mocked(api.searchConversationMessages).mockResolvedValue(mockMatches)

    const threadItems = [
      createFakeTurnItem("turn-2", "find me"),
      createFakeTurnItem("turn-5", "another find"),
    ]
    const onActiveTurnChange = vi.fn()
    const user = userEvent.setup()

    render(
      <ConversationFindBar
        conversationId={100}
        open={true}
        focusToken={0}
        onClose={vi.fn()}
        threadItems={threadItems}
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={vi.fn()}
        onActiveTurnChange={onActiveTurnChange}
      />
    )

    const input = screen.getByPlaceholderText("placeholder")
    await user.type(input, "find")

    await waitFor(() => {
      expect(api.searchConversationMessages).toHaveBeenCalledWith(100, "find")
    })

    // First match active
    await waitFor(() => {
      expect(onActiveTurnChange).toHaveBeenCalledWith("turn-2")
      expect(scrollApi.scrollToIndex).toHaveBeenCalledWith(0, {
        align: "center",
        smooth: true,
      })
    })

    // Press next button
    await user.click(screen.getByLabelText("next"))
    expect(onActiveTurnChange).toHaveBeenCalledWith("turn-5")
    expect(scrollApi.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "center",
      smooth: true,
    })

    // Press Enter inside input navigates next (wraps around to turn-2)
    await user.type(input, "{Enter}")
    expect(onActiveTurnChange).toHaveBeenCalledWith("turn-2")

    // Shift+Enter navigates previous (wraps backwards to turn-5)
    await user.type(input, "{Shift>}{Enter}{/Shift}")
    expect(onActiveTurnChange).toHaveBeenCalledWith("turn-5")
  })

  it("calls loadOlderTurnsThrough when match is an unloaded older turn", async () => {
    const mockMatches: ConversationMessageMatch[] = [
      {
        turn_index: 1,
        turn_id: "turn-1",
        role: "user",
        match_count: 1,
        snippet: "older match",
      },
    ]
    vi.mocked(api.searchConversationMessages).mockResolvedValue(mockMatches)

    const loadOlderTurnsThrough = vi.fn().mockResolvedValue(true)
    const onActiveTurnChange = vi.fn()
    const user = userEvent.setup()

    render(
      <ConversationFindBar
        conversationId={100}
        open={true}
        focusToken={0}
        onClose={vi.fn()}
        threadItems={[createFakeTurnItem("turn-10", "recent item")]}
        turnsOffset={5} // turn_index 1 is older than offset 5
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={loadOlderTurnsThrough}
        onActiveTurnChange={onActiveTurnChange}
      />
    )

    const input = screen.getByPlaceholderText("placeholder")
    await user.type(input, "older")

    await waitFor(() => {
      expect(loadOlderTurnsThrough).toHaveBeenCalledWith(100, 1)
      expect(onActiveTurnChange).toHaveBeenCalledWith("turn-1")
    })
  })

  it("searches in-memory thread items for draft conversation (id=0)", async () => {
    const threadItems = [
      createFakeTurnItem("draft-1", "Hello World"),
      createFakeTurnItem("draft-2", "Something else"),
      createFakeTurnItem("draft-3", "Hello again"),
    ]
    const onActiveTurnChange = vi.fn()
    const user = userEvent.setup()

    render(
      <ConversationFindBar
        conversationId={0}
        open={true}
        focusToken={0}
        onClose={vi.fn()}
        threadItems={threadItems}
        scrollApiRef={scrollApiRef}
        loadOlderTurnsThrough={vi.fn()}
        onActiveTurnChange={onActiveTurnChange}
      />
    )

    const input = screen.getByPlaceholderText("placeholder")
    await user.type(input, "Hello")

    await waitFor(() => {
      expect(api.searchConversationMessages).not.toHaveBeenCalled()
      expect(onActiveTurnChange).toHaveBeenCalledWith("draft-1")
    })

    await user.click(screen.getByLabelText("next"))
    expect(onActiveTurnChange).toHaveBeenCalledWith("draft-3")
  })
})

import { type ReactElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import {
  CollapsibleUserMessage,
  splitSessionMessageSource,
} from "./collapsible-user-message"
import enMessages from "@/i18n/messages/en.json"
import { mockClampLayout } from "@/test-layout"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { resetFolderTabsStore } from "@/stores/folder-tabs-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { findSessionMessageSource } from "./session-message-anchor"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const TEXT_PART: AdaptedContentPart[] = [{ type: "text", text: "hello world" }]

describe("splitSessionMessageSource", () => {
  it("locates a send by its MCP result and a reply by its originating turn", () => {
    const messageId = "9bb21579-3854-42d6-8f1e-40410a141227"
    const incoming = `[Codeg message from conversation 42; message ${messageId}]\n\nhello`
    const groups = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "mcp__codeg-mcp__send_to_session",
            input: null,
            state: "output-available",
            output: JSON.stringify({
              structuredContent: { message_id: messageId },
            }),
          },
        ],
      },
      { role: "user", parts: [{ type: "text", text: incoming }] },
      { role: "assistant", parts: [{ type: "text", text: "reply" }] },
    ] satisfies Parameters<typeof findSessionMessageSource>[0]
    expect(findSessionMessageSource(groups, { kind: "send", messageId })).toBe(
      0
    )
    expect(findSessionMessageSource(groups, { kind: "reply", messageId })).toBe(
      2
    )
    const reply = `[Automatic reply from session 42; replying to ${messageId}]\n\nreply`
    expect(
      splitSessionMessageSource([
        { type: "text", text: incoming.replace("hello", reply) },
      ]).anchor
    ).toEqual({ kind: "reply", messageId })
  })

  it("keeps the source message ID for navigation and strips it from the bubble", () => {
    const id = "9bb21579-3854-42d6-8f1e-40410a141227"
    expect(
      splitSessionMessageSource([
        {
          type: "text",
          text: `[Codeg message from conversation 42; message ${id}]\n\nhello`,
        },
      ])
    ).toEqual({
      source: "42",
      anchor: { kind: "send", messageId: id },
      parts: [{ type: "text", text: "hello" }],
    })
  })

  it("extracts different senders and preserves the remaining parts", () => {
    for (const id of ["12", "345"]) {
      const parts: AdaptedContentPart[] = [
        {
          type: "text",
          text: `[Codeg message from conversation ${id}]\n\nhello`,
        },
        { type: "text", text: "more" },
      ]
      expect(splitSessionMessageSource(parts)).toEqual({
        source: id,
        parts: [{ type: "text", text: "hello" }, parts[1]],
      })
    }
  })

  it("removes the automatic reply marker, including the old standalone form", () => {
    for (const text of [
      "[Codeg message from conversation 42]\n\n[Automatic reply from session 42]\n\nanswer",
      "[Automatic reply from session 42]\n\nanswer",
    ]) {
      expect(splitSessionMessageSource([{ type: "text", text }])).toEqual({
        source: "42",
        parts: [{ type: "text", text: "answer" }],
      })
    }
  })

  it("leaves ordinary messages unchanged", () => {
    expect(splitSessionMessageSource(TEXT_PART)).toEqual({
      source: null,
      parts: TEXT_PART,
    })
  })

  it("keeps the sender label and removes routing details from a delivered reply", () => {
    const text =
      '[Codeg message from conversation 21 ("Sender") to you, conversation 22 ("Receiver")]\n\n' +
      "[Automatic reply from session 21]\n\nanswer"
    expect(splitSessionMessageSource([{ type: "text", text }])).toEqual({
      source: "21",
      parts: [{ type: "text", text: "answer" }],
    })
  })
})

describe("CollapsibleUserMessage", () => {
  let restoreMetrics: (() => void) | null = null

  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("keeps both conversation tabs open when following a sender link", () => {
    const workspace = useAppWorkspaceStore.getState()
    resetTabStore()
    resetFolderTabsStore()
    workspace.applyConversationUpsert({
      id: 42,
      folder_id: 1,
      title: "Sender",
      title_locked: false,
      agent_type: "claude_code",
      status: "pending",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      pinned_at: null,
    })
    try {
      useTabStore.getState().openTab(1, 41, "claude_code")
      renderWithIntl(
        <CollapsibleUserMessage
          parts={[
            {
              type: "text",
              text: "[Codeg message from conversation 42]\n\nhello",
            },
          ]}
        />
      )
      const link = screen.getByRole("button", { name: "Conversation #42" })
      fireEvent.click(link)
      fireEvent.click(link)
      const { rawTabs, activeTabId } = useTabStore.getState()
      expect(rawTabs.map((tab) => tab.conversationId)).toEqual([41, 42])
      expect(
        rawTabs.find((tab) => tab.id === activeTabId)?.conversationId
      ).toBe(42)
    } finally {
      cleanup()
      resetTabStore()
      resetFolderTabsStore()
      useAppWorkspaceStore.setState({ conversations: workspace.conversations })
    }
  })

  it("renders short content with no toggle", () => {
    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    expect(screen.getByText("hello world")).toBeInTheDocument()
    expect(
      screen.queryByTestId("collapsible-user-message-toggle")
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId("collapsible-user-message-content")
    ).not.toHaveClass("collapsed-content-fade")
  })

  it("renders the session source and receipt time separately from the message", () => {
    const timestamp = "2026-01-01T12:34:56Z"
    renderWithIntl(
      <CollapsibleUserMessage
        timestamp={timestamp}
        parts={[
          {
            type: "text",
            text: "[Codeg message from conversation 42]\n\nhello",
          },
        ]}
      />
    )
    const source = screen.getByText("Conversation #42")
    expect(source.parentElement?.querySelector("time")).toHaveAttribute(
      "datetime",
      timestamp
    )
    expect(screen.getByText("hello")).toBeInTheDocument()
    expect(screen.queryByText(/Codeg message from/)).not.toBeInTheDocument()
  })

  it("shows a Show more toggle when content overflows the collapsed height", () => {
    restoreMetrics = mockClampLayout(600, 240)

    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    const content = screen.getByTestId("collapsible-user-message-content")
    const toggle = screen.getByTestId("collapsible-user-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
    expect(toggle).toHaveAttribute("aria-controls", content.id)
    expect(content).toHaveClass("max-h-60", "collapsed-content-fade")
  })

  it("comes back with its toggle when it mounts again", () => {
    // The thread is virtualized: scrolled away and back, a message mounts
    // again, and drawing it without its toggle until it is measured would
    // change its height under the list.
    const parts: AdaptedContentPart[] = [{ type: "text", text: "a long ask" }]
    restoreMetrics = mockClampLayout(600, 240)
    const first = renderWithIntl(<CollapsibleUserMessage parts={parts} />)
    expect(screen.getByTestId("collapsible-user-message-toggle")).toBeTruthy()
    first.unmount()
    restoreMetrics()
    // No layout this time (the observer has not reported yet).
    restoreMetrics = null

    renderWithIntl(<CollapsibleUserMessage parts={parts} />)
    expect(screen.getByTestId("collapsible-user-message-toggle")).toBeTruthy()
    expect(screen.getByTestId("collapsible-user-message-content")).toHaveClass(
      "collapsed-content-fade"
    )
  })

  it("starts other content unmeasured", () => {
    renderWithIntl(
      <CollapsibleUserMessage parts={[{ type: "text", text: "another" }]} />
    )
    expect(
      screen.queryByTestId("collapsible-user-message-toggle")
    ).not.toBeInTheDocument()
  })

  it("expands to Show less on click and removes the clamp", () => {
    restoreMetrics = mockClampLayout(600, 240)

    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    fireEvent.click(screen.getByTestId("collapsible-user-message-toggle"))

    const toggle = screen.getByTestId("collapsible-user-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Show less")
    const content = screen.getByTestId("collapsible-user-message-content")
    expect(content).not.toHaveClass("max-h-60")
    expect(content).not.toHaveClass("collapsed-content-fade")

    // Clicking again re-collapses.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
  })
})

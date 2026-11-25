import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"
import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import {
  publishTranscriptInsights,
  retractTranscriptInsights,
  useTranscriptInsightsStore,
  type TranscriptInsights,
  type TranscriptInsightsActions,
} from "@/stores/transcript-insights-store"

// The real host pulls in every viewer drawer; none is opened here.
vi.mock("@/components/message/session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openFilePreview: vi.fn(),
    openSessionFileDiff: vi.fn(),
  }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}))
const { mockAsks, mockDetach } = vi.hoisted(() => ({
  mockAsks: vi.fn<(parentId: number | null, kind: string) => unknown>(
    () => null
  ),
  mockDetach: vi.fn(),
}))
vi.mock("@/hooks/use-ask-conversations", () => ({
  useLinkedConversations: (parentId: number | null, kind: string) =>
    mockAsks(parentId, kind),
}))
vi.mock("@/components/conversations/use-detach-ask-conversation", () => ({
  useDetachAskConversation: () => mockDetach,
}))

import { useAskConversationDrawerStore } from "@/stores/ask-conversation-drawer-store"
import { SessionDetailsInsights } from "./session-details-insights"

const CONVERSATION = 7

function makeActions(): TranscriptInsightsActions {
  return {
    selectNavEntry: vi.fn(),
    retryEarlierNav: vi.fn(),
  }
}

function navEntry(turnId: string, ordinal: number): MessageNavEntry {
  return {
    threadIndex: ordinal,
    turnIndex: null,
    turnId,
    ordinal,
    label: `message ${ordinal}`,
    additions: 0,
    deletions: 0,
    files: [],
    subAgents: [],
    hasChanges: false,
  }
}

function insights(
  over: {
    nav?: Partial<TranscriptInsights["nav"]>
    plan?: Partial<TranscriptInsights["plan"]>
    actions?: TranscriptInsightsActions
  } = {}
): TranscriptInsights {
  return {
    nav: {
      count: 0,
      entries: [],
      earlier: null,
      revealingTurnId: null,
      currentTurnId: null,
      running: null,
      ...over.nav,
    },
    plan: { entries: [], streaming: false, ...over.plan },
    actions: over.actions ?? makeActions(),
  }
}

function publish(value: TranscriptInsights) {
  act(() => publishTranscriptInsights(CONVERSATION, "transcript", value))
}

function panel(active = true, conversationId = CONVERSATION) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionDetailsInsights
        conversationId={conversationId}
        dbConversationId={null}
        active={active}
      />
    </NextIntlClientProvider>
  )
}

function renderPanel(active = true) {
  return render(panel(active))
}

function navDemand(): number {
  return useTranscriptInsightsStore.getState().navDemand.get(CONVERSATION) ?? 0
}

beforeEach(() => {
  localStorage.clear()
  mockAsks.mockReset()
  mockAsks.mockReturnValue(null)
  mockDetach.mockReset()
})

afterEach(() => {
  cleanup()
  act(() => {
    retractTranscriptInsights(CONVERSATION, "transcript")
    useTranscriptInsightsStore.setState({
      byConversationId: new Map(),
      navDemand: new Map(),
    })
  })
})

describe("SessionDetailsInsights", () => {
  it("shows nothing while the transcript has published nothing", () => {
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it("shows nothing while there is no plan or message", () => {
    publish(insights())
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  describe("plan", () => {
    const plan = {
      entries: [
        { content: "Read the code", status: "completed", priority: "high" },
        { content: "Write the fix", status: "in_progress", priority: "low" },
      ],
      streaming: true,
    }

    /** The progress bar's segments, by the status each stands for. */
    function segments(): (string | null)[] {
      return Array.from(document.querySelectorAll("[data-plan-segment]")).map(
        (segment) => segment.getAttribute("data-plan-segment")
      )
    }

    it("lists the plan under its progress, a segment per step", () => {
      publish(insights({ plan }))
      renderPanel()
      const header = screen.getByRole("button", { name: /Agent Plan/ })
      expect(header).toHaveAttribute("aria-expanded", "true")
      expect(header).toHaveTextContent("1/2")
      expect(segments()).toEqual(["completed", "in_progress"])
      expect(screen.getByText("Read the code")).toBeInTheDocument()
      expect(screen.getByText("Write the fix")).toBeInTheDocument()
      // The whole step, and where it stands, on hover.
      expect(screen.getByText("Write the fix").closest("li")).toHaveAttribute(
        "title",
        "Write the fix\nIn Progress · Low"
      )
    })

    it("still shows its progress and the step under way when collapsed", () => {
      publish(insights({ plan }))
      renderPanel()
      fireEvent.click(screen.getByRole("button", { name: /Agent Plan/ }))
      expect(segments()).toEqual(["completed", "in_progress"])
      expect(screen.queryByText("Read the code")).not.toBeInTheDocument()
      expect(screen.getByText("Write the fix")).toBeInTheDocument()
    })

    it("collapses, and stays collapsed for the next panel", () => {
      publish(insights({ plan }))
      const { unmount } = renderPanel()
      fireEvent.click(screen.getByRole("button", { name: /Agent Plan/ }))
      expect(screen.queryByText("Read the code")).not.toBeInTheDocument()
      unmount()
      renderPanel()
      expect(
        screen.getByRole("button", { name: /Agent Plan/ })
      ).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText("Read the code")).not.toBeInTheDocument()
    })

    it("follows a plan that changes while it shows", () => {
      publish(insights({ plan }))
      renderPanel()
      publish(
        insights({
          plan: {
            ...plan,
            entries: [
              plan.entries[0],
              { ...plan.entries[1], status: "completed" },
            ],
          },
        })
      )
      expect(
        screen.getByRole("button", { name: /Agent Plan/ })
      ).toHaveTextContent("2/2")
    })
  })

  describe("ask conversations", () => {
    const PARENT = 70
    const ask = {
      id: 71,
      folder_id: 1,
      title: "What does this do?",
      title_locked: false,
      agent_type: "codex",
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 2,
      child_count: 0,
      created_at: "2026-11-25T10:00:00.000Z",
      updated_at: "2026-11-25T10:00:00.000Z",
      pinned_at: null,
      parent_id: PARENT,
    } as unknown as DbConversationSummary

    function renderAsks() {
      mockAsks.mockImplementation((id, kind) =>
        id === PARENT && kind === "ask" ? [ask] : null
      )
      return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <SessionDetailsInsights
            conversationId={CONVERSATION}
            dbConversationId={PARENT}
            active
          />
        </NextIntlClientProvider>
      )
    }

    it("puts the agent's icon in the header icon's column, its status a dot on it", () => {
      renderAsks()
      const row = screen.getByText("What does this do?").closest("li")!
      const icon = within(row).getByTestId("agent-icon")
      // The icon's column is the first thing in the row, as the header's is.
      const column = icon.closest("span.w-7")!
      expect(column).toHaveAttribute("aria-hidden", "true")
      expect(column.nextElementSibling).toHaveTextContent("What does this do?")
      // The status rides the icon's corner.
      const dot = icon.parentElement!.querySelector(".absolute.rounded-full")
      expect(dot).not.toBeNull()
      expect(dot).toHaveClass("motion-safe:animate-pulse")
    })

    it("offers converting only, and asks before it does", () => {
      renderAsks()
      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument()
      fireEvent.click(
        screen.getByRole("button", { name: "Convert to normal conversation" })
      )
      const dialog = screen.getByRole("alertdialog")
      expect(dialog).toHaveTextContent("What does this do?")
      expect(mockDetach).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole("button", { name: "Convert" }))
      expect(mockDetach).toHaveBeenCalledWith(71)
    })

    it("drops a pending confirmation when another conversation takes the panel", () => {
      const other = { ...ask, id: 81, parent_id: 80 } as DbConversationSummary
      const { rerender } = renderAsks()
      mockAsks.mockImplementation((id, kind) =>
        kind !== "ask"
          ? null
          : id === PARENT
            ? [ask]
            : id === 80
              ? [other]
              : null
      )
      fireEvent.click(
        screen.getByRole("button", { name: "Convert to normal conversation" })
      )
      expect(screen.getByRole("alertdialog")).toBeInTheDocument()
      const at = (parent: number) => (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <SessionDetailsInsights
            conversationId={CONVERSATION}
            dbConversationId={parent}
            active
          />
        </NextIntlClientProvider>
      )
      rerender(at(80))
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      // Nor does it come back with the first conversation.
      rerender(at(PARENT))
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      expect(mockDetach).not.toHaveBeenCalled()
    })

    it("converts nothing when the dialog is cancelled", () => {
      renderAsks()
      fireEvent.click(
        screen.getByRole("button", { name: "Convert to normal conversation" })
      )
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Cancel",
        })
      )
      expect(mockDetach).not.toHaveBeenCalled()
    })
  })

  describe("check conversations", () => {
    const PARENT = 70
    const check = {
      id: 91,
      folder_id: 1,
      title: "Check: the cache is cleared on save",
      title_locked: true,
      agent_type: "codex",
      status: "completed",
      kind: "check",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 2,
      child_count: 0,
      created_at: "2026-11-25T10:00:00.000Z",
      updated_at: "2026-11-25T10:00:00.000Z",
      pinned_at: null,
      parent_id: PARENT,
    } as unknown as DbConversationSummary

    function renderChecks() {
      mockAsks.mockImplementation((id, kind) =>
        id === PARENT && kind === "check" ? [check] : null
      )
      return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <SessionDetailsInsights
            conversationId={CONVERSATION}
            dbConversationId={PARENT}
            active
          />
        </NextIntlClientProvider>
      )
    }

    afterEach(() => {
      act(() => useAskConversationDrawerStore.setState({ target: null }))
    })

    it("lists the checks in a card of their own", () => {
      renderChecks()
      const header = screen.getByRole("button", {
        name: /Check conversations/,
      })
      expect(header).toHaveTextContent("1 conversation")
      expect(
        screen.getByText("Check: the cache is cleared on save")
      ).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: /Ask conversations/ })
      ).not.toBeInTheDocument()
    })

    it("opens a check in the drawer, as a check", () => {
      renderChecks()
      fireEvent.click(screen.getByText("Check: the cache is cleared on save"))
      expect(useAskConversationDrawerStore.getState().target).toMatchObject({
        kind: "check",
        parentConversationId: PARENT,
        conversationId: 91,
        agentType: "codex",
        folderId: 1,
      })
    })

    it("converts a check only once confirmed", () => {
      renderChecks()
      fireEvent.click(
        screen.getByRole("button", { name: "Convert to normal conversation" })
      )
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Convert",
        })
      )
      expect(mockDetach).toHaveBeenCalledWith(91)
    })
  })

  describe("message navigator", () => {
    const nav = {
      count: 2,
      entries: [navEntry("u1", 1), navEntry("u2", 2)],
    }

    it("asks the transcript for its rows while they show", () => {
      publish(insights({ nav }))
      const { unmount } = renderPanel()
      expect(navDemand()).toBe(1)
      unmount()
      expect(navDemand()).toBe(0)
    })

    it("doesn't ask while the panel is hidden", () => {
      publish(insights({ nav }))
      renderPanel(false)
      expect(navDemand()).toBe(0)
      // Still listed, by count, for when it shows.
      expect(
        screen.getByRole("button", { name: /Message navigation/ })
      ).toHaveTextContent("2")
    })

    it("stops asking once collapsed", () => {
      publish(insights({ nav }))
      renderPanel()
      fireEvent.click(
        screen.getByRole("button", { name: /Message navigation/ })
      )
      expect(navDemand()).toBe(0)
      expect(screen.queryByText("message 1")).not.toBeInTheDocument()
    })

    it("jumps to a message through the transcript", () => {
      const actions = makeActions()
      publish(insights({ nav, actions }))
      renderPanel()
      fireEvent.click(screen.getByText("message 2"))
      expect(actions.selectNavEntry).toHaveBeenCalledWith(nav.entries[1])
    })

    it("highlights the message the transcript shows", () => {
      publish(insights({ nav: { ...nav, currentTurnId: "u2" } }))
      renderPanel()
      expect(screen.getByText("message 2").closest("button")).toHaveAttribute(
        "aria-current",
        "location"
      )
    })

    it("opens another conversation's messages its own way", () => {
      const withFiles = (turnId: string, ordinal: number): MessageNavEntry => ({
        ...navEntry(turnId, ordinal),
        additions: 1,
        files: [
          {
            id: `${turnId}-f`,
            path: `/repo/${turnId}.ts`,
            additions: 1,
            deletions: 0,
            diff: null,
          },
        ],
        hasChanges: true,
      })
      const entries = [withFiles("u1", 1), withFiles("u2", 2)]
      const latest = () => screen.getByText("message 2").closest("button")!
      publish(insights({ nav: { count: 2, entries } }))
      const view = render(panel(true, CONVERSATION))
      expect(latest()).toHaveAttribute("aria-expanded", "true")
      fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
      expect(latest()).toHaveAttribute("aria-expanded", "false")

      // Turn ids repeat across conversations; what was closed doesn't.
      act(() =>
        publishTranscriptInsights(
          8,
          "other",
          insights({ nav: { count: 2, entries } })
        )
      )
      view.rerender(panel(true, 8))
      expect(latest()).toHaveAttribute("aria-expanded", "true")
      act(() => retractTranscriptInsights(8, "other"))
    })

    it("is absent, and asks nothing, while there are no messages", () => {
      publish(insights({ nav: { count: 0, entries: [] } }))
      renderPanel()
      expect(
        screen.queryByRole("button", { name: /Message navigation/ })
      ).not.toBeInTheDocument()
      expect(navDemand()).toBe(0)
    })
  })

  it("lists the plan, then the messages", () => {
    publish(
      insights({
        plan: {
          entries: [{ content: "step", status: "pending", priority: "low" }],
        },
        nav: { count: 1, entries: [navEntry("u1", 1)] },
      })
    )
    renderPanel()
    const headers = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
    expect(headers).toEqual([
      expect.stringContaining("Agent Plan"),
      expect.stringContaining("Message navigation"),
    ])
  })

  it("hands the navigator the message the agent is answering", () => {
    publish(
      insights({
        nav: {
          count: 2,
          entries: [navEntry("u1", 1), navEntry("u2", 2)],
          running: { turnId: "u2", startedAt: null },
        },
      })
    )
    renderPanel()
    const running = screen.getByTestId("nav-running")
    expect(running).toHaveTextContent("message 2")
    expect(running).toHaveTextContent("Running")
  })

  // The icon on the rows' left column, so each title lines up with the
  // rows' text; the chevron that folds the section at the header's end.
  it("heads a section with its icon and ends it with a chevron", () => {
    publish(
      insights({
        plan: {
          entries: [{ content: "step", status: "pending", priority: "low" }],
        },
        nav: { count: 1, entries: [navEntry("u1", 1)] },
      })
    )
    renderPanel()
    for (const title of ["Agent Plan", "Message navigation"]) {
      const header = screen.getByRole("button", { name: new RegExp(title) })
      const icons = header.querySelectorAll("svg")
      const label = within(header).getByText(title)
      // In the title's colour, not the theme's.
      expect(icons[0].parentElement).toHaveClass("text-foreground")
      expect(label).toHaveClass("text-foreground")
      expect(
        icons[0].compareDocumentPosition(label) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      const chevron = icons[icons.length - 1]
      expect(chevron).toHaveClass("lucide-chevron-down")
      expect(
        label.compareDocumentPosition(chevron) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  // Folded it points along the header; open, down at what the section shows.
  it("turns the chevron down once the section opens", () => {
    publish(insights({ nav: { count: 1, entries: [navEntry("u1", 1)] } }))
    renderPanel()
    const header = screen.getByRole("button", { name: /Message navigation/ })
    const chevron = () => {
      const icons = header.querySelectorAll("svg")
      return icons[icons.length - 1]
    }
    const wasOpen = header.getAttribute("aria-expanded") === "true"
    expect(chevron().classList.contains("-rotate-90")).toBe(!wasOpen)
    fireEvent.click(header)
    expect(header).toHaveAttribute("aria-expanded", String(!wasOpen))
    expect(chevron().classList.contains("-rotate-90")).toBe(wasOpen)
  })
})

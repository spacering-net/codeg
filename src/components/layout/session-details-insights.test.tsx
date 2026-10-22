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
      <SessionDetailsInsights conversationId={conversationId} active={active} />
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

  // On the rows' left column, so each title lines up with the rows' text.
  it("puts the chevron that folds a section before its title", () => {
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
      const chevron = header.querySelector("svg")
      expect(chevron).not.toBeNull()
      expect(
        chevron!.compareDocumentPosition(within(header).getByText(title)) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })
})

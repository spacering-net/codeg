import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  ConversationMessageNav,
  type MessageNavEntry,
} from "./conversation-message-nav"

// Stable `t` (per next-intl mock guidance) — returns the key verbatim, plus the
// `count` it was given (`collapsedSummary:3`), so a label that shows a count is
// checked for the right one.
const { stableT, mockOpenDiff } = vi.hoisted(() => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values && "count" in values ? `${key}:${String(values.count)}` : key
  return { stableT: t, mockOpenDiff: vi.fn() }
})

vi.mock("next-intl", () => ({ useTranslations: () => stableT }))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openSessionFileDiff: mockOpenDiff }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))

const DELETION_DIFF = "*** Delete File: old.ts\n-a\n-b\n-c\n-d"

const entries: MessageNavEntry[] = [
  {
    threadIndex: 0,
    turnIndex: null,
    turnId: "u1",
    ordinal: 1,
    label: "first message",
    additions: 0,
    deletions: 0,
    files: [],
    hasChanges: false,
  },
  {
    // One-sided change: additions only — the -0 must still render.
    threadIndex: 3,
    turnIndex: null,
    turnId: "u2",
    ordinal: 2,
    label: "edit something",
    additions: 5,
    deletions: 0,
    files: [
      {
        id: "f1",
        path: "/repo/src/a.ts",
        additions: 5,
        deletions: 0,
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+new",
      },
    ],
    hasChanges: true,
  },
  {
    // Deleted file — must remain clickable to open its deletion diff.
    threadIndex: 6,
    turnIndex: null,
    turnId: "u3",
    ordinal: 3,
    label: "delete a file",
    additions: 0,
    deletions: 4,
    files: [
      {
        id: "f2",
        path: "/repo/old.ts",
        additions: 0,
        deletions: 4,
        diff: DELETION_DIFF,
      },
    ],
    hasChanges: true,
  },
]

/** A message above the loaded window: listed, but not rendered yet. */
const earlierEntry: MessageNavEntry = {
  threadIndex: null,
  turnIndex: 12,
  turnId: "turn-12",
  ordinal: 1,
  label: "an early message",
  additions: 0,
  deletions: 0,
  files: [],
  hasChanges: false,
}

describe("ConversationMessageNav", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders nothing when there are no user messages", () => {
    const { container } = render(
      <ConversationMessageNav
        count={0}
        expanded={false}
        onToggle={vi.fn()}
        entries={[]}
        onSelect={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("collapsed: shows the count chip and expands on click", () => {
    const onToggle = vi.fn()
    render(
      <ConversationMessageNav
        count={3}
        expanded={false}
        onToggle={onToggle}
        entries={[]}
        onSelect={vi.fn()}
      />
    )
    // No card while collapsed.
    expect(screen.queryByText("title")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "collapsedSummary:3" }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("expanded: clicking a message selects its entry", () => {
    const onSelect = vi.fn()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByText("edit something"))
    expect(onSelect).toHaveBeenCalledWith(entries[1])
  })

  it("selects a message above the loaded window like any other", () => {
    const onSelect = vi.fn()
    render(
      <ConversationMessageNav
        count={4}
        expanded
        onToggle={vi.fn()}
        entries={[earlierEntry, ...entries]}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByText("an early message"))
    expect(onSelect).toHaveBeenCalledWith(earlierEntry)
  })

  it("marks the message being paged in as busy", () => {
    render(
      <ConversationMessageNav
        count={4}
        expanded
        onToggle={vi.fn()}
        entries={[earlierEntry, ...entries]}
        onSelect={vi.fn()}
        revealingTurnId="turn-12"
      />
    )
    const revealing = screen.getByText("an early message").closest("button")
    expect(revealing).toHaveAttribute("aria-busy", "true")
    const other = screen.getByText("first message").closest("button")
    expect(other).not.toHaveAttribute("aria-busy")
  })

  it("says so while the messages above the window are loading", () => {
    render(
      <ConversationMessageNav
        count={5}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={vi.fn()}
        earlier="loading"
      />
    )
    expect(screen.getByText("loadingEarlier")).toBeInTheDocument()
    expect(screen.queryByText("loadEarlier")).not.toBeInTheDocument()
  })

  it("offers a retry when the messages above the window failed to load", () => {
    const onRetryEarlier = vi.fn()
    render(
      <ConversationMessageNav
        count={5}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={vi.fn()}
        earlier="error"
        onRetryEarlier={onRetryEarlier}
      />
    )
    expect(screen.queryByText("loadingEarlier")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "loadEarlier" }))
    expect(onRetryEarlier).toHaveBeenCalledTimes(1)
  })

  it("expanded: the header collapse button collapses the panel", () => {
    const onToggle = vi.fn()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={onToggle}
        entries={entries}
        onSelect={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "collapse" }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it("always shows both +N and -N, including a zero side", () => {
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={vi.fn()}
      />
    )
    // u2 added 5, deleted 0 — both rendered.
    expect(screen.getByText("+5")).toBeInTheDocument()
    expect(screen.getByText("-0")).toBeInTheDocument()
    // u3 added 0, deleted 4 — both rendered.
    expect(screen.getByText("+0")).toBeInTheDocument()
    expect(screen.getByText("-4")).toBeInTheDocument()
    // Placeholder message still renders its label.
    expect(screen.getByText("first message")).toBeInTheDocument()
  })

  it("opens a file diff when a changed file is clicked", () => {
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={vi.fn()}
      />
    )
    // Expand u2's file list (first changed group).
    fireEvent.click(screen.getAllByRole("button", { name: /^fileCount:/ })[0])
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(mockOpenDiff).toHaveBeenCalledWith(
      "/repo/src/a.ts",
      "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+new",
      "msg-2-chg-1"
    )
  })

  it("opens the deletion diff when a deleted file is clicked", () => {
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        onSelect={vi.fn()}
      />
    )
    // Expand u3's file list (second changed group).
    fireEvent.click(screen.getAllByRole("button", { name: /^fileCount:/ })[1])
    fireEvent.click(screen.getByTitle("old.ts"))
    expect(mockOpenDiff).toHaveBeenCalledWith(
      "/repo/old.ts",
      DELETION_DIFF,
      "msg-3-chg-1"
    )
  })
})

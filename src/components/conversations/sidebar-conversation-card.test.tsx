import { type ReactElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest"

import { SidebarConversationCard } from "./sidebar-conversation-card"
import { formatRelative } from "./sidebar-conversation-grouping"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import {
  ATTACH_SESSION_TO_SESSION_EVENT,
  type AttachSessionToSessionDetail,
} from "@/lib/session-attachment-events"
import type { DbConversationSummary } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// AgentIcon renders exactly once per card body execution, so counting its
// renders counts how many cards actually re-rendered (a card that bails out via
// memo never re-runs its body, hence never re-renders AgentIcon). Cheap leaf →
// easy, unambiguous render probe.
const probe = vi.hoisted(() => ({ agentIconRenders: 0 }))
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => {
    probe.agentIconRenders++
    return null
  },
}))

const MINUTE = 60_000
const NOW = 1_700_000_000_000

// Stable callback identities shared across renders — the production list hands
// memoized callbacks down, so the test must too.
const onSelect = vi.fn()
const onDoubleClick = vi.fn()
const onRename = vi.fn(async () => {})
const onDelete = vi.fn(async () => {})
const onStatusChange = vi.fn(async () => {})
const onTogglePin = vi.fn()

function conv(id: number): DbConversationSummary {
  // 5 minutes ago → label "5m"; one extra minute later it ages to "6m".
  const createdAt = new Date(NOW - 5 * MINUTE).toISOString()
  return {
    id,
    folder_id: 1,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    pinned_at: null,
  }
}

function CardList({
  conversations,
  now,
  select = onSelect,
}: {
  conversations: DbConversationSummary[]
  now: number
  select?: (id: number, agentType: string, folderId: number) => void
}) {
  return (
    <>
      {conversations.map((c) => (
        <SidebarConversationCard
          key={c.id}
          conversation={c}
          isSelected={false}
          isOpenInTab={false}
          timeLabel={formatRelative(c.created_at, now)}
          onSelect={select}
          onDoubleClick={onDoubleClick}
          onRename={onRename}
          onDelete={onDelete}
          onStatusChange={onStatusChange}
        />
      ))}
    </>
  )
}

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const BASE = [conv(1), conv(2), conv(3), conv(4), conv(5)]

describe("SidebarConversationCard memo (sidebar perf Phase 1 gate)", () => {
  beforeEach(() => {
    probe.agentIconRenders = 0
  })

  it("re-renders only the card whose summary object changed", () => {
    const { rerender } = renderWithIntl(
      <CardList conversations={BASE} now={NOW} />
    )

    // Control: an identical re-render must bail out for every card.
    probe.agentIconRenders = 0
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CardList conversations={BASE} now={NOW} />
      </NextIntlClientProvider>
    )
    expect(probe.agentIconRenders).toBe(0)

    // Replace exactly one summary (new object ref) — mirrors a single
    // `conversation_status_changed` patch in updateConversationLocal.
    const next = BASE.slice()
    next[2] = { ...BASE[2], status: "completed" }

    probe.agentIconRenders = 0
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CardList conversations={next} now={NOW} />
      </NextIntlClientProvider>
    )
    expect(probe.agentIconRenders).toBe(1)
  })

  it("re-renders all cards (only) once per minute as the shared now advances", () => {
    const { rerender } = renderWithIntl(
      <CardList conversations={BASE} now={NOW} />
    )

    // Advancing the shared `now` past a unit boundary ages every label
    // "5m" → "6m", so every card re-renders — but just this once. This is the
    // bounded cost that justifies threading a single `now` instead of letting
    // each row read Date.now() on every unrelated render.
    probe.agentIconRenders = 0
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CardList conversations={BASE} now={NOW + MINUTE} />
      </NextIntlClientProvider>
    )
    expect(probe.agentIconRenders).toBe(BASE.length)
  })

  it("re-renders every card when callback identity is unstable (defeats memo)", () => {
    const { rerender } = renderWithIntl(
      <CardList conversations={BASE} now={NOW} select={() => {}} />
    )

    // A fresh onSelect each render is exactly the R1b regression: stable
    // conversations + stable now, yet every card re-renders.
    probe.agentIconRenders = 0
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CardList conversations={BASE} now={NOW} select={() => {}} />
      </NextIntlClientProvider>
    )
    expect(probe.agentIconRenders).toBe(BASE.length)
  })
})

describe("SidebarConversationCard pin action", () => {
  beforeEach(() => {
    onTogglePin.mockClear()
  })

  function renderCard(c: DbConversationSummary) {
    return renderWithIntl(
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel=""
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
        onTogglePin={onTogglePin}
      />
    )
  }

  it("offers Pin for an unpinned conversation and requests pinning", () => {
    const { getByText } = renderCard(conv(1)) // pinned_at: null
    fireEvent.contextMenu(getByText("conv-1"))
    fireEvent.click(getByText("Pin"))
    expect(onTogglePin).toHaveBeenCalledWith(1, true)
  })

  it("offers Unpin for a pinned conversation and requests unpinning", () => {
    const pinned: DbConversationSummary = {
      ...conv(2),
      pinned_at: new Date(NOW).toISOString(),
    }
    const { getByText } = renderCard(pinned)
    fireEvent.contextMenu(getByText("conv-2"))
    fireEvent.click(getByText("Unpin"))
    expect(onTogglePin).toHaveBeenCalledWith(2, false)
  })
})

// The hover-reveal icon buttons live in the row's right slot as siblings of the
// clickable row button (never nested). They carry only an aria-label (icon, no
// text), so getByLabelText addresses them unambiguously — distinct from the
// context-menu items, which are matched by getByText. CSS hides them until
// hover, but fireEvent dispatches directly on the node regardless of
// pointer-events, so the wiring is testable without a real pointer.
describe("SidebarConversationCard hover quick actions", () => {
  beforeEach(() => {
    onTogglePin.mockClear()
    onStatusChange.mockClear()
  })

  function renderCard(
    c: DbConversationSummary,
    { withPin = true }: { withPin?: boolean } = {}
  ) {
    return renderWithIntl(
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel="5m"
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
        onTogglePin={withPin ? onTogglePin : undefined}
      />
    )
  }

  it("pins an unpinned conversation via the hover pin button", () => {
    const { getByLabelText } = renderCard(conv(1)) // pinned_at: null
    fireEvent.click(getByLabelText("Pin"))
    expect(onTogglePin).toHaveBeenCalledWith(1, true)
  })

  it("unpins a pinned conversation via the hover pin button", () => {
    const pinned: DbConversationSummary = {
      ...conv(2),
      pinned_at: new Date(NOW).toISOString(),
    }
    const { getByLabelText } = renderCard(pinned)
    fireEvent.click(getByLabelText("Unpin"))
    expect(onTogglePin).toHaveBeenCalledWith(2, false)
  })

  it("marks an unfinished conversation completed via the hover done button", () => {
    const { getByLabelText } = renderCard(conv(3)) // status: pending
    fireEvent.click(getByLabelText("Mark as completed"))
    expect(onStatusChange).toHaveBeenCalledWith(3, "completed")
  })

  it("reopens a completed conversation via the hover done button", () => {
    const done: DbConversationSummary = { ...conv(4), status: "completed" }
    const { getByLabelText } = renderCard(done)
    fireEvent.click(getByLabelText("Reopen"))
    expect(onStatusChange).toHaveBeenCalledWith(4, "in_progress")
  })

  it("omits the pin button when onTogglePin is absent but keeps the done button", () => {
    const { queryByLabelText } = renderCard(conv(5), { withPin: false })
    expect(queryByLabelText("Pin")).toBeNull()
    expect(queryByLabelText("Mark as completed")).not.toBeNull()
  })

  it("hides both hover quick actions for a delegation sub-session (parent_id set)", () => {
    // A sub-session has a parent — pinning it to the root Pinned section or
    // hand-toggling its status doesn't fit, so neither hover button renders even
    // though onTogglePin is supplied.
    const child: DbConversationSummary = { ...conv(6), parent_id: 1 }
    const { queryByLabelText } = renderCard(child)
    expect(queryByLabelText("Pin")).toBeNull()
    expect(queryByLabelText("Unpin")).toBeNull()
    expect(queryByLabelText("Mark as completed")).toBeNull()
    expect(queryByLabelText("Reopen")).toBeNull()
  })
})

// "Add to session" mirrors the file tree's action: it drops an `@`-style mention
// of the right-clicked conversation into the ACTIVE conversation tab's composer,
// addressed by a window event the composer listens for. The target tab is read
// from the tab store when the menu opens (not subscribed), so each test seeds the
// store before firing the context menu.
describe("SidebarConversationCard add to session", () => {
  function tab(id: string, conversationId: number | null): TabItem {
    return {
      id,
      kind: "conversation",
      folderId: 1,
      conversationId,
      agentType: "claude_code",
      title: "tab",
      isPinned: false,
    }
  }

  function seedTabs(tabs: TabItem[], activeTabId: string | null) {
    useTabStore.setState({ tabs, activeTabId })
  }

  let events: AttachSessionToSessionDetail[]
  let listener: (event: Event) => void

  beforeEach(() => {
    events = []
    listener = (event: Event) => {
      events.push((event as CustomEvent<AttachSessionToSessionDetail>).detail)
    }
    window.addEventListener(ATTACH_SESSION_TO_SESSION_EVENT, listener)
    seedTabs([], null)
  })

  afterEach(() => {
    window.removeEventListener(ATTACH_SESSION_TO_SESSION_EVENT, listener)
    seedTabs([], null)
  })

  function renderCard(c: DbConversationSummary) {
    return renderWithIntl(
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel="5m"
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
      />
    )
  }

  it("emits the mention for the active conversation tab", () => {
    seedTabs([tab("tab-1", 7), tab("tab-2", 9)], "tab-2")
    const target = conv(3)
    const { getByText } = renderCard(target)
    fireEvent.contextMenu(getByText("conv-3"))
    fireEvent.click(getByText("Add to session"))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe("tab-2")
    // The whole summary rides along so the composer can build the badge through
    // the same adapter the `@` panel uses.
    expect(events[0].conversation).toBe(target)
  })

  it("disables the item when no conversation tab is open", () => {
    seedTabs([], null)
    const { getByText } = renderCard(conv(4))
    fireEvent.contextMenu(getByText("conv-4"))
    const item = getByText("Add to session")
    expect(item.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(item)
    expect(events).toHaveLength(0)
  })

  it("allows mentioning the conversation the active tab already holds", () => {
    // Self-mention is permitted, matching the composer's own `@` panel — it
    // lists every session including the one being typed in.
    seedTabs([tab("tab-1", 5)], "tab-1")
    const { getByText } = renderCard(conv(5))
    fireEvent.contextMenu(getByText("conv-5"))
    const item = getByText("Add to session")
    expect(item.getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(item)
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe("tab-1")
  })

  // The open-time snapshot only drives the disabled state. `mod+tab` / `mod+w`
  // live on a document keydown handler that Radix lets modifier combos through
  // to, so the active tab CAN move under an open menu — the click must therefore
  // re-read the store rather than post to a stale (possibly closed) tab.
  it("re-resolves the target at click time when the active tab moved", () => {
    seedTabs([tab("tab-1", 7), tab("tab-2", 9)], "tab-1")
    const { getByText } = renderCard(conv(3))
    fireEvent.contextMenu(getByText("conv-3"))
    // Menu is open, snapshot says tab-1 — now the active tab moves under it.
    seedTabs([tab("tab-1", 7), tab("tab-2", 9)], "tab-2")
    fireEvent.click(getByText("Add to session"))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe("tab-2")
  })

  it("emits nothing when the target tab was closed under the open menu", () => {
    seedTabs([tab("tab-1", 7)], "tab-1")
    const { getByText } = renderCard(conv(3))
    fireEvent.contextMenu(getByText("conv-3"))
    seedTabs([], null)
    fireEvent.click(getByText("Add to session"))
    expect(events).toHaveLength(0)
  })

  it("stays enabled for an unsaved draft tab (no bound conversation yet)", () => {
    seedTabs([tab("tab-draft", null)], "tab-draft")
    const { getByText } = renderCard(conv(6))
    fireEvent.contextMenu(getByText("conv-6"))
    fireEvent.click(getByText("Add to session"))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe("tab-draft")
  })
})

describe("SidebarConversationCard sub-session chevron", () => {
  const onToggleExpand = vi.fn()
  beforeEach(() => {
    onToggleExpand.mockClear()
    onSelect.mockClear()
  })

  function renderCard(
    c: DbConversationSummary,
    props: { hasChildren?: boolean; expanded?: boolean; depth?: number } = {}
  ) {
    return renderWithIntl(
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel="5m"
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
        onToggleExpand={onToggleExpand}
        hasChildren={props.hasChildren}
        expanded={props.expanded}
        depth={props.depth}
      />
    )
  }

  it("renders no chevron when the conversation has no children", () => {
    const { queryByLabelText } = renderCard(conv(1), { hasChildren: false })
    expect(queryByLabelText("Expand sub-conversations")).toBeNull()
    expect(queryByLabelText("Collapse sub-conversations")).toBeNull()
  })

  it("renders an Expand chevron for a collapsed parent and toggles without selecting", () => {
    const { getByLabelText } = renderCard(conv(1), {
      hasChildren: true,
      expanded: false,
    })
    fireEvent.click(getByLabelText("Expand sub-conversations"))
    expect(onToggleExpand).toHaveBeenCalledWith(1)
    // The chevron is a sibling button with stopPropagation — a toggle must not
    // also select the row.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("renders a Collapse chevron when the subtree is expanded", () => {
    const { getByLabelText, queryByLabelText } = renderCard(conv(2), {
      hasChildren: true,
      expanded: true,
    })
    expect(getByLabelText("Collapse sub-conversations")).not.toBeNull()
    expect(queryByLabelText("Expand sub-conversations")).toBeNull()
  })

  it("overlays the chevron on the rail axis (the agent-icon position)", () => {
    const { getByLabelText } = renderCard(conv(2), {
      hasChildren: true,
      expanded: false,
    })
    // The chevron now sits at the agent-icon's rail-axis x (revealed on hover),
    // not in the right-hand time/action slot.
    const chevron = getByLabelText("Expand sub-conversations")
    expect(chevron.style.left).toContain("--conv-rail-axis")
  })

  it("indents deeper rows by CONV_RAIL_DEPTH_STEP per level so the child icon aligns under the parent title", () => {
    const { container } = renderCard(conv(3), { hasChildren: false, depth: 2 })
    const outer = container.querySelector("[data-conv-key]") as HTMLElement
    // 0.875rem root axis + depth · 1.25rem (gap 0.875 + half glyph 0.375) lands
    // the child icon glyph's left edge under the parent title text start.
    expect(outer.style.getPropertyValue("--conv-rail-axis")).toBe(
      "calc(0.875rem + 2 * 1.25rem)"
    )
  })

  it("draws one ancestor guide rail per nesting level so the child rail aligns under its parent", () => {
    const { container } = renderCard(conv(4), { depth: 3 })
    expect(container.querySelectorAll("[data-subsession-rail]")).toHaveLength(3)
  })

  it("draws no ancestor guide rails for a root row", () => {
    const { container } = renderCard(conv(5), { depth: 0 })
    expect(container.querySelectorAll("[data-subsession-rail]")).toHaveLength(0)
  })
})

// The row truncates to one line and never says where the session lives, so
// resting the pointer on it floats a read-only bubble out to the right with the
// folder, its absolute path, and the branch. Radix portals the content to the
// body, hence the `screen` queries.
describe("SidebarConversationCard hover details bubble", () => {
  const FOLDER_PATH = "/Users/dev/projects/codeg"

  function renderCard(c: DbConversationSummary) {
    return renderWithIntl(
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel="5m"
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
      />
    )
  }

  function rowOf(container: HTMLElement): HTMLElement {
    return container.querySelector("[data-conv-key]") as HTMLElement
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      allFolders: [
        {
          id: 1,
          name: "codeg",
          path: FOLDER_PATH,
          git_branch: null,
          default_agent_type: null,
          last_opened_at: new Date(NOW).toISOString(),
          sort_order: 0,
          color: "inherit",
          parent_id: null,
          kind: "regular",
          alias: null,
          group_id: null,
        },
      ],
    })
  })

  afterEach(() => {
    // Unmount before resetting: the reset is a zustand write, and a bubble still
    // mounted when it lands would re-render outside `act()`.
    cleanup()
    resetAppWorkspaceStore()
    vi.useRealTimers()
  })

  it("opens on pointer enter, but only after the open delay", () => {
    const { container } = renderCard(conv(1))
    fireEvent.pointerEnter(rowOf(container), { pointerType: "mouse" })

    // Sweeping the pointer down the list must stay quiet, so nothing yet.
    expect(screen.queryByText(FOLDER_PATH)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.getByText(FOLDER_PATH)).toBeDefined()
    expect(screen.getByText("codeg")).toBeDefined()
  })

  // Companion to the `select-none` pin in the content's own test: with the
  // bubble unpointable, a press always lands outside it and the dismissable
  // layer tears it down before Radix can latch onto a stray document selection
  // and refuse to ever close. jsdom models neither selections nor hit-testing,
  // so this pins the CSS contract; the behaviour was verified in a real browser.
  it("renders the bubble inert to the pointer", () => {
    const { container } = renderCard(conv(1))
    fireEvent.pointerEnter(rowOf(container), { pointerType: "mouse" })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    const content = document.querySelector('[data-slot="hover-card-content"]')
    expect(content?.className).toContain("pointer-events-none")
  })

  it("closes again once the pointer leaves", () => {
    const { container } = renderCard(conv(1))
    const row = rowOf(container)
    fireEvent.pointerEnter(row, { pointerType: "mouse" })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.getByText(FOLDER_PATH)).toBeDefined()

    fireEvent.pointerLeave(row, { pointerType: "mouse" })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByText(FOLDER_PATH)).toBeNull()
  })

  // Radix's trigger opens on ANY focus, and its touch filter covers only
  // pointer enter/leave. Tapping a row focuses the button inside it, so without
  // the `isKeyboardFocus` guard a tap would strand a bubble on screen with no
  // pointer that could ever leave and dismiss it.
  it("does not open on a non-keyboard focus", () => {
    const { container } = renderCard(conv(1))
    const focusIn = new FocusEvent("focusin", {
      bubbles: true,
      cancelable: true,
    })
    rowOf(container).dispatchEvent(focusIn)

    // The card's guard default-prevents, which is what makes Radix's composed
    // handler bail — asserting it here keeps the "stays closed" check below from
    // passing vacuously (i.e. because the event never reached React at all).
    expect(focusIn.defaultPrevented).toBe(true)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByText(FOLDER_PATH)).toBeNull()
  })

  it("drops the bubble when the context menu takes the row over", () => {
    const { container } = renderCard(conv(1))
    const row = rowOf(container)
    fireEvent.pointerEnter(row, { pointerType: "mouse" })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.getByText(FOLDER_PATH)).toBeDefined()

    fireEvent.contextMenu(row)
    expect(screen.queryByText(FOLDER_PATH)).toBeNull()
  })

  // NOT covered here: touch. Radix's `excludeTouch` drops enter/leave whose
  // `pointerType === "touch"`, so a tap never strands a bubble on screen — but
  // jsdom ships no `PointerEvent`, so every synthetic pointer event arrives as a
  // `MouseEvent` with `pointerType: undefined` and the branch can't be reached.
  // Verify that one in a real browser, not here.
})

describe("SidebarConversationCard tag chips", () => {
  beforeEach(() => {
    resetConversationTagsStore()
    probe.agentIconRenders = 0
    const store = useConversationTagsStore.getState()
    for (const [id, name] of [
      [1, "bug"],
      [2, "idea"],
      [3, "ui"],
    ] as const) {
      store.applyChange({
        kind: "upsert",
        tag: { id, folder_id: null, name, color: "#cf222e", sort_order: id },
      })
    }
  })

  it("draws two chips, folds the rest into +N, and skips unknown tags", () => {
    const tagged = { ...conv(1), tag_ids: [1, 2, 3, 99] }
    renderWithIntl(<CardList conversations={[tagged]} now={NOW} />)
    expect(screen.getByText("bug")).toBeTruthy()
    expect(screen.getByText("idea")).toBeTruthy()
    expect(screen.queryByText("ui")).toBeNull()
    // 99 names no tag this client knows: it is neither drawn nor counted.
    expect(screen.getByText("+1")).toBeTruthy()
    expect(screen.getByTitle("ui")).toBeTruthy()
  })

  it("re-renders only the cards showing a tag whose definition changed", () => {
    const list = [
      { ...conv(1), tag_ids: [1] },
      { ...conv(2), tag_ids: [2] },
      conv(3),
    ]
    renderWithIntl(<CardList conversations={list} now={NOW} />)
    probe.agentIconRenders = 0
    act(() => {
      useConversationTagsStore.getState().applyChange({
        kind: "upsert",
        tag: {
          id: 1,
          folder_id: null,
          name: "Bug!",
          color: "#cf222e",
          sort_order: 1,
        },
      })
    })
    expect(screen.getByText("Bug!")).toBeTruthy()
    expect(probe.agentIconRenders).toBe(1)
  })
})

describe("SidebarConversationCard branch chip", () => {
  beforeEach(() => {
    resetConversationTagsStore()
    probe.agentIconRenders = 0
    const store = useConversationTagsStore.getState()
    for (const [id, name] of [
      [1, "bug"],
      [2, "idea"],
    ] as const) {
      store.applyChange({
        kind: "upsert",
        tag: { id, folder_id: null, name, color: "#cf222e", sort_order: id },
      })
    }
  })

  const setBranchTag = (enabled: boolean, color = "#0969da") =>
    act(() => {
      useConversationTagsStore
        .getState()
        .applyChange({ kind: "branch_tag", setting: { enabled, color } })
    })

  const follows = (a: Node, b: Node) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  it("comes first after the title, in the branch tag's colour, and counts toward the two chips", () => {
    setBranchTag(true)
    const row = { ...conv(1), git_branch: "feature/x", tag_ids: [1, 2] }
    renderWithIntl(<CardList conversations={[row]} now={NOW} />)

    const title = screen.getByText("conv-1")
    const chip = screen.getByTitle("Branch: feature/x")
    const bug = screen.getByText("bug")
    expect(follows(title, chip)).toBe(true)
    expect(follows(chip, bug)).toBe(true)
    expect(chip.style.getPropertyValue("--fl-bg")).toBe("#0969da")
    // Branch + one tag is the row's two chips; the other tag folds away.
    expect(screen.queryByText("idea")).toBeNull()
    expect(screen.getByText("+1")).toBeTruthy()
    // The title grows only as far as its own text, so the chips follow it
    // rather than the row's far end (layout itself is checked in a browser).
    expect(title.className).toMatch(/(^|\s)max-w-max(\s|$)/)
  })

  it("follows the setting live, and skips rows without a branch and sub-sessions", () => {
    const list = [
      { ...conv(1), git_branch: "main" },
      conv(2),
      { ...conv(3), git_branch: "main", parent_id: 1 },
    ]
    renderWithIntl(<CardList conversations={list} now={NOW} />)
    expect(screen.queryByTitle("Branch: main")).toBeNull()

    setBranchTag(true)
    // One chip, on the root row: conv(2) has no branch, conv(3) is a
    // sub-session.
    const rowOf = (id: number) =>
      document.querySelector(`[data-conv-key="claude_code:${id}"]`)!
    expect(screen.getAllByTitle("Branch: main")).toHaveLength(1)
    expect(rowOf(1).contains(screen.getByTitle("Branch: main"))).toBe(true)
    expect(rowOf(3).querySelector("[data-branch-chip]")).toBeNull()

    setBranchTag(true, "#1a7f37")
    expect(
      screen.getByTitle("Branch: main").style.getPropertyValue("--fl-bg")
    ).toBe("#1a7f37")

    setBranchTag(false, "#1a7f37")
    expect(screen.queryByTitle("Branch: main")).toBeNull()
  })
})

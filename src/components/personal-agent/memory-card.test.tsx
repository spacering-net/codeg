/**
 * The memory card (7.7): what a turn changed in the assistant's memory,
 * persona or rules — the files, the diff on demand, [Undo] — and the line
 * under a reply naming the memory it used.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(async () => ({})),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
}))

import { MemoryCard } from "./memory-card"
import { buildMessageItems, type MessageItem } from "./message-items"
import { PageScopeContext, type PageScope } from "./shared"

const DIFF = `diff --git a/memory/release.md b/memory/release.md
new file mode 100644
--- /dev/null
+++ b/memory/release.md
@@ -0,0 +1 @@
+We ship on Fridays.
`

function card(data: Record<string, unknown>): TimelineRow {
  return {
    id: 41,
    segment_id: 1,
    batch_id: 7,
    kind: "notice",
    status: null,
    body: "Memory updated — new: Release days · persona",
    data: {
      notice: "memory",
      state: "acted",
      commit: "abc1234",
      files: [
        {
          path: "MEMORY.md",
          status: "modified",
          kind: "index",
          title: "MEMORY.md",
        },
        {
          path: "SOUL.md",
          status: "modified",
          kind: "soul",
          title: "SOUL.md",
        },
        {
          path: "memory/release.md",
          status: "added",
          kind: "entry",
          title: "Release days",
        },
      ],
      diff: DIFF,
      diff_cut: false,
      ...data,
    },
    dispatch_id: null,
    ref_id: "9",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-13T01:00:00Z",
    updated_at: "2026-11-13T01:00:00Z",
  }
}

const scope: PageScope = {
  readOnly: false,
  agentName: "Aide",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote: vi.fn(),
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function draw(row: TimelineRow) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        <MemoryCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockClear()
  usePersonalAgentUi.setState({ settings: null, botPage: null })
})
afterEach(() => cleanup())

describe("the memory card", () => {
  it("says what changed, entry by entry, and the persona", () => {
    const { container } = draw(card({}))
    expect(screen.getByText("Remembered")).toBeTruthy()
    expect(screen.getByText("1 new entry · its persona changed")).toBeTruthy()
    // The index rides with its entry: not listed on its own.
    expect(
      container.querySelector("[data-pa-memory-file='MEMORY.md']")
    ).toBeNull()
    const entry = container.querySelector(
      "[data-pa-memory-file='memory/release.md']"
    )
    // How it changed on its tone, its name, its path.
    expect(entry?.textContent).toBe("NewRelease daysmemory/release.md")
    expect(entry?.querySelector("span")?.className).toContain(
      "bg-emerald-500/15"
    )
    // A card of its own, no bubble round it.
    const sheet = container.querySelector("[data-pa-card-message]")!
    expect(sheet.hasAttribute("data-pa-memory-card")).toBe(true)
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
  })

  it("opens the entry it names on the persona page", () => {
    draw(card({}))
    fireEvent.click(screen.getByText("Release days"))
    expect(usePersonalAgentUi.getState().botPage).toEqual({
      tab: "persona",
      entry: "memory/release.md",
    })
  })

  it("shows the diff when asked, and takes the change back", () => {
    const { container } = draw(card({}))
    expect(container.querySelector("[data-pa-memory-diff]")).toBeNull()
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen.getByText("Show changes").closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByText("Show changes"))
    expect(container.querySelector("[data-pa-memory-diff]")).toBeTruthy()
    expect(screen.getByText("We ship on Fridays.")).toBeTruthy()
    fireEvent.click(screen.getByText("Undo"))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "undo", null)
  })

  it("once undone, says what it left as it was and offers no undo", () => {
    const { container } = draw(
      card({ state: "undone", kept: ["memory/release.md"] })
    )
    expect(screen.getByText("Memory change undone")).toBeTruthy()
    expect(container.querySelector("[data-pa-memory-kept]")?.textContent).toBe(
      "Left as they are, changed again since: Release days"
    )
    expect(screen.queryByText("Undo")).toBeNull()
  })

  it("names the index when it is all that changed", () => {
    draw(
      card({
        files: [
          {
            path: "MEMORY.md",
            status: "modified",
            kind: "index",
            title: "MEMORY.md",
          },
        ],
      })
    )
    expect(screen.getByText("the memory index changed")).toBeTruthy()
  })
})

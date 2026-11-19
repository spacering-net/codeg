/**
 * The nightly tidy-up's card and its line under the morning brief (7.7),
 * and a process skill's card (7.8).
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TimelineRow, TodayRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(async (): Promise<unknown> => ({})),
  personalAgentTimelineRows: vi.fn(async (): Promise<unknown[]> => []),
  personalAgentBots: vi.fn(async () => []),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
}))

import { __resetRosterForTests } from "@/stores/personal-agent-roster-store"

import { MemoryCard } from "./memory-card"
import { buildMessageItems, type MessageItem } from "./message-items"
import { PageScopeContext, type PageScope } from "./shared"
import { SkillCard } from "./skill-card"
import { TidyLines } from "./tidy-lines"

const FILES = [
  { path: "MEMORY.md", status: "modified", kind: "index", title: "MEMORY.md" },
  { path: "AGENTS.md", status: "modified", kind: "rules", title: "AGENTS.md" },
  {
    path: "memory/home.md",
    status: "modified",
    kind: "entry",
    title: "Home",
  },
  {
    path: "memory/city.md",
    status: "deleted",
    kind: "entry",
    title: "City",
  },
]

function row(data: Record<string, unknown>, body = ""): TimelineRow {
  return {
    id: 41,
    segment_id: 1,
    batch_id: 7,
    kind: "notice",
    status: null,
    body,
    data,
    dispatch_id: null,
    ref_id: "9",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-14T19:00:00Z",
    updated_at: "2026-11-14T19:00:00Z",
  }
}

function tidy(state: string): TimelineRow {
  return row(
    {
      notice: "tidy",
      state,
      day: "2026-11-14",
      commit: "abc",
      files: FILES,
      diff: "",
      diff_cut: false,
    },
    "Tidied memory (2026-11-14) — 1 updated, 1 removed · rules"
  )
}

function skill(data: Record<string, unknown>): TimelineRow {
  return row({
    notice: "skill",
    state: "acted",
    name: "release",
    title: "Release",
    description: "when the owner says release",
    status: "added",
    path: "process-skills/release/SKILL.md",
    content: "# Release\n\n1. Notes\n",
    diff: "",
    ...data,
  })
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

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function item(r: TimelineRow) {
  const it = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!it) throw new Error("no notice item")
  return it as Extract<MessageItem, { kind: "notice" }>
}

beforeEach(() => {
  __resetRosterForTests()
  api.personalAgentNoticeAct.mockClear()
  api.personalAgentTimelineRows.mockClear()
  usePersonalAgentUi.setState({ settings: null, botPage: null })
})
afterEach(() => cleanup())

describe("the tidy-up's card", () => {
  it("is a card of its own, a draft's note and an applied one on their tones", () => {
    const draft = wrap(<MemoryCard item={item(tidy("draft"))} />)
    const card = draft.container.querySelector("[data-pa-card-message]")!
    expect(card.getAttribute("data-pa-tidy-card")).toBe("draft")
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    expect(
      card.querySelector("[data-pa-tidy-note]")?.getAttribute("data-pa-outcome")
    ).toBe("info")
    draft.unmount()
    const applied = wrap(<MemoryCard item={item(tidy("applied"))} />)
    expect(
      applied.container
        .querySelector("[data-pa-tidy-note]")
        ?.getAttribute("data-pa-outcome")
    ).toBe("done")
  })

  it("says what the tidy-up did, and takes it back as a whole", () => {
    const { container } = wrap(<MemoryCard item={item(tidy("acted"))} />)
    expect(container.querySelector("[data-pa-tidy-card='acted']")).toBeTruthy()
    expect(screen.getByText("Tidied up memory (2026-11-14)")).toBeTruthy()
    expect(
      screen.getByText("1 entry updated · 1 entry removed · its rules changed")
    ).toBeTruthy()
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen.getByText("Undo all").closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByText("Undo all"))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "undo", null)
  })

  it("as a draft, is applied or let go — nothing to undo", () => {
    wrap(<MemoryCard item={item(tidy("draft"))} />)
    expect(screen.getByText("Tidy-up of 2026-11-14, a draft")).toBeTruthy()
    expect(
      screen.getByText(
        "Kept as a draft: your memory is as it was until you apply it."
      )
    ).toBeTruthy()
    expect(screen.queryByText("Undo all")).toBeNull()
    fireEvent.click(screen.getByText("Apply"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "apply",
      null
    )
    cleanup()
    wrap(<MemoryCard item={item(tidy("draft"))} />)
    fireEvent.click(screen.getByText("Not this one"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "dismiss",
      null
    )
  })

  it("applied, can still be undone; stale, says why and offers nothing", () => {
    wrap(<MemoryCard item={item(tidy("applied"))} />)
    expect(screen.getByText("Undo all")).toBeTruthy()
    cleanup()
    wrap(<MemoryCard item={item(tidy("stale"))} />)
    expect(
      screen.getByText(
        "The memory changed since in a way this draft no longer fits; the next night tidies again."
      )
    ).toBeTruthy()
    expect(screen.queryByText("Apply")).toBeNull()
    expect(screen.queryByText("Undo all")).toBeNull()
  })
})

describe("a draft that could not be set aside", () => {
  it("says so: the tidy-up in effect, the skill kept off", () => {
    const t = tidy("acted")
    wrap(
      <MemoryCard
        item={item({ ...t, data: { ...t.data, not_aside: "disk full" } })}
      />
    )
    expect(
      screen.getByText(
        "Could not be kept as a draft (disk full): it is in effect — Undo all takes it back."
      )
    ).toBeTruthy()
    expect(screen.getByText("Undo all")).toBeTruthy()
    cleanup()
    wrap(
      <SkillCard item={item(skill({ off: true, not_aside: "disk full" }))} />
    )
    expect(
      screen.getByText(
        "Could not be kept as a draft (disk full): it is kept off — Turn on loads it."
      )
    ).toBeTruthy()
    expect(screen.getByText("Turn on")).toBeTruthy()
    // Not turned off either: it says it is in effect, not that it is off.
    cleanup()
    wrap(<SkillCard item={item(skill({ not_aside: "disk full" }))} />)
    expect(
      screen.getByText(
        "Could not be kept as a draft (disk full), nor turned off: it is in effect — Turn off or Undo."
      )
    ).toBeTruthy()
    expect(screen.getByText("Turn off")).toBeTruthy()
  })
})

describe("the tidy-ups under the brief", () => {
  const line: TodayRow = {
    key: "tidy:9",
    kind: "tidy",
    bot_id: 2,
    project: null,
    title: "Tidied memory (2026-11-14) — 1 updated, 1 removed · rules",
    text: null,
    at: "2026-11-14T19:00:00Z",
    state: "acted",
    row_id: 41,
    dispatch_id: null,
    task_id: null,
    conversation_id: null,
    item_id: null,
    notice_id: 9,
    agent_type: null,
    undo: true,
  }

  it("say what each assistant did, from its card as it stands, with its buttons", async () => {
    api.personalAgentTimelineRows.mockResolvedValueOnce([tidy("acted")])
    const { container } = wrap(<TidyLines rows={[line]} />)
    // Who tidied over what it did, on a row of the brief's lists.
    await waitFor(() =>
      expect(
        [
          ...(container
            .querySelector("[data-pa-tidy-line='acted']")
            ?.querySelectorAll("p") ?? []),
        ].map((p) => p.textContent)
      ).toEqual([
        "#2 tidied its memory",
        "1 entry updated · 1 entry removed · its rules changed",
      ])
    )
    expect(api.personalAgentTimelineRows).toHaveBeenCalledWith([41], 2)
    api.personalAgentNoticeAct.mockResolvedValueOnce(tidy("undone"))
    fireEvent.click(screen.getByText("Undo all"))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "undo", 2)
    await waitFor(() =>
      expect(
        container.querySelector("[data-pa-tidy-line='undone']")
      ).toBeTruthy()
    )
    expect(screen.getByText("Undone")).toBeTruthy()
    expect(screen.queryByText("Undo all")).toBeNull()
  })

  it("a draft is applied from its line", async () => {
    api.personalAgentTimelineRows.mockResolvedValueOnce([tidy("draft")])
    const { container } = wrap(
      <TidyLines rows={[{ ...line, state: "draft", undo: false }]} />
    )
    await waitFor(() =>
      expect(
        container.querySelector("[data-pa-tidy-line='draft']")
      ).toBeTruthy()
    )
    fireEvent.click(screen.getByText("Apply"))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "apply", 2)
  })

  it("shows nothing without a tidy-up", () => {
    const { container } = wrap(<TidyLines rows={[]} />)
    expect(container.querySelector("[data-pa-brief-tidied]")).toBeNull()
  })
})

describe("a process skill's card", () => {
  it("says it learned it and when it is for, and turns it off, views and deletes it", () => {
    const { container } = wrap(<SkillCard item={item(skill({}))} />)
    expect(screen.getByText("New process skill")).toBeTruthy()
    expect(
      screen.getByText(
        "I made “Release” a process skill: the next time you ask for it, I follow it."
      )
    ).toBeTruthy()
    // When it is for, as a fact: its label, then the words.
    const when = screen.getByText("when the owner says release")
    expect(when.tagName).toBe("DD")
    expect(when.closest("dl")?.querySelector("dt")?.textContent).toBe("When")
    // A card of its own, no bubble round it.
    const card = when.closest("[data-pa-card-message]")!
    expect(card.hasAttribute("data-pa-skill-card")).toBe(true)
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    expect(
      screen.getByText("Turn off").closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByText("Show"))
    expect(
      container.querySelector("[data-pa-skill-content]")?.textContent
    ).toContain("1. Notes")
    fireEvent.click(screen.getByText("Turn off"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "disable",
      null
    )
    cleanup()
    wrap(<SkillCard item={item(skill({}))} />)
    fireEvent.click(screen.getByText("View"))
    expect(usePersonalAgentUi.getState().botPage).toEqual({
      tab: "persona",
      entry: "process-skills/release/SKILL.md",
    })
    // Deleting asks once more.
    fireEvent.click(screen.getByText("Delete"))
    fireEvent.click(screen.getByText("Delete it"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "delete",
      null
    )
  })

  it("turned off, says so and turns back on", () => {
    wrap(<SkillCard item={item(skill({ off: true }))} />)
    expect(screen.getByText("Turned off: it is no longer loaded.")).toBeTruthy()
    fireEvent.click(screen.getByText("Turn on"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "enable",
      null
    )
  })

  it("a change is undone; a draft is installed or let go", () => {
    wrap(<SkillCard item={item(skill({ status: "modified" }))} />)
    expect(
      screen.getByText(
        "I changed the process skill “Release”; it is in effect now."
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByText("Undo"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(9, "undo", null)
    cleanup()
    wrap(<SkillCard item={item(skill({ state: "draft" }))} />)
    expect(screen.getByText("Process skill, a draft")).toBeTruthy()
    expect(screen.queryByText("Turn off")).toBeNull()
    fireEvent.click(screen.getByText("Install"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "apply",
      null
    )
    cleanup()
    wrap(<SkillCard item={item(skill({ state: "draft" }))} />)
    fireEvent.click(screen.getByText("Not this one"))
    expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
      9,
      "dismiss",
      null
    )
  })

  it("deleted, offers nothing more", () => {
    wrap(<SkillCard item={item(skill({ state: "deleted" }))} />)
    expect(screen.getByText("Deleted.")).toBeTruthy()
    expect(screen.queryByText("Undo")).toBeNull()
    expect(screen.queryByText("Turn off")).toBeNull()
  })
})

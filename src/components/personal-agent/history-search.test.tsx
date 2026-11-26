import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  PersonalAgentHistoryHit,
  PersonalAgentHistoryResults,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentHistorySearch: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

import {
  excerptParts,
  HistorySearchButton,
  HistorySearchDialog,
  type HistoryOpeners,
} from "./history-search"

function hit(p: Partial<PersonalAgentHistoryHit>): PersonalAgentHistoryHit {
  return {
    source: "timeline",
    ref_id: 1,
    role: "owner",
    title: null,
    excerpt: "",
    at: "2026-11-06T06:20:00Z",
    project_id: null,
    project: null,
    agent_type: null,
    bot_id: null,
    bot_name: null,
    peer_bot_id: null,
    peer_name: null,
    row_id: null,
    conversation_id: null,
    matches: 1,
    ...p,
  }
}

function results(
  hits: PersonalAgentHistoryHit[],
  extra: Partial<PersonalAgentHistoryResults> = {}
): PersonalAgentHistoryResults {
  return {
    hits,
    short: false,
    status: {
      documents: 10,
      sessions_done: 4,
      sessions_total: 4,
      sessions_on: true,
      tasks_on: true,
      reading: false,
    },
    ...extra,
  }
}

function draw(openers: HistoryOpeners) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HistorySearchButton />
      <HistorySearchDialog openers={openers} />
    </NextIntlClientProvider>
  )
}

async function type(text: string) {
  const input = document.querySelector(
    "[data-pa-history-input]"
  ) as HTMLInputElement
  fireEvent.change(input, { target: { value: text } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe("the time machine's search", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePersonalAgentUi.setState({ searchOpen: false })
    api.personalAgentHistorySearch.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("marks the matches of an excerpt", () => {
    expect(
      excerptParts("…why \u0002打包\u0003 in \u0002PowerShell\u0003")
    ).toEqual([
      { text: "…why ", mark: false },
      { text: "打包", mark: true },
      { text: " in ", mark: false },
      { text: "PowerShell", mark: true },
    ])
    expect(excerptParts("plain")).toEqual([{ text: "plain", mark: false }])
    expect(excerptParts("\u0002open")).toEqual([{ text: "open", mark: true }])
  })

  it("opens from the title, searches as one types and opens what it found", async () => {
    const openers = { row: vi.fn(), session: vi.fn(), task: vi.fn() }
    api.personalAgentHistorySearch.mockResolvedValue(
      results([
        hit({
          source: "session",
          ref_id: 88,
          role: "agent",
          title: "Windows packaging",
          excerpt: "Fixed: quote the \u0002PowerShell\u0003 path.",
          project: "codeg",
          agent_type: "claude_code",
          bot_name: "Dev",
          conversation_id: 88,
          matches: 3,
        }),
        hit({
          source: "timeline",
          ref_id: 5,
          row_id: 5,
          bot_id: 2,
          bot_name: "Ari",
          excerpt: "why \u0002PowerShell\u0003?",
        }),
        hit({
          source: "task",
          ref_id: 12,
          title: "Sign it",
          conversation_id: 70,
        }),
      ])
    )
    draw(openers)
    fireEvent.click(document.querySelector("[data-pa-history-open]")!)
    expect(usePersonalAgentUi.getState().searchOpen).toBe(true)
    await type("PowerShell")
    expect(api.personalAgentHistorySearch).toHaveBeenCalledTimes(1)
    expect(api.personalAgentHistorySearch).toHaveBeenCalledWith({
      query: "PowerShell",
      scope: "all",
      limit: 30,
    })
    const session = document.querySelector(
      '[data-pa-history-hit="session:88"]'
    )!
    expect(session.textContent).toContain("Windows packaging")
    expect(session.textContent).toContain(
      "Agent: Fixed: quote the PowerShell path."
    )
    expect(session.textContent).toContain(
      "codeg · Claude Code · handed out by Dev"
    )
    expect(session.textContent).toContain("3 matches")
    expect(session.querySelector("mark")?.textContent).toBe("PowerShell")
    expect(
      document.querySelector('[data-pa-history-hit="timeline:5"]')!.textContent
    ).toContain("With Ari")
    fireEvent.click(session)
    expect(openers.session).toHaveBeenCalledWith(88)
    expect(usePersonalAgentUi.getState().searchOpen).toBe(false)

    // Open again: a row opens in its assistant's conversation; a task its
    // details.
    act(() => usePersonalAgentUi.getState().setSearchOpen(true))
    await type("PowerShell ")
    fireEvent.click(
      document.querySelector('[data-pa-history-hit="timeline:5"]')!
    )
    expect(openers.row).toHaveBeenCalledWith(2, 5)
    act(() => usePersonalAgentUi.getState().setSearchOpen(true))
    await type("PowerShell")
    fireEvent.click(document.querySelector('[data-pa-history-hit="task:12"]')!)
    expect(openers.task).toHaveBeenCalledWith(12, 70)
  })

  it("narrows to one source and says what was left out", async () => {
    api.personalAgentHistorySearch.mockResolvedValue(
      results([], {
        short: true,
        status: {
          documents: 10,
          sessions_done: 2,
          sessions_total: 9,
          sessions_on: true,
          tasks_on: false,
          reading: true,
        },
      })
    )
    draw({ row: vi.fn(), session: vi.fn(), task: vi.fn() })
    act(() => usePersonalAgentUi.getState().setSearchOpen(true))
    await type("打包")
    expect(screen.getByText("Nothing found.")).toBeInTheDocument()
    const notes = document.querySelector("[data-pa-history-notes]")!.textContent
    expect(notes).toContain("only the last 90 days")
    expect(notes).toContain("Still reading conversations (2 of 9)")
    expect(notes).toContain("The board's tasks are left out")
    fireEvent.click(
      document.querySelector('[data-pa-history-scope="sessions"]')!
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(api.personalAgentHistorySearch).toHaveBeenLastCalledWith({
      query: "打包",
      scope: "sessions",
      limit: 30,
    })
  })
})

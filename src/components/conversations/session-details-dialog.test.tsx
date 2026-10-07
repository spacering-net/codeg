import { type ReactElement } from "react"
import { fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { SessionDetailsDialog } from "./session-details-dialog"
import type { DbConversationSummary, SessionStats } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// The agent icon renders inline SVG with a <title> that would duplicate the
// agent label text; stub it so text queries stay unambiguous.
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => null,
}))

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

// Keep the real `cn`, stub only the clipboard write so copy actions are
// observable without touching the (jsdom-less) Clipboard API.
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, copyTextToClipboard: vi.fn().mockResolvedValue(true) }
})

import { getFolderConversation } from "@/lib/api"
import { rememberModelLabels } from "@/lib/model-label-store"
import { copyTextToClipboard } from "@/lib/utils"
const mockGet = vi.mocked(getFolderConversation)
const mockCopy = vi.mocked(copyTextToClipboard)

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "My session",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: "claude-opus-4-8",
    git_branch: "main",
    external_id: "ext-abc",
    message_count: 12,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-12T12:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

const fullStats: SessionStats = {
  total_usage: {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 500,
  },
  total_tokens: 3500,
  total_duration_ms: 5000,
  context_window_used_tokens: 50000,
  context_window_max_tokens: 200000,
  context_window_usage_percent: 25,
}

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function wrap(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("SessionDetailsDialog", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockCopy.mockClear()
    mockCopy.mockResolvedValue(true)
  })

  it("renders provided stats without fetching (detail-panel path)", () => {
    const { getByText, queryByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={fullStats}
      />
    )
    expect(getByText("Extension ID")).toBeTruthy()
    expect(getByText("ext-abc")).toBeTruthy()
    expect(getByText("50K / 200K (25.0%)")).toBeTruthy()
    // The message count field was intentionally removed.
    expect(queryByText("Messages")).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("falls back to completed summary timestamps when stats duration is missing", () => {
    const completedSummary = summary({
      status: "completed",
      created_at: "2026-06-10T10:00:00.000Z",
      updated_at: "2026-06-10T10:02:30.000Z",
    })
    const statsWithoutDuration: SessionStats = {
      ...fullStats,
      total_duration_ms: 0,
    }

    const { getByText, queryByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={completedSummary}
        stats={statsWithoutDuration}
      />
    )

    expect(getByText("2.5m")).toBeTruthy()
    expect(queryByText("0ms")).toBeNull()
  })

  it("does not derive an in-progress duration from timestamps", () => {
    const liveSummary = summary({
      status: "in_progress",
      created_at: "2026-06-10T10:00:00.000Z",
      updated_at: "2026-06-10T10:02:30.000Z",
    })
    const statsWithoutDuration: SessionStats = {
      ...fullStats,
      total_duration_ms: 0,
    }

    const { queryByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={liveSummary}
        stats={statsWithoutDuration}
      />
    )

    expect(queryByText("2.5m")).toBeNull()
    expect(queryByText("0ms")).toBeNull()
  })

  it("shows the title, agent, and status in the identity header", () => {
    const { getByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={fullStats}
      />
    )
    expect(getByText("My session")).toBeTruthy()
    expect(getByText("Claude Code")).toBeTruthy()
    expect(getByText("In Progress")).toBeTruthy()
  })

  it("shows an em dash for an unknown used token count, never 0 / max", () => {
    const maxOnly: SessionStats = {
      total_usage: null,
      total_tokens: null,
      total_duration_ms: 0,
      context_window_used_tokens: null,
      context_window_max_tokens: 200000,
      context_window_usage_percent: null,
    }
    const { getByText, queryByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={maxOnly}
      />
    )
    expect(getByText("— / 200K")).toBeTruthy()
    expect(queryByText("0 / 200K")).toBeNull()
  })

  it("prefers the backend percent over a used/max recompute (matches the status bar)", () => {
    // The status bar's session-stats branch trusts context_window_usage_percent
    // over a used/max recompute; here the backend says 99 while used/max would
    // recompute to 25, and 99 must win.
    const stale: SessionStats = {
      ...fullStats,
      context_window_usage_percent: 99,
    }
    const { getByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={stale}
      />
    )
    expect(getByText("50K / 200K (99.0%)")).toBeTruthy()
  })

  it("recomputes from used/max when the backend percent is absent", () => {
    const noPercent: SessionStats = {
      ...fullStats,
      context_window_usage_percent: null,
    }
    const { getByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={noPercent}
      />
    )
    expect(getByText("50K / 200K (25.0%)")).toBeTruthy()
  })

  it("uses the backend percent (one decimal) when used tokens are unknown", () => {
    const fallback: SessionStats = {
      total_usage: null,
      total_tokens: null,
      total_duration_ms: 0,
      context_window_used_tokens: null,
      context_window_max_tokens: 200000,
      context_window_usage_percent: 42,
    }
    const { getByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={fallback}
      />
    )
    expect(getByText("— / 200K (42.0%)")).toBeTruthy()
  })

  it("clamps an out-of-range backend percent to 100", () => {
    const over: SessionStats = {
      ...fullStats,
      context_window_usage_percent: 250,
    }
    const { getByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={over}
      />
    )
    expect(getByText("50K / 200K (100.0%)")).toBeTruthy()
  })

  it("fetches token usage when stats are omitted (sidebar path)", async () => {
    mockGet.mockResolvedValue({
      summary: summary(),
      turns: [],
      session_stats: fullStats,
    })
    const { getByText, findByText } = renderWithIntl(
      <SessionDetailsDialog open onOpenChange={() => {}} summary={summary()} />
    )
    expect(getByText(/Loading token usage/)).toBeTruthy()
    expect(await findByText("50K / 200K (25.0%)")).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith(7)
  })

  it("derives the model from the fetched turns when the summary has none", async () => {
    mockGet.mockResolvedValue({
      summary: summary({ model: null }),
      turns: [
        {
          id: "t1",
          role: "assistant",
          blocks: [],
          timestamp: "2026-06-10T10:00:00.000Z",
          model: "claude-sonnet-4-6",
        },
      ],
      session_stats: fullStats,
    })
    const { findByText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary({ model: null })}
      />
    )
    expect(await findByText("claude-sonnet-4-6")).toBeTruthy()
  })

  it("names the model the way its agent does", async () => {
    // qoder records an account-internal key in its transcripts (`qfmodel`) and
    // advertises the readable name over ACP. This field used to show the key
    // while the composer's picker showed the name.
    rememberModelLabels("qoder", [
      {
        id: "model",
        name: "Model",
        kind: {
          type: "select",
          current_value: "qfmodel",
          options: [{ value: "qfmodel", name: "Qwen3.8-Flash" }],
          groups: [],
        },
      },
    ])
    const qoder = summary({ agent_type: "qoder", model: "qfmodel" })
    mockGet.mockResolvedValue({
      summary: qoder,
      turns: [],
      session_stats: fullStats,
    })
    const { findByText, queryByText } = renderWithIntl(
      <SessionDetailsDialog open onOpenChange={() => {}} summary={qoder} />
    )
    expect(await findByText("Qwen3.8-Flash")).toBeTruthy()
    expect(queryByText("qfmodel")).toBeNull()
  })

  it("shows an error when the fetch fails", async () => {
    mockGet.mockRejectedValue(new Error("boom"))
    const { findByText } = renderWithIntl(
      <SessionDetailsDialog open onOpenChange={() => {}} summary={summary()} />
    )
    expect(await findByText("Failed to load token usage")).toBeTruthy()
  })

  it("recovers when a retry succeeds after an earlier failure (same id)", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"))
    mockGet.mockResolvedValue({
      summary: summary(),
      turns: [],
      session_stats: fullStats,
    })
    const { rerender, findByText, queryByText } = renderWithIntl(
      <SessionDetailsDialog open onOpenChange={() => {}} summary={summary()} />
    )
    expect(await findByText("Failed to load token usage")).toBeTruthy()

    // Close then reopen: the effect refetches and the success overwrites the
    // earlier error (the keyed result makes the latest outcome win).
    rerender(
      wrap(
        <SessionDetailsDialog
          open={false}
          onOpenChange={() => {}}
          summary={summary()}
        />
      )
    )
    rerender(
      wrap(
        <SessionDetailsDialog
          open
          onOpenChange={() => {}}
          summary={summary()}
        />
      )
    )
    expect(await findByText("50K / 200K (25.0%)")).toBeTruthy()
    expect(queryByText("Failed to load token usage")).toBeNull()
  })

  it("copies the session id, with field-specific accessible labels", async () => {
    const { getByLabelText, findByLabelText } = renderWithIntl(
      <SessionDetailsDialog
        open
        onOpenChange={() => {}}
        summary={summary()}
        stats={fullStats}
      />
    )
    // Each copy button names its own field so screen-reader/keyboard users can
    // tell them apart.
    expect(getByLabelText("Copy Extension ID")).toBeTruthy()
    fireEvent.click(getByLabelText("Copy Session ID"))
    expect(mockCopy).toHaveBeenCalledWith("7")
    expect(await findByLabelText("Copied Session ID")).toBeTruthy()
  })
})

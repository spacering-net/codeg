import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SessionStats, TurnUsage } from "@/lib/types"

// The connection store only supplies the LIVE context window; every test here
// is about the token breakdown, which comes from the runtime store, so the
// connection is permanently absent (a composer with no live agent attached).
vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => ({
    getConnection: () => undefined,
    subscribeKey: () => () => {},
  }),
}))
vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))

import { ComposerContextUsage } from "./composer-context-usage"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

const mockTabs = useTabStore as unknown as Mock
const mockRuntime = useConversationRuntimeStore as unknown as Mock

const copy = enMessages.Folder.statusBar.tokens

type TabSlice = {
  tabs: Array<{
    id: string
    kind: string
    conversationId: number | null
    runtimeConversationId?: number
  }>
}
type RuntimeSlice = {
  byConversationId: Map<number, { sessionStats: SessionStats | null }>
}

function usage(over: Partial<TurnUsage> = {}): TurnUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  }
}

/** Render the indicator for a conversation whose session reports `total`. */
function renderUsage(total: TurnUsage | null) {
  const tabs: TabSlice = {
    tabs: [{ id: "tab-1", kind: "conversation", conversationId: 7 }],
  }
  const runtime: RuntimeSlice = {
    byConversationId: new Map([
      [
        7,
        {
          sessionStats: total
            ? ({
                total_usage: total,
                total_duration_ms: 0,
              } as SessionStats)
            : null,
        },
      ],
    ]),
  }
  mockTabs.mockImplementation((sel: (s: TabSlice) => unknown) => sel(tabs))
  mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
    sel(runtime)
  )
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerContextUsage tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

async function openPopover() {
  await userEvent.click(screen.getByRole("button"))
}

/** The value rendered next to `label` inside the popover. */
function valueFor(label: string): string {
  const row = screen.getByText(label).parentElement
  return row?.lastElementChild?.textContent ?? ""
}

describe("ComposerContextUsage cache hit rate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("measures cache reads against everything that entered as context", async () => {
    renderUsage(
      usage({
        input_tokens: 1_000,
        output_tokens: 500,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 8_000,
      })
    )
    await openPopover()

    // 8000 / (1000 + 1000 + 8000). Cache WRITES stay in the denominator —
    // dropping them would read 88.9% and make re-written context look free.
    expect(valueFor(copy.cacheHit)).toBe("80.0%")
  })

  it("stays silent when the session reports no cache counters at all", async () => {
    // The shape a self-hosted OpenAI-compatible endpoint produces: real input
    // and output, no cache accounting anywhere. "0.0%" would be a confident
    // wrong answer — codeg cannot tell an idle cache from an unreported one.
    renderUsage(usage({ input_tokens: 5_000, output_tokens: 400 }))
    await openPopover()

    expect(screen.getByText(copy.input)).toBeInTheDocument()
    expect(screen.queryByText(copy.cacheHit)).not.toBeInTheDocument()
  })

  it("still reports a genuine 0% once anything has been written to cache", async () => {
    // A first turn writes the cache and reads nothing back: the miss is real
    // and measured, so it is shown rather than hidden.
    renderUsage(
      usage({ input_tokens: 2_000, cache_creation_input_tokens: 6_000 })
    )
    await openPopover()

    expect(valueFor(copy.cacheHit)).toBe("0.0%")
  })

  it("renders nothing at all for a conversation with no usage", () => {
    renderUsage(null)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

/** Render the indicator for a session whose stats are supplied wholesale. */
function renderStats(stats: SessionStats | null) {
  const tabs: TabSlice = {
    tabs: [{ id: "tab-1", kind: "conversation", conversationId: 7 }],
  }
  const runtime: RuntimeSlice = {
    byConversationId: new Map([[7, { sessionStats: stats }]]),
  }
  mockTabs.mockImplementation((sel: (s: TabSlice) => unknown) => sel(tabs))
  mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
    sel(runtime)
  )
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerContextUsage tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

describe("ComposerContextUsage zeroed counters", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("hides a breakdown of zeros rather than claiming nothing was spent", async () => {
    // Qoder redacts every counter to 0 for its own hosted models, so a session
    // that plainly produced replies arrives with an all-zero usage. "Total 0"
    // is a confident wrong answer; the occupancy it DOES report still shows.
    renderStats({
      total_usage: usage(),
      total_tokens: 0,
      total_duration_ms: 0,
      context_window_usage_percent: 16.74,
    } as SessionStats)

    expect(screen.getByText("16.7%")).toBeInTheDocument()
    await openPopover()
    expect(screen.queryByText(copy.input)).not.toBeInTheDocument()
    expect(screen.queryByText(copy.total)).not.toBeInTheDocument()
    // Nor a "Used / Max --": the two counts were never reported, and an empty
    // labelled row reads as a figure that failed to load.
    expect(screen.queryByText(copy.usedMax)).not.toBeInTheDocument()
  })

  it("renders nothing when the counters are zero and no occupancy is known", () => {
    // What the qoder session looked like before the ratio was read: a lone
    // "0" that was neither a measurement nor an affordance.
    renderStats({
      total_usage: usage(),
      total_tokens: 0,
      total_duration_ms: 0,
    } as SessionStats)

    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("keeps the cache hit rate with the context figures, under Used / Max", async () => {
    // It is a ratio, not a token count, so it belongs beside the other context
    // figures rather than at the foot of the breakdown — and as an immediate
    // sibling of "Used / Max", with no rule of its own fencing off one line.
    renderStats({
      total_usage: usage({
        input_tokens: 1_000,
        output_tokens: 500,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 8_000,
      }),
      total_tokens: 10_500,
      total_duration_ms: 0,
      context_window_used_tokens: 10_000,
      context_window_max_tokens: 200_000,
      context_window_usage_percent: 5,
    } as SessionStats)
    await openPopover()

    const usedMaxRow = screen.getByText(copy.usedMax).parentElement
    const cacheRow = screen.getByText(copy.cacheHit).parentElement
    expect(usedMaxRow?.nextElementSibling).toBe(cacheRow)
    expect(cacheRow?.className).not.toMatch(/border-t/)
  })

  it("still shows the breakdown once any counter is non-zero", async () => {
    renderStats({
      total_usage: usage({ input_tokens: 2_803, output_tokens: 19 }),
      total_tokens: 2_822,
      total_duration_ms: 0,
      context_window_used_tokens: 2_803,
      context_window_max_tokens: 180_000,
      context_window_usage_percent: 1.5572,
    } as SessionStats)

    expect(screen.getByText("1.6%")).toBeInTheDocument()
    await openPopover()
    expect(valueFor(copy.usedMax)).toBe("2.8K / 180K")
    expect(valueFor(copy.input)).toBe("2.8K")
    expect(valueFor(copy.total)).toBe("2.8K")
  })
})

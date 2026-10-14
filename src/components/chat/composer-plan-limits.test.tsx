import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PlanLimitWindow, SessionStats } from "@/lib/types"

const conn = vi.hoisted(() => ({
  current: undefined as { planLimits: unknown[] } | undefined,
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => ({
    getConnection: () => conn.current,
    subscribeKey: () => () => {},
  }),
}))
vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))

import { ComposerPlanLimits } from "./composer-plan-limits"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

const mockTabs = useTabStore as unknown as Mock
const mockRuntime = useConversationRuntimeStore as unknown as Mock

const copy = enMessages.Folder.statusBar.planLimits
const NOW = 1_791_000_000

function fiveHour(over: Partial<PlanLimitWindow> = {}): PlanLimitWindow {
  return {
    kind: "five_hour",
    used_percent: 40,
    resets_at: NOW + 2 * 3600 + 15 * 60,
    window_minutes: 300,
    ...over,
  }
}

function weekly(over: Partial<PlanLimitWindow> = {}): PlanLimitWindow {
  return {
    kind: "seven_day",
    used_percent: 12,
    resets_at: NOW + 3 * 86_400 + 4 * 3600,
    window_minutes: 10_080,
    ...over,
  }
}

/** Render the indicator for a tab whose connection holds `live` and whose
 *  session stats (the transcript) hold `recorded`. */
function renderLimits({
  live = [],
  recorded,
}: {
  live?: PlanLimitWindow[]
  recorded?: PlanLimitWindow[]
}) {
  conn.current = { planLimits: live }
  const tabs = {
    tabs: [{ id: "tab-1", kind: "conversation", conversationId: 7 }],
  }
  const runtime = {
    byConversationId: new Map([
      [
        7,
        {
          sessionStats: recorded
            ? ({ plan_limits: recorded } as unknown as SessionStats)
            : null,
        },
      ],
    ]),
  }
  mockTabs.mockImplementation((sel: (s: typeof tabs) => unknown) => sel(tabs))
  mockRuntime.mockImplementation((sel: (s: typeof runtime) => unknown) =>
    sel(runtime)
  )
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerPlanLimits tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

describe("ComposerPlanLimits", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders nothing without plan windows (an API-key sign-in)", () => {
    const { container } = renderLimits({})
    expect(container).toBeEmptyDOMElement()
  })

  it("counts down to the reset of the window closest to its limit", async () => {
    renderLimits({ live: [fiveHour(), weekly()] })
    const trigger = screen.getByRole("button", {
      name: "5-hour: 40% used, resets in 2h 15m",
    })
    expect(trigger).toHaveTextContent("2h 15m")

    await userEvent.click(trigger)
    expect(screen.getByText(copy.title)).toBeInTheDocument()
    expect(screen.getByText("5-hour")).toBeInTheDocument()
    expect(screen.getByText("40%")).toBeInTheDocument()
    expect(screen.getByText("Weekly")).toBeInTheDocument()
    expect(screen.getByText("12%")).toBeInTheDocument()
    expect(screen.getByText(/^Resets in 3d 4h · /)).toBeInTheDocument()
  })

  it("puts a reached limit first and says so", async () => {
    renderLimits({
      live: [fiveHour(), weekly({ used_percent: 100, status: "rejected" })],
    })
    const trigger = screen.getByRole("button", { name: /^Weekly: 100% used/ })
    expect(trigger).toHaveClass("text-destructive")

    await userEvent.click(trigger)
    expect(screen.getByText(copy.reached)).toBeInTheDocument()
  })

  it("reads the figures the transcript recorded when the agent reports none live", () => {
    renderLimits({ recorded: [weekly()] })
    expect(
      screen.getByRole("button", { name: /^Weekly: 12% used/ })
    ).toBeInTheDocument()
  })

  it("says how old recorded figures are once they are a while old", async () => {
    // Recorded 3 days ago — another day in every zone: other sessions may
    // have used the plan since.
    const recorded = NOW - 3 * 86_400
    const { unmount } = renderLimits({
      recorded: [weekly({ observed_at: recorded })],
    })
    await userEvent.click(screen.getByRole("button", { name: /^Weekly/ }))
    const [before, after] = copy.staleNote.split("{at}")
    const note = screen.getByText(
      (text) => text.startsWith(before) && text.endsWith(after)
    )
    // The recording moment, local: its day as well as its time.
    const part = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en", options).format(new Date(recorded * 1000))
    expect(note.textContent).toContain(
      part({ weekday: "short", month: "numeric", day: "numeric" })
    )
    expect(note.textContent).toContain(
      part({ hour: "2-digit", minute: "2-digit" })
    )
    unmount()

    // Recorded a minute ago: nothing to say.
    renderLimits({ recorded: [weekly({ observed_at: NOW - 60 })] })
    await userEvent.click(screen.getByRole("button", { name: /^Weekly/ }))
    expect(screen.getByText(copy.title)).toBeInTheDocument()
    expect(screen.queryByText(/^Last updated/)).not.toBeInTheDocument()
  })

  it("names the per-model weekly window after its model", async () => {
    renderLimits({
      live: [
        fiveHour(),
        weekly({ kind: "seven_day_overage_included", used_percent: 90 }),
      ],
    })
    expect(
      screen.getByRole("button", { name: /^Weekly · Fable: 90% used/ })
    ).toBeInTheDocument()
  })

  it("marks a window that has already reset", async () => {
    renderLimits({
      live: [fiveHour({ resets_at: NOW - 60, used_percent: 97 }), weekly()],
    })
    // The headline moves on to the window that still holds.
    await userEvent.click(screen.getByRole("button", { name: /^Weekly/ }))
    expect(screen.getByText(copy.reset)).toBeInTheDocument()
    expect(screen.queryByText("97%")).not.toBeInTheDocument()
  })

  it("renders nothing once every window has reset", () => {
    const { container } = renderLimits({
      live: [fiveHour({ resets_at: NOW - 60 })],
    })
    expect(container).toBeEmptyDOMElement()
  })
})

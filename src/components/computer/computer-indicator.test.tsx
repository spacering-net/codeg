import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatePayload,
  SharedWindow,
  StopKeyStatus,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => true),
  useComputerAvailable: () => api.computerAvailable(),
  askComputerServed: vi.fn(async () => true),
  subscribeComputerServed: vi.fn(() => () => {}),
  computerSharedState: vi.fn(
    async (): Promise<ComputerStatePayload> => ({ shared: [] })
  ),
  computerStop: vi.fn(async () => {}),
  computerIndicatorFit: vi.fn(async () => {}),
  computerStopKeyStatus: vi.fn(async (): Promise<StopKeyStatus> => ({})),
}))
vi.mock("@/lib/computer/computer-api", () => api)
const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))

import { ComputerIndicator } from "./computer-indicator"
import enMessages from "@/i18n/messages/en.json"
import {
  recordComputerActivity,
  resetComputerStoreForTest,
  setComputerShared,
} from "@/lib/computer/computer-store"

function window_(
  targetId: string,
  appName: string,
  level: SharedWindow["level"]
): SharedWindow {
  return {
    targetId,
    appName,
    appKey: `com.example.${appName}`,
    title: `${appName} secret title`,
    level,
    grantedAt: 1,
    lastUsedAt: 1,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerIndicator />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  resetComputerStoreForTest()
  api.computerAvailable.mockReturnValue(true)
  api.computerStopKeyStatus.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ComputerIndicator", () => {
  /** It names the application agents may act on — never the window's title
   * — and Stop there stops sharing, with the shortcut on the button. */
  it("says what agents may do, and stops them", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [
        window_("w1", "TextEdit", "control"),
        window_("w2", "Notes", "read"),
      ],
    })
    api.computerStopKeyStatus.mockResolvedValue({
      active: "Control+Command+Escape",
    })
    mount()
    expect(
      await screen.findByText("Agents can act on TextEdit")
    ).toBeInTheDocument()
    expect(screen.queryByText(/secret title/)).toBeNull()
    const stop = screen.getByRole("button", { name: /Stop/ })
    await waitFor(() => expect(stop).toHaveTextContent("⌃⌘Esc"))
    fireEvent.click(stop)
    await waitFor(() => expect(api.computerStop).toHaveBeenCalled())
  })

  /** The entire screen shared is all of it: the strip says so, whatever
   * windows go with it, and Stop is there to end it. */
  it("says when agents may act on the entire screen", async () => {
    const viaScreen = {
      ...window_("w1", "TextEdit", "control"),
      wholeScreen: true,
    }
    api.computerSharedState.mockResolvedValue({
      shared: [viaScreen, { ...viaScreen, targetId: "w2", appName: "Notes" }],
      apps: [],
      screen: { level: "control", grantedAt: 1, lastUsedAt: 1, windows: 2 },
    })
    mount()
    expect(
      await screen.findByText("Agents can act on the entire screen")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Stop/ })).toBeEnabled()
  })

  it("counts the windows agents may only see", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [
        window_("w1", "TextEdit", "read"),
        window_("w2", "Notes", "read"),
      ],
    })
    mount()
    expect(
      await screen.findByText("Agents can see 2 windows")
    ).toBeInTheDocument()
  })

  /** Its Stop is the popover's: it stops sharing, says so, and names the
   * shortcut in its tooltip. */
  it("calls its Stop by what it does", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [window_("w1", "TextEdit", "read")],
    })
    api.computerStopKeyStatus.mockResolvedValue({
      active: "Control+Command+Escape",
    })
    mount()
    const stop = await screen.findByRole("button", { name: /^Stop sharing/ })
    await waitFor(() =>
      expect(stop.title).toBe("Stop sharing every window (⌃⌘Esc)")
    )
  })

  /** An application shared as a whole is still shared with every window of
   * it closed — the next one it opens will be — so the strip keeps saying so,
   * and keeps its Stop. */
  it("keeps an application shared as a whole, windows or not", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [],
      apps: [
        {
          appId: "a1",
          appName: "Mail",
          appKey: "com.apple.mail",
          level: "control",
          grantedAt: 1,
          lastUsedAt: 1,
          windows: 0,
        },
      ],
    })
    mount()
    expect(
      await screen.findByText("Agents can act on Mail")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /^Stop sharing/ })
    ).toBeInTheDocument()
  })

  /** Once a Stop has ended every sharing there is nothing left on the strip
   * to press while it goes. */
  it("offers no Stop once nothing is shared", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [window_("w1", "TextEdit", "read")],
    })
    mount()
    await screen.findByRole("button", { name: /^Stop sharing/ })
    act(() => setComputerShared([]))
    expect(screen.queryByRole("button")).toBeNull()
  })

  /** An action that just went through is named for a moment; reads, and
   * what was refused, are not news here. */
  it("names what an agent has just done", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [window_("w1", "TextEdit", "control")],
    })
    mount()
    await screen.findByText("Agents can act on TextEdit")
    // What `computer://agent-activity` feeds the store with.
    const activity = recordComputerActivity
    act(() =>
      activity({
        targetId: "w1",
        action: "snapshot",
        outcome: "done",
        at: Date.now(),
      })
    )
    expect(screen.queryByText(/in TextEdit/)).toBeNull()
    act(() =>
      activity({
        targetId: "w1",
        action: "click",
        outcome: "refused",
        at: Date.now(),
      })
    )
    expect(screen.queryByText(/in TextEdit/)).toBeNull()
    act(() =>
      activity({
        targetId: "w1",
        action: "click",
        outcome: "done",
        at: Date.now(),
      })
    )
    expect(screen.getByText("Click in TextEdit")).toBeInTheDocument()
    // The read an agent takes right after does not take the click down.
    act(() =>
      activity({
        targetId: "w1",
        action: "snapshot",
        outcome: "done",
        at: Date.now(),
      })
    )
    expect(screen.getByText("Click in TextEdit")).toBeInTheDocument()
    // Bringing a minimized window back changes the screen: news too.
    act(() =>
      activity({
        targetId: "w1",
        action: "restore",
        outcome: "done",
        at: Date.now(),
      })
    )
    expect(screen.getByText("Restore in TextEdit")).toBeInTheDocument()
  })

  /** The strip is as wide as its words, whatever the window's width: the
   * window is fitted to it, never the other way round. */
  it("does not shrink to the window it is in", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [window_("w1", "TextEdit", "control")],
    })
    mount()
    const summary = await screen.findByText("Agents can act on TextEdit")
    expect(summary.parentElement).toHaveClass("w-max", "shrink-0")
  })

  /** The window is sized to what was drawn, with room for the shadow. */
  it("fits its window to the strip", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200.4,
      height: 30,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200.4,
      bottom: 30,
      toJSON: () => ({}),
    })
    mount()
    await waitFor(() =>
      expect(api.computerIndicatorFit).toHaveBeenCalledWith(213, 42)
    )
  })
})

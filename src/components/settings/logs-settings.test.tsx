import { type ReactNode, useEffect } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

vi.mock("@/lib/api", () => ({
  getLogSettings: vi.fn(),
  getRecentLogs: vi.fn(),
  listLogFiles: vi.fn(),
  openLogsDir: vi.fn(),
  readLogFile: vi.fn(),
  setLogSettings: vi.fn(),
  subscribeLogAppended: vi.fn(),
  subscribeLogSettingsChanged: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: vi.fn(() => true),
  revealItemInDir: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/app-error", () => ({
  toErrorMessage: (e: unknown) => String(e),
}))

// virtua renders 0 rows in jsdom (no layout); render every child so findByText
// works. The viewer drives scrolling through the real viewport (scrollTop),
// not the virtua handle, so the mock just passes its children through.
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

// Shared handle on the live-log viewport so tests can assert the scroll-to-
// bottom (scrollTop ← scrollHeight) and simulate the reader scrolling up. jsdom
// does no layout, so the viewport is given a fixed scrollHeight/clientHeight and
// a spy-able scrollTop. Hoisted so the scroll-area mock factory can reach it.
const viewportState = vi.hoisted(() => {
  const SCROLL_HEIGHT = 9999
  const CLIENT_HEIGHT = 480
  return {
    SCROLL_HEIGHT,
    CLIENT_HEIGHT,
    current: null as (HTMLElement & { __scrollTopSet: Mock }) | null,
    onScroll: undefined as ((e: Event) => void) | undefined,
    make() {
      const el = document.createElement("div")
      let top = 0
      const setSpy = vi.fn((v: number) => {
        top = v
      })
      Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get: () => top,
        set: setSpy,
      })
      Object.defineProperty(el, "scrollHeight", {
        configurable: true,
        get: () => SCROLL_HEIGHT,
      })
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        get: () => CLIENT_HEIGHT,
      })
      return Object.assign(el, { __scrollTopSet: setSpy })
    },
  }
})

// The list mounts the Virtualizer only once OverlayScrollbars surfaces its
// viewport; the mock fires that bridge after mount and clears it on unmount,
// mirroring OverlayScrollbars' `initialized`/`destroyed` events. The teardown
// path matters: the viewer swaps ScrollArea for an empty placeholder whenever
// the list filters down to zero rows. Only the log-viewer ScrollArea bridges a
// viewport (the outer page ScrollArea passes no onViewportRef), so the mock
// tracks the viewport solely for that instance.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
    onScroll,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
    onScroll?: (e: Event) => void
  }) => {
    useEffect(() => {
      if (!onViewportRef) return
      const el = viewportState.make()
      viewportState.current = el
      viewportState.onScroll = onScroll
      onViewportRef(el)
      return () => {
        onViewportRef(null)
        if (viewportState.current === el) viewportState.current = null
        if (viewportState.onScroll === onScroll) {
          viewportState.onScroll = undefined
        }
      }
    }, [onViewportRef, onScroll])
    return <>{children}</>
  },
}))

import { LogsSettings } from "./logs-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getLogSettings,
  getRecentLogs,
  setLogSettings,
  subscribeLogAppended,
  subscribeLogSettingsChanged,
} from "@/lib/api"
import type { LogRecord } from "@/lib/types"

const mockGetSettings = vi.mocked(getLogSettings)
const mockGetRecent = vi.mocked(getRecentLogs)
const mockSetSettings = vi.mocked(setLogSettings)
const mockSubAppended = vi.mocked(subscribeLogAppended)
const mockSubSettings = vi.mocked(subscribeLogSettingsChanged)

const M = enMessages.LogsSettings

function rec(
  seq: number,
  level: string,
  target: string,
  message: string,
  extra: Partial<LogRecord> = {}
): LogRecord {
  return {
    seq,
    timestamp_ms: 1_700_000_000_000 + seq,
    level,
    target,
    message,
    fields: {},
    spans: [],
    ...extra,
  }
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LogsSettings />
    </NextIntlClientProvider>
  )
}

let appendedHandler: ((r: LogRecord) => void) | undefined

// Controllable requestAnimationFrame so we can assert the live-tail batching
// (many events → one flushed commit). A queue (not a single slot) because the
// open-scroll defer and the live-tail flush can have frames pending at once,
// just like the browser; flushRaf fires every callback scheduled for "this frame".
let rafQueue = new Map<number, FrameRequestCallback>()
let rafNextId = 1
let rafScheduleCount = 0
async function flushRaf() {
  await act(async () => {
    const cbs = [...rafQueue.values()]
    rafQueue.clear()
    for (const cb of cbs) cb(0)
  })
}

// Drain a chain of frames that reschedule themselves (the open scroll re-pins
// for several frames). Bounded, and throws if frames still remain so a runaway
// loop fails loudly instead of silently passing.
async function flushAllRaf(maxFrames = 16) {
  for (let i = 0; i < maxFrames && rafQueue.size > 0; i++) {
    await flushRaf()
  }
  if (rafQueue.size > 0) {
    throw new Error(
      `flushAllRaf: ${rafQueue.size} frame(s) still pending after ${maxFrames} flushes`
    )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  appendedHandler = undefined
  viewportState.current = null
  viewportState.onScroll = undefined
  rafQueue = new Map()
  rafNextId = 1
  rafScheduleCount = 0
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = rafNextId++
    rafQueue.set(id, cb)
    rafScheduleCount++
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id)
  })
  mockGetSettings.mockResolvedValue({
    level: "info",
    targets: [],
    env_locked: false,
  })
  mockGetRecent.mockResolvedValue([])
  mockSetSettings.mockResolvedValue({ level: "info", targets: [] })
  mockSubSettings.mockResolvedValue(() => {})
  mockSubAppended.mockImplementation(async (handler) => {
    appendedHandler = handler
    return () => {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("LogsSettings", () => {
  it("renders recent log records", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "ERROR", "acp", "boom happened"),
      rec(2, "INFO", "web", "server started"),
    ])
    renderWithIntl()
    expect(await screen.findByText("boom happened")).toBeInTheDocument()
    expect(screen.getByText("server started")).toBeInTheDocument()
  })

  it("scrolls to the newest record when first opened", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "INFO", "web", "old line"),
      rec(2, "INFO", "web", "newest line"),
    ])
    renderWithIntl()
    await screen.findByText("newest line")

    // The open scroll is deferred to animation frames (virtua must measure the
    // freshly-mounted list first); wait until it's scheduled, drain the frames,
    // then assert the viewport was scrolled to its bottom (scrollTop ←
    // scrollHeight) rather than left at the top.
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    await flushAllRaf()
    expect(viewportState.current?.scrollTop).toBe(viewportState.SCROLL_HEIGHT)
  })

  it("re-pins the open scroll across several frames (not just one)", async () => {
    // virtua measures wrapping rows over a few frames, so the first scroll can
    // land at an estimated bottom; the open scroll must keep re-pinning rather
    // than stopping after one frame.
    mockGetRecent.mockResolvedValue([
      rec(1, "INFO", "web", "alpha"),
      rec(2, "INFO", "web", "omega"),
    ])
    renderWithIntl()
    await screen.findByText("omega")
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    const setSpy = viewportState.current!.__scrollTopSet

    await flushRaf() // first frame
    expect(setSpy).toHaveBeenCalledTimes(1)
    // A follow-up frame is scheduled — the loop did not stop after one.
    expect(rafQueue.size).toBe(1)

    await flushAllRaf()
    expect(setSpy.mock.calls.length).toBeGreaterThan(1)
    // Every re-pin targets the bottom.
    expect(setSpy).toHaveBeenLastCalledWith(viewportState.SCROLL_HEIGHT)
  })

  it("reschedules the open scroll if a dep changes before its frame fires", async () => {
    // The open scroll is deferred a frame. If visible.length changes before that
    // frame fires, the effect re-runs and its cleanup cancels the pending frame;
    // because it latches only once a frame *fires*, the re-run reschedules rather
    // than skipping. (Pause live-tail so the stick effect can't also scroll —
    // this isolates the open scroll.) Fails if the latch were set at schedule.
    mockGetRecent.mockResolvedValue([
      rec(1, "ERROR", "acp", "kept line"),
      rec(2, "INFO", "web", "dropped line"),
    ])
    renderWithIntl()
    await screen.findByText("kept line")
    fireEvent.click(screen.getByRole("button", { name: M.pause }))
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    const setSpy = viewportState.current!.__scrollTopSet
    expect(setSpy).not.toHaveBeenCalled()

    // Narrow the view to one row before the open frame fires (the viewport stays
    // mounted, so the same setSpy keeps counting).
    fireEvent.change(screen.getByPlaceholderText(M.searchPlaceholder), {
      target: { value: "kept" },
    })
    await flushAllRaf()

    // The open scroll still fires (it would never fire if it latched at
    // schedule, since the re-run's guard would short-circuit it).
    expect(setSpy).toHaveBeenCalledWith(viewportState.SCROLL_HEIGHT)
  })

  it("does not re-snap to the newest after a search empties then refills the list", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "INFO", "web", "alpha line"),
      rec(2, "INFO", "web", "beta line"),
    ])
    renderWithIntl()
    await screen.findByText("beta line")
    // Drain the deferred open scroll (re-pins across frames).
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    await flushAllRaf()
    expect(viewportState.current?.scrollTop).toBe(viewportState.SCROLL_HEIGHT)

    // A search matching nothing empties the viewer (ScrollArea unmounts → the
    // viewport bridge fires null), then loosening it refills the viewer with a
    // fresh viewport.
    const searchBox = screen.getByPlaceholderText(M.searchPlaceholder)
    fireEvent.change(searchBox, { target: { value: "no-such-text-zzz" } })
    expect(screen.getByText(M.empty)).toBeInTheDocument()
    fireEvent.change(searchBox, { target: { value: "alpha" } })
    await screen.findByText("alpha line")
    await waitFor(() => expect(viewportState.current).not.toBeNull())
    const setSpy = viewportState.current!.__scrollTopSet

    // Neither the open scroll (latched; records intact) nor the stick effect
    // (newest record seq unchanged by a filter) may fire — a reader who scrolled
    // up to read history keeps their position. Drain any pending frames so a
    // wrongly-scheduled scroll would be caught.
    await flushAllRaf()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it("snaps to the newest after Clear when a live-tail burst arrives", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "initial line")])
    renderWithIntl()
    await screen.findByText("initial line")
    await waitFor(() => expect(appendedHandler).toBeDefined())
    // Drain the deferred open scroll, then ignore it: this case asserts the
    // post-Clear behavior, so clearing before it lands would be racy.
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    await flushAllRaf()
    expect(viewportState.current?.scrollTop).toBe(viewportState.SCROLL_HEIGHT)

    // Clear empties the buffer (records → []), unmounting the viewer.
    fireEvent.click(screen.getByRole("button", { name: M.clear }))
    expect(screen.getByText(M.empty)).toBeInTheDocument()

    // A live-tail burst refills it; the viewer snaps to the newest record rather
    // than staying latched at the top from the original open.
    await act(async () => {
      appendedHandler?.(rec(2, "INFO", "web", "after-clear one"))
      appendedHandler?.(rec(3, "INFO", "web", "after-clear two"))
      appendedHandler?.(rec(4, "INFO", "web", "after-clear three"))
    })
    // Drain the live-tail flush (refills + remounts the viewer, which schedules
    // the open scroll) together with the open scroll's frames.
    await flushAllRaf()
    await screen.findByText("after-clear three")

    expect(viewportState.current?.scrollTop).toBe(viewportState.SCROLL_HEIGHT)
  })

  it("follows the live tail to the bottom as new records arrive", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "first record")])
    renderWithIntl()
    await screen.findByText("first record")
    await waitFor(() => expect(appendedHandler).toBeDefined())
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    await flushAllRaf() // drain the open scroll
    const setSpy = viewportState.current!.__scrollTopSet
    setSpy.mockClear()

    // A record appended at the bottom while the reader is near the bottom pins
    // the view to the new bottom.
    await act(async () => {
      appendedHandler?.(rec(2, "WARN", "acp", "live arrived"))
    })
    await flushRaf()
    await screen.findByText("live arrived")

    expect(setSpy).toHaveBeenCalledWith(viewportState.SCROLL_HEIGHT)
  })

  it("does not follow the live tail when the reader has scrolled up", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "first record")])
    renderWithIntl()
    await screen.findByText("first record")
    await waitFor(() => expect(appendedHandler).toBeDefined())
    await waitFor(() => expect(rafScheduleCount).toBeGreaterThan(0))
    await flushAllRaf() // drain the open scroll (leaves scrollTop at the bottom)

    // Simulate the reader scrolling up: move scrollTop to the top and fire the
    // viewport scroll handler so the viewer records "not near bottom".
    const vp = viewportState.current!
    act(() => {
      vp.scrollTop = 0
      viewportState.onScroll?.(new Event("scroll"))
    })

    // A newly appended record must NOT yank them back down.
    await act(async () => {
      appendedHandler?.(rec(2, "WARN", "acp", "live arrived"))
    })
    await flushRaf()
    await screen.findByText("live arrived")

    expect(vp.scrollTop).toBe(0)
  })

  it("filters displayed records by search text", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "ERROR", "acp", "boom happened"),
      rec(2, "INFO", "web", "server started"),
    ])
    renderWithIntl()
    await screen.findByText("boom happened")

    fireEvent.change(screen.getByPlaceholderText(M.searchPlaceholder), {
      target: { value: "boom" },
    })

    expect(screen.getByText("boom happened")).toBeInTheDocument()
    expect(screen.queryByText("server started")).not.toBeInTheDocument()
  })

  it("appends live-tailed records (coalesced via rAF)", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "first record")])
    renderWithIntl()
    await screen.findByText("first record")
    await waitFor(() => expect(appendedHandler).toBeDefined())

    await act(async () => {
      appendedHandler?.(rec(2, "WARN", "acp", "live arrived"))
    })
    await flushRaf()

    expect(await screen.findByText("live arrived")).toBeInTheDocument()
  })

  it("coalesces a burst of appended records into a single flush", async () => {
    renderWithIntl()
    await waitFor(() => expect(appendedHandler).toBeDefined())

    await act(async () => {
      appendedHandler?.(rec(1, "INFO", "web", "alpha"))
      appendedHandler?.(rec(2, "INFO", "web", "bravo"))
      appendedHandler?.(rec(3, "INFO", "web", "charlie"))
    })
    // Three events, one scheduled frame.
    expect(rafScheduleCount).toBe(1)

    await flushRaf()
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("bravo")).toBeInTheDocument()
    expect(screen.getByText("charlie")).toBeInTheDocument()
  })

  it("re-schedules flushes after toggling live tail off and back on", async () => {
    renderWithIntl()
    await waitFor(() => expect(appendedHandler).toBeDefined())

    // Append (schedules a frame) then pause mid-pending: cleanup must cancel AND
    // reset the rAF id so a later resume can schedule again.
    await act(async () => {
      appendedHandler?.(rec(1, "INFO", "web", "before"))
    })
    expect(rafScheduleCount).toBe(1)

    fireEvent.click(await screen.findByRole("button", { name: M.pause }))
    fireEvent.click(screen.getByRole("button", { name: M.resume }))
    await waitFor(() => expect(mockSubAppended).toHaveBeenCalledTimes(2))

    rafScheduleCount = 0
    await act(async () => {
      appendedHandler?.(rec(2, "INFO", "web", "after toggle"))
    })
    // A fresh frame is scheduled (would be 0 if rafRef held a stale id).
    expect(rafScheduleCount).toBe(1)
    await flushRaf()
    expect(screen.getByText("after toggle")).toBeInTheDocument()
  })

  it("expands a record to show its fields and span chain", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "INFO", "web", "request done", {
        fields: { user_id: "7" },
        spans: [{ name: "http", fields: { path: "/x" } }],
      }),
    ])
    renderWithIntl()
    await screen.findByText("request done")

    fireEvent.click(screen.getByRole("button", { name: M.toggleDetails }))

    expect(screen.getByText("user_id")).toBeInTheDocument()
    expect(screen.getByText("7")).toBeInTheDocument()
    expect(screen.getByText(/http\{path=\/x\}/)).toBeInTheDocument()
  })

  it("clears the view", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "to be cleared")])
    renderWithIntl()
    await screen.findByText("to be cleared")

    fireEvent.click(screen.getByRole("button", { name: M.clear }))

    expect(screen.queryByText("to be cleared")).not.toBeInTheDocument()
    expect(screen.getByText(M.empty)).toBeInTheDocument()
  })

  it("adds a per-module override and persists it", async () => {
    renderWithIntl()
    await screen.findByText(M.targetsTitle)

    fireEvent.click(screen.getByRole("button", { name: M.targetsAdd }))

    const input = screen.getByPlaceholderText("codeg_lib::acp")
    fireEvent.change(input, { target: { value: "codeg_lib::acp" } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(mockSetSettings).toHaveBeenCalledWith({
        level: "info",
        targets: [{ target: "codeg_lib::acp", level: "debug" }],
      })
    )
  })

  it("disables the override editor when env-locked", async () => {
    mockGetSettings.mockResolvedValue({
      level: "debug",
      targets: [],
      env_locked: true,
    })
    renderWithIntl()
    await screen.findByText(M.targetsTitle)

    expect(screen.getByRole("button", { name: M.targetsAdd })).toBeDisabled()
  })
})

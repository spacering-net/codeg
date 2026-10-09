import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useTokenOutputSpeed } from "./use-token-output-speed"
import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import {
  getSessionOutputSpeed,
  resetSessionOutputSpeedForTests,
} from "@/lib/session-output-speed"

function msg(blocks: LiveContentBlock[], id = "live-1"): LiveMessage {
  return { id, role: "assistant", content: blocks, startedAt: 0 }
}

function toolBlock(
  status: "pending" | "in_progress" | "completed"
): LiveContentBlock {
  return {
    type: "tool_call",
    info: {
      tool_call_id: "tc-1",
      title: "tool",
      kind: "tool",
      status,
      content: null,
      raw_input: null,
      raw_output_chunks: [],
      raw_output_total_bytes: 0,
      locations: null,
      meta: null,
      images: [],
    },
  }
}

/** A completed tool call — content the turn carries but never scores. */
const TOOL_BLOCK: LiveContentBlock = toolBlock("completed")
const RUNNING_TOOL: LiveContentBlock = toolBlock("in_progress")

let fakeNow = 0

function mount(
  message: LiveMessage,
  options: { conversationId?: number; waiting?: boolean } = {}
) {
  return renderHook(
    ({
      message,
      conversationId,
      waiting,
    }: {
      message: LiveMessage
      conversationId?: number
      waiting?: boolean
    }) => useTokenOutputSpeed(message, { conversationId, waiting }),
    { initialProps: { message, ...options } }
  )
}

/** Advance one sample period (or several), keeping the fake clock in step. */
function tick(ms = 500) {
  fakeNow += ms
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  fakeNow = 1000
  vi.useFakeTimers()
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetSessionOutputSpeedForTests()
})

describe("useTokenOutputSpeed", () => {
  it("reports an estimated rate once a sample covers real wall clock", () => {
    // 80 latin chars = 20 tokens, taken as the baseline at mount.
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(80) }])
    )
    expect(result.current).toBeNull()

    // +200 chars = +50 tokens over the 500ms sample = 100 tok/s.
    rerender({ message: msg([{ type: "text", text: "a".repeat(280) }]) })
    tick()
    expect(result.current).toBeCloseTo(100)
  })

  it("counts thinking blocks and skips sub-agent blocks", () => {
    const { result, rerender } = mount(
      msg([
        { type: "text", text: "a".repeat(80) },
        { type: "thinking", text: "a".repeat(80) },
        { type: "text", text: "a".repeat(800), parentToolUseId: "pt-1" },
      ])
    )

    rerender({
      message: msg([
        { type: "text", text: "a".repeat(160) },
        { type: "thinking", text: "a".repeat(160) },
        { type: "text", text: "a".repeat(900), parentToolUseId: "pt-1" },
      ]),
    })
    tick()
    // 160 new root chars = 40 tokens in half a second; the sub-agent's 100 new
    // chars belong to its own capsule and score nothing here.
    expect(result.current).toBeCloseTo(80)
  })

  it("keeps the wait for the first token out of the rate", () => {
    // A turn opens with an empty message (`STATUS_CHANGED("prompting")`) and the
    // model may think for seconds before its first token. That silence is
    // latency, not slow output: averaged in, a 100 tok/s stream would open at a
    // third of its rate and take seconds to climb.
    const { result, rerender } = mount(msg([]))
    for (let i = 0; i < 6; i++) tick()
    expect(result.current).toBeNull()

    // 200 latin chars = 50 tokens, all of them produced inside this one 500ms
    // sample — so the first reading is the true 100 tok/s, neither dragged down
    // by the three idle seconds nor thrown away as a bare baseline.
    rerender({ message: msg([{ type: "text", text: "a".repeat(200) }]) })
    tick()
    expect(result.current).toBeCloseTo(100)
  })

  it("stays hidden until the turn has produced output", () => {
    // A turn that opens with a long tool call and no text: content is flowing,
    // but reading "0.0 tok/s" off it for ten seconds would be noise.
    const { result, rerender } = mount(msg([TOOL_BLOCK]))
    for (let i = 0; i < 20; i++) tick()
    expect(result.current).toBeNull()

    rerender({
      message: msg([TOOL_BLOCK, { type: "text", text: "a".repeat(400) }]),
    })
    tick()
    expect(result.current).not.toBeNull()
    expect(result.current as number).toBeGreaterThan(0)
  })

  it("re-seats when a snapshot hydration replaces the live message", () => {
    // Hydration swaps the message out wholesale instead of appending, so the
    // accumulator's cached per-block prefixes can describe unrelated text. The
    // replacement here is longer than what was cached but shares no prefix — if
    // the reading trusted the cache it would measure only the length difference
    // and report a far too small rate.
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(400) }], "live-1")
    )

    rerender({
      message: msg([{ type: "text", text: "b".repeat(800) }], "live-2"),
    })
    tick()
    // The re-seat drops the baseline, so this sample only seeds.
    expect(result.current).toBeNull()

    // 800 → 1200 chars of the hydrated message = 100 new tokens in half a
    // second, i.e. 200 tok/s — not the 100 chars a cache-trusting measure
    // would have seen.
    rerender({
      message: msg([{ type: "text", text: "b".repeat(1200) }], "live-2"),
    })
    tick()
    expect(result.current).toBeCloseTo(200)
  })

  it("decays through a silent generating gap instead of freezing the reading", () => {
    // No new content and no in-flight tool — a slow decode, not a wait. The
    // reading has to fall so a genuinely slow stream is not reported as fast.
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(80) }])
    )
    const stalled = msg([{ type: "text", text: "a".repeat(280) }])
    rerender({ message: stalled })
    tick()
    expect(result.current).toBeCloseTo(100)

    for (let i = 0; i < 20; i++) tick()
    expect(result.current as number).toBeLessThan(5)
  })

  it("holds the reading while a tool is running", () => {
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(80) }])
    )
    rerender({
      message: msg([{ type: "text", text: "a".repeat(280) }]),
    })
    tick()
    expect(result.current).toBeCloseTo(100)

    rerender({
      message: msg([{ type: "text", text: "a".repeat(280) }, RUNNING_TOOL]),
    })
    for (let i = 0; i < 20; i++) tick()
    expect(result.current).toBeCloseTo(100)
  })

  it("does not fold a tool wait into the next generating sample", () => {
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(80) }]),
      { conversationId: 9 }
    )
    rerender({
      message: msg([{ type: "text", text: "a".repeat(280) }]),
      conversationId: 9,
    })
    tick()
    expect(result.current).toBeCloseTo(100)

    rerender({
      message: msg([{ type: "text", text: "a".repeat(280) }, RUNNING_TOOL]),
      conversationId: 9,
    })
    for (let i = 0; i < 20; i++) tick()

    // 200 new chars = 50 tokens in the 500ms sample after the wait.
    rerender({
      message: msg([{ type: "text", text: "a".repeat(480) }]),
      conversationId: 9,
    })
    tick()
    expect(result.current as number).toBeGreaterThan(50)
    const session = getSessionOutputSpeed(9)
    expect(session).not.toBeNull()
    // Generating time is the two 500ms windows, not the 10s wait.
    expect(session!.generatingMs).toBeLessThan(2000)
    expect(session!.averageTps).toBeGreaterThan(50)
  })

  it("repaints on its own cadence, not on every delta", () => {
    const { result, rerender } = mount(
      msg([{ type: "text", text: "a".repeat(80) }])
    )
    rerender({ message: msg([{ type: "text", text: "a".repeat(280) }]) })
    tick()
    expect(result.current).toBeCloseTo(100)

    // A big jump well inside the sample window: still the previous reading.
    rerender({ message: msg([{ type: "text", text: "a".repeat(4000) }]) })
    tick(200)
    expect(result.current).toBeCloseTo(100)

    // Past the window, it catches up.
    tick(300)
    expect(result.current as number).toBeGreaterThan(100)
  })
})

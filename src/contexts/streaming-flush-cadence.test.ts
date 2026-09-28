import { describe, expect, it } from "vitest"
import {
  type LiveContentBlock,
  STREAM_FLUSH_FRAME_MS,
  STREAM_FLUSH_MAX_MS,
  type ToolCallInfo,
  liveRerenderChars,
  streamFlushDelayMs,
} from "@/contexts/acp-connections-context"

const text = (chars: number): LiveContentBlock => ({
  type: "text",
  text: "x".repeat(chars),
})
const thinking = (chars: number): LiveContentBlock => ({
  type: "thinking",
  text: "t".repeat(chars),
})
const toolCall = (id: string): LiveContentBlock => ({
  type: "tool_call",
  info: {
    tool_call_id: id,
    title: "Bash",
    kind: "execute",
    status: "completed",
    content: null,
    raw_input: '{"command":"ls"}',
    // The card renders a clamped preview, so its cost does not scale with
    // however much output the tool produced.
    raw_output_chunks: ["y".repeat(50_000)],
    raw_output_total_bytes: 50_000,
    locations: null,
    meta: null,
    images: [],
  } satisfies ToolCallInfo,
})

describe("liveRerenderChars", () => {
  it("charges the trailing run, which is the block a batch grows", () => {
    expect(liveRerenderChars([text(4000)])).toBe(4000)
    expect(liveRerenderChars([thinking(4000)])).toBe(4000)
  })

  it("charges nothing for prose the batch leaves alone", () => {
    // `TextPart` memoizes on the string by value, so a settled run bails out
    // before the markdown renderer — measured at zero for eight 8 KB blocks.
    expect(liveRerenderChars([text(8192), text(8192), text(100)])).toBe(100)
  })

  it("charges a flat rate per card, whatever the card is holding", () => {
    const perBlock = liveRerenderChars([toolCall("a"), text(0)])
    expect(perBlock).toBeGreaterThan(0)
    // Independent of the 50 KB of raw output on the block.
    expect(liveRerenderChars([toolCall("a"), toolCall("b"), text(0)])).toBe(
      2 * perBlock
    )
    // …and it is small next to a run: cards move the window, prose sets it.
    expect(perBlock).toBeLessThan(1024)
  })

  it("puts a tool-heavy turn past the first step on its own", () => {
    const cards: LiveContentBlock[] = []
    for (let i = 0; i < 100; i++) cards.push(toolCall(`call-${i}`))
    // A hundred tools then a 2 KB summary: the run alone would read as one
    // frame, while every one of those cards re-renders on every batch.
    expect(streamFlushDelayMs(liveRerenderChars([...cards, text(2048)]))).toBe(
      2 * STREAM_FLUSH_FRAME_MS
    )
    expect(streamFlushDelayMs(liveRerenderChars([text(2048)]))).toBe(
      STREAM_FLUSH_FRAME_MS
    )
  })

  it("is zero for a turn that has said nothing yet", () => {
    expect(liveRerenderChars(undefined)).toBe(0)
    expect(liveRerenderChars([])).toBe(0)
  })
})

describe("streamFlushDelayMs", () => {
  it("leaves an ordinary reply on the single-frame window it has today", () => {
    for (const chars of [0, 1, 200, 4096, 8192]) {
      expect(streamFlushDelayMs(chars)).toBe(STREAM_FLUSH_FRAME_MS)
    }
  })

  it("buys one more frame per further 8 KB, up to the ceiling", () => {
    expect(streamFlushDelayMs(8193)).toBe(2 * STREAM_FLUSH_FRAME_MS)
    expect(streamFlushDelayMs(16 * 1024)).toBe(2 * STREAM_FLUSH_FRAME_MS)
    expect(streamFlushDelayMs(32 * 1024)).toBe(4 * STREAM_FLUSH_FRAME_MS)
    expect(streamFlushDelayMs(64 * 1024)).toBe(8 * STREAM_FLUSH_FRAME_MS)
    expect(streamFlushDelayMs(1024 * 1024)).toBe(STREAM_FLUSH_MAX_MS)
  })

  it("never returns a window that would stall or spin", () => {
    for (const chars of [-1, 0, Number.MAX_SAFE_INTEGER]) {
      const delay = streamFlushDelayMs(chars)
      expect(delay).toBeGreaterThanOrEqual(STREAM_FLUSH_FRAME_MS)
      expect(delay).toBeLessThanOrEqual(STREAM_FLUSH_MAX_MS)
    }
  })
})

/**
 * Replay a 300 tok/s stream (one 4-character chunk per token) through a flush
 * schedule and report what it costs.
 *
 * `charsRendered` is the metric #589 is about: every batch re-renders the prose
 * run it appended to, whole, and that cost is linear in the run's length. With
 * a flat window the rate is constant while the run keeps growing, so the total
 * climbs with the square of the turn's own output.
 */
function replay(
  seconds: number,
  delayFor: (runChars: number) => number
): { flushes: number; charsRendered: number; delivered: number } {
  const CHUNK_CHARS = 4
  const MS_PER_CHUNK = 1000 / 300
  const chunks = seconds * 300

  let run = 0
  let pending = 0
  let nextFlushAt = delayFor(0)
  let flushes = 0
  let charsRendered = 0

  for (let i = 0; i < chunks; i++) {
    pending += CHUNK_CHARS
    const now = (i + 1) * MS_PER_CHUNK
    if (now < nextFlushAt) continue
    run += pending
    pending = 0
    flushes++
    charsRendered += run
    nextFlushAt = now + delayFor(run)
  }
  // The turn always ends on an explicit flush (`turn_complete`).
  if (pending > 0) {
    run += pending
    flushes++
    charsRendered += run
  }
  return { flushes, charsRendered, delivered: run }
}

const flatWindow = () => STREAM_FLUSH_FRAME_MS

describe("what the flush cadence costs at 300 tokens/sec", () => {
  it("delivers every character either way", () => {
    for (const seconds of [10, 30, 120]) {
      const expected = seconds * 300 * 4
      expect(replay(seconds, flatWindow).delivered).toBe(expected)
      expect(replay(seconds, streamFlushDelayMs).delivered).toBe(expected)
    }
  })

  it("stops the re-render cost climbing with the square of the answer", () => {
    const flat30 = replay(30, flatWindow)
    const flat120 = replay(120, flatWindow)
    const now30 = replay(30, streamFlushDelayMs)
    const now120 = replay(120, streamFlushDelayMs)

    // A flat window makes four times the output cost sixteen times the work.
    expect(flat120.charsRendered / flat30.charsRendered).toBeGreaterThan(12)

    // Backing off keeps that growth near linear…
    expect(now120.charsRendered / now30.charsRendered).toBeLessThan(8)
    // …and cuts the absolute cost at both lengths.
    expect(now30.charsRendered).toBeLessThan(flat30.charsRendered * 0.45)
    expect(now120.charsRendered).toBeLessThan(flat120.charsRendered * 0.2)
  })

  it("leaves a short answer on exactly the cadence it has today", () => {
    // Five seconds at 300 tok/s is 6 KB — under the first step, so the
    // schedule is unchanged for the replies almost every turn produces.
    expect(replay(5, streamFlushDelayMs)).toEqual(replay(5, flatWindow))
  })
})

/**
 * Pure helpers behind the live token-output-speed reading in the streaming turn
 * row (`useTokenOutputSpeed`). Everything here is a function of its arguments —
 * no clock, no DOM — so the heuristic, the incremental accounting and the
 * smoothing are exactly testable.
 *
 * The char→token ratios are deliberately rough ("大差不差"): CJK-family scripts
 * tokenize denser than Latin, so we count them at ~1.8 chars/token and every
 * other visible character at ~4 chars/token. Whitespace is skipped entirely.
 * TODO: fixed ratios, and kana/Hangul are really denser than Han (~1.2 rather
 * than ~1.8). Calibrate per model from the turn's reported output usage if
 * accuracy ever matters more than the live gauge.
 */

/** Chars per token for the dense scripts — Han, kana, Hangul, fullwidth forms. */
const DENSE_CHARS_PER_TOKEN = 1.8
/** Chars per token for everything else — Latin, digits, punctuation, symbols. */
const OTHER_CHARS_PER_TOKEN = 4

/**
 * Mirrors the JS regex `\s` class. Hand-rolled rather than `/\s/` because this
 * re-measures a growing turn on every sample: a char-code scan allocates
 * nothing, where `text.replace(/\s/g, "")` copies the whole string every call.
 */
function isSpace(code: number): boolean {
  if (code === 0x20) return true // space — by far the most common case
  if (code <= 0x0d) return code >= 0x09 // \t \n \v \f \r
  if (code < 0xa0) return false
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 || // ideographic space — whitespace, NOT a dense char
    code === 0xfeff
  )
}

/**
 * CJK-family code units, i.e. the scripts that tokenize at roughly one token
 * per one-to-two characters. Deliberately wider than "Han": kana and Hangul
 * tokenize just as densely, and counting them as Latin under-reports Japanese
 * and Korean output by more than 2x.
 *
 * High surrogates count as one dense char and low surrogates as nothing, so an
 * astral character (CJK Ext B, emoji) scores once — and the count stays exactly
 * additive even when an incremental measurement splits a surrogate pair.
 */
function isDense(code: number): boolean {
  if (code < 0x2e80) {
    // Hangul Jamo. Everything below it (ASCII, Latin, Greek, Cyrillic, …) is
    // "other", so this single compare short-circuits the whole Latin hot path.
    return code >= 0x1100 && code <= 0x11ff
  }
  return (
    (code >= 0x2e80 && code <= 0x303f) || // CJK radicals + symbols & punctuation (。\u3001「」)
    (code >= 0x3040 && code <= 0x30ff) || // hiragana + katakana
    (code >= 0x3130 && code <= 0x318f) || // Hangul compatibility jamo
    (code >= 0x31c0 && code <= 0x4dbf) || // CJK strokes, enclosed CJK, CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xa960 && code <= 0xa97f) || // Hangul jamo extended-A
    (code >= 0xac00 && code <= 0xd7ff) || // Hangul syllables + jamo extended-B
    (code >= 0xd800 && code <= 0xdbff) || // high surrogate — see doc comment
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xffef) // halfwidth + fullwidth forms
  )
}

export interface CharCounts {
  dense: number
  other: number
}

/**
 * Count the visible characters of `text` from `from` onward, bucketed by
 * density. Exactly additive over concatenation — both buckets are per-code-unit
 * counts and neither straddles a boundary — so measuring only the appended
 * suffix yields the same totals as re-measuring the whole string.
 */
export function countChars(text: string, from = 0): CharCounts {
  let dense = 0
  let other = 0
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isSpace(code)) continue
    if (code >= 0xdc00 && code <= 0xdfff) continue // low surrogate — already paired
    if (isDense(code)) dense++
    else other++
  }
  return { dense, other }
}

/** Rough token count for `text`, from `from` onward. */
export function estimateTokens(text: string, from = 0): number {
  const { dense, other } = countChars(text, from)
  return dense / DENSE_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN
}

/**
 * Running token total across the live message's eligible blocks, measured
 * incrementally.
 *
 * The naive version — re-running `estimateTokens` over every block on every
 * sample — is O(turn) per sample and so O(turn²) over a turn. Blocks are
 * append-only within a turn, so we keep each block's consumed length and
 * measure only what was appended, which reduces an unchanged block to a single
 * length compare.
 *
 * One pass per sample, feeding the eligible blocks in their (stable) order:
 *
 * ```ts
 * counts.beginPass()
 * for (const block of eligible) counts.push(block.text)
 * const total = counts.endPass()
 * ```
 */
export class TokenCountAccumulator {
  private slots: { len: number; dense: number; other: number }[] = []
  private cursor = 0
  private dense = 0
  private other = 0

  /** Drop everything — a new turn starts from zero. */
  reset(): void {
    this.slots = []
    this.cursor = 0
    this.dense = 0
    this.other = 0
  }

  /** Start a measurement pass over the current blocks. */
  beginPass(): void {
    this.cursor = 0
  }

  /** Feed the current full text of the next eligible block, in stable order. */
  push(text: string): void {
    const slot = this.slots[this.cursor++]
    if (slot === undefined) {
      const { dense, other } = countChars(text)
      this.slots.push({ len: text.length, dense, other })
      this.dense += dense
      this.other += other
      return
    }
    if (text.length === slot.len) return // unchanged — the common case
    if (text.length > slot.len) {
      const { dense, other } = countChars(text, slot.len)
      slot.len = text.length
      slot.dense += dense
      slot.other += other
      this.dense += dense
      this.other += other
      return
    }
    // Shorter than what we already counted: the block was replaced rather than
    // appended to (a snapshot hydration re-seating the turn). Re-measure it.
    const { dense, other } = countChars(text)
    this.dense += dense - slot.dense
    this.other += other - slot.other
    slot.len = text.length
    slot.dense = dense
    slot.other = other
  }

  /** End the pass, dropping blocks it never reached, and return the total. */
  endPass(): number {
    for (let i = this.cursor; i < this.slots.length; i++) {
      this.dense -= this.slots[i].dense
      this.other -= this.slots[i].other
    }
    if (this.cursor < this.slots.length) this.slots.length = this.cursor
    return this.total
  }

  /** Estimated tokens across every block seen so far. */
  get total(): number {
    return (
      this.dense / DENSE_CHARS_PER_TOKEN + this.other / OTHER_CHARS_PER_TOKEN
    )
  }
}

export interface TokenSpeedSample {
  tokens: number
  dt: number // in seconds
}

/**
 * Rolling average velocity tracker over recent output samples.
 *
 * Inspired by Hermes's implementation (`deque(maxlen=10)` in `agent/turn_usage.py`
 * and status bar velocity calculation in `cli_status_bar_mixin.py`):
 *
 * 1. Window size: Tracks the last 10 active output samples (`DEFAULT_WINDOW_SIZE = 10`).
 * 2. True throughput formula: `sum(tokens) / sum(latency)` across the window,
 *    not the mean of instant ratios.
 * 3. Silent gap behavior: When no new tokens are produced (e.g. during tool execution,
 *    network pauses, or when text generation finishes before the turn ends), the tracker
 *    preserves the rolling average velocity of the last active output samples rather than
 *    decaying to 0. This prevents the gauge from getting stuck at "0 tokens/s".
 * 4. Idle gap handling: If an idle gap precedes a new batch of tokens, the generation
 *    duration for that batch is clamped so tool pauses are not treated as slow generation.
 */
export class TokenSpeedTracker {
  /** Maximum number of recent output samples to average over (matches Hermes's deque(maxlen=10)). */
  static readonly DEFAULT_WINDOW_SIZE = 10

  /** Hold the reading back until it covers a meaningful window of wall clock. */
  private static readonly WARMUP_MS = 300

  /**
   * Threshold (in ms) above which an interval between tokens is treated as an
   * idle pause (tool execution, thinking pause) rather than active generation.
   */
  private static readonly IDLE_GAP_MS = 1500

  /** Fallback duration (in seconds) for a token batch arriving after an idle gap. */
  private static readonly FALLBACK_SAMPLE_DT_S = 0.5

  private readonly windowSize: number
  private readonly samples: TokenSpeedSample[] = []
  private lastTime: number | null = null
  private lastTokens = 0
  private totalActiveDtMs = 0

  constructor(windowSize: number = TokenSpeedTracker.DEFAULT_WINDOW_SIZE) {
    this.windowSize = Math.max(1, windowSize)
  }

  reset(): void {
    this.samples.length = 0
    this.lastTime = null
    this.lastTokens = 0
    this.totalActiveDtMs = 0
  }

  /**
   * Feed the cumulative estimated token count at `nowMs`.
   * Returns rolling average tok/s over the last (up to 10) output samples,
   * or `null` while seeding / warming up.
   */
  observe(totalTokens: number, nowMs: number): number | null {
    if (this.lastTime == null) {
      this.lastTime = nowMs
      this.lastTokens = totalTokens
      return this.read()
    }

    const dtMs = nowMs - this.lastTime
    if (dtMs <= 0) {
      return this.read()
    }

    const deltaTokens = totalTokens - this.lastTokens

    if (deltaTokens > 0) {
      let dtSec: number
      if (dtMs > TokenSpeedTracker.IDLE_GAP_MS) {
        dtSec = TokenSpeedTracker.FALLBACK_SAMPLE_DT_S
        this.totalActiveDtMs += TokenSpeedTracker.FALLBACK_SAMPLE_DT_S * 1000
      } else {
        dtSec = dtMs / 1000
        this.totalActiveDtMs += dtMs
      }

      this.samples.push({ tokens: deltaTokens, dt: dtSec })
      if (this.samples.length > this.windowSize) {
        this.samples.shift()
      }

      this.lastTime = nowMs
      this.lastTokens = totalTokens
    }

    // If deltaTokens <= 0, no new tokens produced.
    // Unlike old EWMA, we do NOT push 0-token samples into the history and do NOT
    // decay the rate to 0. We hold the rolling average velocity and leave lastTime
    // untouched so the full duration until the next batch is measured correctly
    // (or clamped if it exceeds IDLE_GAP_MS).

    return this.read()
  }

  /**
   * Compute rolling average velocity: sum(tokens) / sum(dt), matching Hermes's
   * true throughput formula:
   *   avg_vel = sum(output_tokens) / sum(latency) (true throughput, not mean of ratios)
   */
  private read(): number | null {
    if (
      this.samples.length === 0 ||
      this.totalActiveDtMs < TokenSpeedTracker.WARMUP_MS
    ) {
      return null
    }

    let sumTokens = 0
    let sumDt = 0
    for (const s of this.samples) {
      sumTokens += s.tokens
      sumDt += s.dt
    }

    if (sumDt <= 0) {
      return null
    }

    return sumTokens / sumDt
  }
}

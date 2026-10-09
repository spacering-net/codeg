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
    (code >= 0x2e80 && code <= 0x303f) || // CJK radicals + symbols & punctuation (。、「」)
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

export interface TokenSpeedObserveOptions {
  /**
   * True while the turn is blocked on something that is not generation
   * (an in-flight tool, a permission prompt, a question). Idle time is
   * skipped: the clock advances so the next generating sample is not
   * diluted, and the EWMA holds instead of decaying toward zero.
   */
  pause?: boolean
}

/**
 * First-order low-pass over instantaneous token rates. Time-constant based
 * (rather than per-sample alpha) so the reading doesn't depend on how regularly
 * the caller samples.
 *
 * Generation time is the only time that counts. A tool wait, a permission
 * prompt, or any other pause is `observe(..., { pause: true })`: the last
 * reading is held and the idle span is excluded from the next sample's `dt`.
 * Short gaps *while generating* (batched deltas, a slow decode) still feed a
 * zero instant so a genuinely slow stream is not mistaken for a fast one.
 *
 * The accumulated weight is tracked alongside the average and divided back out
 * (bias correction). Without it the filter cold-starts from its first sample,
 * and a turn's first sample is routinely near-zero — it lands on whatever
 * fraction of a batched content delta had arrived by then. That made the
 * reading open at `0.0` and crawl toward the truth over several seconds. With
 * the correction it is the turn's cumulative average until `TAU_MS` has
 * elapsed, and an exponential window after that.
 */
export class TokenSpeedTracker {
  private static readonly TAU_MS = 1500
  /** Hold the reading back until it covers a meaningful slice of generating time. */
  private static readonly WARMUP_MS = 300

  private lastTime: number | null = null
  private lastTokens = 0
  private elapsed = 0
  private ewma = 0
  private weight = 0
  private generatingMs = 0
  private generatingTokens = 0

  reset(): void {
    this.lastTime = null
    this.lastTokens = 0
    this.elapsed = 0
    this.ewma = 0
    this.weight = 0
    this.generatingMs = 0
    this.generatingTokens = 0
  }

  /** Generating-only elapsed time, excluding pauses. */
  get generatingElapsedMs(): number {
    return this.generatingMs
  }

  /** Tokens observed during generating windows. */
  get generatingTokenCount(): number {
    return this.generatingTokens
  }

  /**
   * Tokens / generating-seconds for this tracker (one turn). `null` until
   * enough generating time has accumulated to be meaningful.
   */
  average(): number | null {
    if (this.generatingMs < TokenSpeedTracker.WARMUP_MS) return null
    return this.generatingTokens / (this.generatingMs / 1000)
  }

  /** Feed the cumulative estimated token count at `nowMs`; returns smoothed
   *  tok/s, or `null` while seeding / warming up. */
  observe(
    totalTokens: number,
    nowMs: number,
    options: TokenSpeedObserveOptions = {}
  ): number | null {
    if (this.lastTime == null) {
      this.lastTime = nowMs
      this.lastTokens = totalTokens
      return null
    }
    const dt = nowMs - this.lastTime
    if (dt <= 0) return this.read()
    if (options.pause) {
      // Hold the last reading and drop this span so a later generating
      // sample is not tokens / (generate + wait).
      this.lastTime = nowMs
      this.lastTokens = totalTokens
      return this.read()
    }
    const delta = totalTokens - this.lastTokens
    const instant = delta / (dt / 1000)
    this.lastTime = nowMs
    this.lastTokens = totalTokens
    this.elapsed += dt
    this.generatingMs += dt
    if (delta > 0) this.generatingTokens += delta
    const alpha = 1 - Math.exp(-dt / TokenSpeedTracker.TAU_MS)
    this.ewma = this.ewma * (1 - alpha) + instant * alpha
    // Stays exactly equal to `1 - exp(-elapsed / TAU_MS)`.
    this.weight = this.weight * (1 - alpha) + alpha
    return this.read()
  }

  private read(): number | null {
    if (this.elapsed < TokenSpeedTracker.WARMUP_MS || this.weight <= 0) {
      return null
    }
    return this.ewma / this.weight
  }
}

/** Format a tok/s reading the same way the live turn row does. */
export function formatTokPerSec(tps: number): string {
  return `${tps.toFixed(1)} tok/s`
}

/**
 * Session/dashboard average: output tokens over recorded generation time.
 * `null` until both sides are meaningful, so a 0ms or 0-output row does not
 * render as `0.0 tok/s`.
 */
export function averageOutputTps(
  outputTokens: number,
  durationMs: number
): number | null {
  if (!(outputTokens > 0) || durationMs < 300) return null
  return outputTokens / (durationMs / 1000)
}

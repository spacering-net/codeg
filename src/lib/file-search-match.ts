/**
 * Lightweight ranked matcher for the file-search picker. No external fuzzy
 * dependency: a single pass scores each candidate into ordered tiers (exact name
 * → name prefix → name substring → path substring → subsequence), so the most
 * relevant files float to the top. Callers scan the *entire* candidate list and
 * keep the best `limit`, which is what lets a deeply nested file surface even
 * when many shallower files also match.
 *
 * Candidates carry pre-lowercased `lowerName`/`lowerPath` (see `FlatFileEntry`),
 * so matching stays allocation-free and fast enough to run on every keystroke.
 */

export interface FileSearchCandidate {
  /** Lowercased basename. */
  lowerName: string
  /** Lowercased path relative to the workspace root. */
  lowerPath: string
}

// Tier dominates the score; within a tier, an earlier match position wins, then
// a shorter candidate. The multipliers leave a wide margin so position/length
// adjustments can never bump a candidate across a tier boundary.
const TIER_BASE = 100_000_000

const TIER_EXACT_NAME = 6
const TIER_NAME_PREFIX = 5
const TIER_NAME_SUBSTRING = 4
const TIER_PATH_SUBSTRING = 3
const TIER_NAME_SUBSEQUENCE = 2
const TIER_PATH_SUBSEQUENCE = 1

function tierScore(tier: number, position: number, length: number): number {
  return (
    tier * TIER_BASE - Math.min(position, 9_999) * 1_000 - Math.min(length, 999)
  )
}

/**
 * Index of the first matched character if every char of `query` appears in `s`
 * in order (a subsequence), else -1. `query` must be non-empty.
 */
function subsequenceFirstIndex(query: string, s: string): number {
  let qi = 0
  let firstIdx = -1
  for (let si = 0; si < s.length && qi < query.length; si++) {
    if (s[si] === query[qi]) {
      if (qi === 0) firstIdx = si
      qi++
    }
  }
  return qi === query.length ? firstIdx : -1
}

/**
 * Score one candidate against an already-lowercased, non-empty `query`.
 * Higher is better; returns `null` when the candidate does not match at all.
 */
export function scoreFileMatch(
  query: string,
  lowerName: string,
  lowerPath: string
): number | null {
  if (!query) return null

  if (lowerName === query) {
    return tierScore(TIER_EXACT_NAME, 0, lowerName.length)
  }
  if (lowerName.startsWith(query)) {
    return tierScore(TIER_NAME_PREFIX, 0, lowerName.length)
  }
  const nameIdx = lowerName.indexOf(query)
  if (nameIdx !== -1) {
    return tierScore(TIER_NAME_SUBSTRING, nameIdx, lowerName.length)
  }
  const pathIdx = lowerPath.indexOf(query)
  if (pathIdx !== -1) {
    return tierScore(TIER_PATH_SUBSTRING, pathIdx, lowerPath.length)
  }
  const nameSub = subsequenceFirstIndex(query, lowerName)
  if (nameSub !== -1) {
    return tierScore(TIER_NAME_SUBSEQUENCE, nameSub, lowerName.length)
  }
  const pathSub = subsequenceFirstIndex(query, lowerPath)
  if (pathSub !== -1) {
    return tierScore(TIER_PATH_SUBSEQUENCE, pathSub, lowerPath.length)
  }
  return null
}

/**
 * Rank `items` against `query`, returning the best `limit` matches (highest
 * score first). An empty query returns the first `limit` items unchanged, so the
 * picker shows a sensible default listing before the user types.
 */
export function rankFileMatches<T extends FileSearchCandidate>(
  query: string,
  items: readonly T[],
  limit: number
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, limit)

  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = scoreFileMatch(q, item.lowerName, item.lowerPath)
    if (score !== null) scored.push({ item, score })
  }
  // ES2019 guarantees a stable sort, so equal scores keep the input order
  // (alphabetical, as produced by the backend walk).
  scored.sort((a, b) => b.score - a.score)

  const result: T[] = []
  for (let i = 0; i < scored.length && i < limit; i++) {
    result.push(scored[i].item)
  }
  return result
}

/** A highlighted `[start, end)` span, in UTF-16 code units. */
export type HighlightRange = [number, number]

/** Indices of `query`'s characters as an in-order subsequence of `s`, or null. */
function subsequenceIndices(query: string, s: string): number[] | null {
  const out: number[] = []
  let qi = 0
  for (let si = 0; si < s.length && qi < query.length; si++) {
    if (s[si] === query[qi]) {
      out.push(si)
      qi++
    }
  }
  return qi === query.length ? out : null
}

/** Merge sorted character indices into contiguous ranges. */
function indicesToRanges(indices: readonly number[]): HighlightRange[] {
  const out: HighlightRange[] = []
  for (const i of indices) {
    const last = out[out.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else out.push([i, i + 1])
  }
  return out
}

/**
 * Where `query` matched `path` (a forward-slashed relative path), as ranges to
 * highlight. Follows the tiers of {@link scoreFileMatch} so the highlight shows
 * the match that ranked the row: a substring of the name, else of the path,
 * else the characters of a subsequence (name first, then path). Empty when the
 * query is blank or does not match.
 */
export function fileMatchHighlights(
  query: string,
  path: string
): HighlightRange[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const lowerPath = path.toLowerCase()
  // Lowercasing can change the length of a few characters (e.g. "İ"); the
  // indices would then point at the wrong characters, so show none.
  if (lowerPath.length !== path.length) return []
  const nameStart = path.lastIndexOf("/") + 1
  const lowerName = lowerPath.slice(nameStart)

  const nameIdx = lowerName.indexOf(q)
  if (nameIdx !== -1) {
    return [[nameStart + nameIdx, nameStart + nameIdx + q.length]]
  }
  const pathIdx = lowerPath.indexOf(q)
  if (pathIdx !== -1) return [[pathIdx, pathIdx + q.length]]
  const nameSub = subsequenceIndices(q, lowerName)
  if (nameSub) return indicesToRanges(nameSub.map((i) => i + nameStart))
  const pathSub = subsequenceIndices(q, lowerPath)
  return pathSub ? indicesToRanges(pathSub) : []
}

/**
 * Clip `ranges` (sorted, over a string) to the window `[from, to)` and shift
 * them to start at 0, for highlighting one slice of the string.
 */
export function sliceHighlightRanges(
  ranges: readonly HighlightRange[],
  from: number,
  to: number
): HighlightRange[] {
  const out: HighlightRange[] = []
  for (const [start, end] of ranges) {
    const s = Math.max(start, from)
    const e = Math.min(end, to)
    if (e > s) out.push([s - from, e - from])
  }
  return out
}

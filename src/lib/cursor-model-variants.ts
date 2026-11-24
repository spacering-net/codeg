/**
 * Decompose `cursor-agent models` ids into a model family plus its variant
 * dimensions, so the Cursor settings panel can offer "which model" separately
 * from "how hard should it think" and "run it Fast".
 *
 * The CLI lists every combination as its own flat id — `claude-opus-5-low`,
 * `claude-opus-5-thinking-max-fast`, `gpt-5.3-codex-xhigh` — around 200 of
 * them, which is unusable as one list and hides the two knobs that actually
 * matter. The grammar is a suffix chain:
 *
 *     <base>[-thinking][-<effort>][-fast]
 *
 * IMPORTANT: this module never *synthesizes* an id. It splits the ids the CLI
 * reported to group them, and every value it hands back is one of those exact
 * strings, looked up in the table it built. That matters because the suffix
 * grammar is genuinely ambiguous — Cursor also ships legacy aliases whose own
 * name ends in an effort token (`claude-4.5-opus-high`, which is a base, not
 * `claude-4.5-opus` at high effort). A mis-split there costs a slightly odd
 * grouping; it can never produce an id `--model` would reject.
 *
 * The live ACP session exposes the same knobs authoritatively (cursor-agent's
 * parameterized model picker, opted into via `_meta.parameterizedModelPicker`),
 * including `context`, which the flat CLI ids do not encode. This is the
 * launch-default half of the same choice.
 */

/** Cursor's thinking-effort ladder, weakest first. Order is the metric used to
 *  clamp onto the nearest still-available effort when a combination is gone. */
export const CURSOR_EFFORT_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type CursorEffort = (typeof CURSOR_EFFORT_ORDER)[number]

const EFFORTS = new Set<string>(CURSOR_EFFORT_ORDER)

/** One row of `cursor-agent models` (`<id> - <label>`, plus the default flag). */
export interface CursorModelEntry {
  id: string
  label: string
  isDefault: boolean
}

/** The variant axes a family may vary on. `effort: null` = the family has no
 *  effort token at all (e.g. `composer-2.5`), which is distinct from "none". */
export interface CursorVariant {
  thinking: boolean
  effort: CursorEffort | null
  fast: boolean
}

export interface CursorModelFamily {
  /** The id with its variant suffixes stripped — the grouping key. */
  base: string
  /** Display name shared by every member (their common word prefix). */
  label: string
  /** Whether the CLI marked one of the members as the account default. */
  isDefault: boolean
  /** Members, keyed by [`variantKey`]. Every value is a verbatim CLI id. */
  variants: Map<string, CursorModelEntry>
  /** The variant of each member, in CLI order — the source for the pickers. */
  members: { variant: CursorVariant; entry: CursorModelEntry }[]
}

/** Stable key for a variant triple. */
export function variantKey(variant: CursorVariant): string {
  return `${variant.thinking ? "t" : "-"}|${variant.effort ?? "-"}|${
    variant.fast ? "f" : "-"
  }`
}

/**
 * Split a flat model id into its base and variant. Purely syntactic: peel
 * `-fast`, then an effort token, then `-thinking`, in that order (the order the
 * CLI emits them in).
 */
export function decomposeCursorModelId(id: string): {
  base: string
  variant: CursorVariant
} {
  let rest = id
  let fast = false
  if (rest.endsWith("-fast")) {
    fast = true
    rest = rest.slice(0, -"-fast".length)
  }
  let effort: CursorEffort | null = null
  const lastDash = rest.lastIndexOf("-")
  if (lastDash > 0) {
    const tail = rest.slice(lastDash + 1)
    if (EFFORTS.has(tail)) {
      effort = tail as CursorEffort
      rest = rest.slice(0, lastDash)
    }
  }
  let thinking = false
  if (rest.endsWith("-thinking")) {
    thinking = true
    rest = rest.slice(0, -"-thinking".length)
  }
  return { base: rest, variant: { thinking, effort, fast } }
}

/**
 * The label a whole family should carry: the longest word prefix its members
 * share, so `Claude Opus 5 1M Low` / `Claude Opus 5 1M Max Thinking Fast`
 * collapse to `Claude Opus 5 1M`. Falls back to the base id when the members
 * share nothing (which only happens if Cursor relabels mid-family).
 */
function commonWordPrefix(labels: string[], fallback: string): string {
  if (labels.length === 0) return fallback
  const first = labels[0].split(/\s+/).filter(Boolean)
  let take = first.length
  for (const label of labels.slice(1)) {
    const words = label.split(/\s+/).filter(Boolean)
    let i = 0
    while (i < take && i < words.length && words[i] === first[i]) i++
    take = i
    if (take === 0) break
  }
  const prefix = first.slice(0, take).join(" ").trim()
  return prefix || fallback
}

/**
 * Group a model list into families, preserving the CLI's ordering (Cursor
 * returns them roughly best-first, which is the order worth showing).
 */
export function buildCursorModelFamilies(
  entries: CursorModelEntry[]
): CursorModelFamily[] {
  const byBase = new Map<string, CursorModelFamily>()
  for (const entry of entries) {
    const { base, variant } = decomposeCursorModelId(entry.id)
    let family = byBase.get(base)
    if (!family) {
      family = {
        base,
        label: base,
        isDefault: false,
        variants: new Map(),
        members: [],
      }
      byBase.set(base, family)
    }
    const key = variantKey(variant)
    // First writer wins: a duplicate combination would otherwise silently
    // re-point the family at a later, differently-labelled id.
    if (!family.variants.has(key)) {
      family.variants.set(key, entry)
      family.members.push({ variant, entry })
    }
    if (entry.isDefault) family.isDefault = true
  }
  for (const family of byBase.values()) {
    family.label = commonWordPrefix(
      family.members.map((m) => m.entry.label),
      family.base
    )
  }
  return [...byBase.values()]
}

/** Which values a dimension can take within a family (deduped, ordered). */
export function familyThinkingValues(family: CursorModelFamily): boolean[] {
  const seen = new Set(family.members.map((m) => m.variant.thinking))
  return [false, true].filter((v) => seen.has(v))
}

export function familyFastValues(family: CursorModelFamily): boolean[] {
  const seen = new Set(family.members.map((m) => m.variant.fast))
  return [false, true].filter((v) => seen.has(v))
}

export function familyEffortValues(
  family: CursorModelFamily
): (CursorEffort | null)[] {
  const seen = new Set(family.members.map((m) => m.variant.effort))
  const ordered: (CursorEffort | null)[] = CURSOR_EFFORT_ORDER.filter((e) =>
    seen.has(e)
  )
  if (seen.has(null)) ordered.unshift(null)
  return ordered
}

function effortDistance(
  a: CursorEffort | null,
  b: CursorEffort | null
): number {
  if (a === b) return 0
  if (a === null || b === null) return CURSOR_EFFORT_ORDER.length
  return Math.abs(
    CURSOR_EFFORT_ORDER.indexOf(a) - CURSOR_EFFORT_ORDER.indexOf(b)
  )
}

/**
 * Resolve a wanted variant to a real member of the family.
 *
 * Not every combination exists — `claude-opus-5` reaches `xhigh`/`max` only
 * with thinking on — so a pick has to be repaired rather than rejected.
 * `pinned` is the dimension the user just moved: it is held fixed, and among
 * the members that honour it the closest one wins, comparing
 * `[thinking mismatch, effort distance, fast mismatch]` in that order (keeping
 * a reasoning mode beats keeping a speed flag). Returns `null` only for an
 * empty family.
 */
export function resolveCursorVariant(
  family: CursorModelFamily,
  want: CursorVariant,
  pinned: keyof CursorVariant | null = null
): CursorModelEntry | null {
  const exact = family.variants.get(variantKey(want))
  if (exact) return exact
  const candidates = family.members.filter(
    (m) => pinned === null || m.variant[pinned] === want[pinned]
  )
  const pool = candidates.length > 0 ? candidates : family.members
  let best: { variant: CursorVariant; entry: CursorModelEntry } | null = null
  let bestScore: [number, number, number] | null = null
  for (const member of pool) {
    const score: [number, number, number] = [
      member.variant.thinking === want.thinking ? 0 : 1,
      effortDistance(member.variant.effort, want.effort),
      member.variant.fast === want.fast ? 0 : 1,
    ]
    if (
      bestScore === null ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] &&
        (score[1] < bestScore[1] ||
          (score[1] === bestScore[1] && score[2] < bestScore[2])))
    ) {
      best = member
      bestScore = score
    }
  }
  return best?.entry ?? null
}

/** The variant a family should open on: its default member, else the first. */
export function defaultCursorVariant(
  family: CursorModelFamily
): CursorVariant | null {
  const preferred =
    family.members.find((m) => m.entry.isDefault) ?? family.members[0]
  return preferred?.variant ?? null
}

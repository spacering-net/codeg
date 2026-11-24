/** A slot in the pagination strip: a page to jump to, or a gap. */
export type PageSlot = number | "ellipsis"

/** Widest strip a caller gets by default: first, gap, current±1, gap, last. */
export const DEFAULT_MAX_PAGE_SLOTS = 7
/** Narrowest strip that still means anything: first, gap, current, gap, last. */
const MIN_MAX_PAGE_SLOTS = 5

/**
 * The page numbers to render for `current` out of `totalPages`.
 *
 * Always includes the first and last page (the two jumps people actually
 * want), plus `current` and as many neighbours as `maxSlots` affords; anything
 * skipped becomes one gap marker. The width is therefore CONSTANT — so the
 * strip does not reflow as the user walks through a long list.
 *
 * `maxSlots` is what makes the strip fit a phone: the fixed part is
 * `first + gap + current + gap + last` = 5, and every further pair of slots
 * buys one neighbour on each side. Below 5 there is nothing left to drop, so
 * that is the floor.
 *
 * A gap is only emitted for a real skip: with exactly one page missing the
 * marker would be wider than the number it hides, so that number is shown
 * instead.
 */
export function pageSlots(
  current: number,
  totalPages: number,
  maxSlots: number = DEFAULT_MAX_PAGE_SLOTS
): PageSlot[] {
  if (totalPages <= 0) return []
  const page = Math.min(Math.max(current, 1), totalPages)
  const neighbours = Math.floor(
    (Math.max(maxSlots, MIN_MAX_PAGE_SLOTS) - MIN_MAX_PAGE_SLOTS) / 2
  )

  const wanted = new Set<number>([1, totalPages])
  for (let p = page - neighbours; p <= page + neighbours; p += 1) {
    if (p >= 1 && p <= totalPages) wanted.add(p)
  }
  const pages = [...wanted].sort((a, b) => a - b)

  const slots: PageSlot[] = []
  let previous = 0
  for (const p of pages) {
    const skipped = p - previous - 1
    if (skipped === 1) slots.push(p - 1)
    else if (skipped > 1) slots.push("ellipsis")
    slots.push(p)
    previous = p
  }
  return slots
}

/**
 * How many pages `total` items fill. `null` in (the forge declined to count)
 * stays `null` out — the caller must not invent a page count from a total it
 * was never given.
 */
export function pageCount(
  total: number | null,
  perPage: number
): number | null {
  if (total == null || perPage <= 0) return null
  return Math.max(1, Math.ceil(total / perPage))
}

/** Within this of the bottom, the message list follows what comes in. */
export const STICK_PX = 48

/**
 * Whether the message list still follows its bottom after a scroll event.
 * Near the bottom it does. Away from it, only a move up — the reader
 * scrolling back — stops it: content growing below the view, or the
 * browser's scroll anchoring nudging it as rows change size, moves it down
 * or not at all, and the list follows on (it scrolls down on the next size
 * change). Taking every scroll event that leaves a gap for the reader's
 * would stop following whenever a new message lands with such a nudge.
 */
export function followsBottom({
  was,
  gap,
  top,
  lastTop,
}: {
  /** Whether it followed before this event. */
  was: boolean
  /** The distance from the view's bottom to the content's. */
  gap: number
  top: number
  /** `scrollTop` at the event before. */
  lastTop: number
}): boolean {
  if (gap < STICK_PX) return true
  if (top < lastTop - 1) return false
  return was
}

/** How long after the reader's own input — a wheel, a touch, a key, the
 *  pointer pressed on the list or its bar — a scroll counts as theirs. */
export const USER_SCROLL_MS = 600

/**
 * What a scroll event means for following the bottom. Near the bottom, the
 * list follows. A scroll of the reader's (their input just before it)
 * follows `followsBottom`. Any other is the list's own — the virtual list
 * keeping what is drawn in place as it measures rows, a glide down: it does
 * not change whether the list follows, and one that took a following list
 * off its bottom is undone (`restick`), but for the glide, which gets there
 * itself.
 */
export function afterScroll({
  was,
  gap,
  top,
  lastTop,
  user,
  gliding,
}: {
  was: boolean
  gap: number
  top: number
  lastTop: number
  /** The reader's input came just before it. */
  user: boolean
  /** A glide to the bottom asked for is under way. */
  gliding: boolean
}): { following: boolean; restick: boolean } {
  if (gap < STICK_PX) return { following: true, restick: false }
  if (user) {
    return {
      following: followsBottom({ was, gap, top, lastTop }),
      restick: false,
    }
  }
  return { following: was, restick: was && !gliding }
}

/** Within this of the bottom no way back down shows: `use-stick-to-bottom`'s
 *  own slack, which a conversation's button goes by. */
export const NEAR_BOTTOM_PX = 70

/**
 * Whether the way back down shows (the round button over the list), as it
 * does over a conversation: the reader stopped following and is further
 * from the bottom than `NEAR_BOTTOM_PX`.
 */
export function farFromBottom({
  following,
  gap,
}: {
  /** Whether the list follows its bottom (`followsBottom`). */
  following: boolean
  /** The distance from the view's bottom to the content's. */
  gap: number
}): boolean {
  return !following && gap > NEAR_BOTTOM_PX
}

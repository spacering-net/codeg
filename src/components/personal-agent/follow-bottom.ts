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

/**
 * Whether the way back down shows (the round button over the list): the
 * reader stopped following and is more than half a view up from the bottom
 * — a glance up past the last message or two does not bring it.
 */
export function farFromBottom({
  following,
  gap,
  view,
}: {
  /** Whether the list follows its bottom (`followsBottom`). */
  following: boolean
  /** The distance from the view's bottom to the content's. */
  gap: number
  /** The view's height. */
  view: number
}): boolean {
  return !following && gap > view / 2
}

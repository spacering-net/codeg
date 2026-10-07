/**
 * The chat composer's two height floors.
 *
 * The box is a flex column — editable area on top, action row pinned under it —
 * and both floors are stated, because they are one number split in two. Stating
 * the editable half is what lets the box reach its floor by SUMMING its
 * children instead of by handing out free space: an engine that reads a
 * min-height-only flex column as main-size-indefinite gives its `flex-grow`
 * children none of it, and #746 is what that looked like — the editable area
 * gone entirely, the action row flush with the top of a 6rem box, and the rest
 * of it blank and untappable. A content flex basis (`grow`, see RichComposer)
 * already keeps the editor from collapsing; the floor below keeps the action
 * row on the box's bottom edge there too, instead of floating it above dead
 * space.
 */

/**
 * The action row's height. A 2rem control (the send/stop button — the tallest
 * thing in the row in every state, at every container width) plus its `pb-2`.
 */
const ACTION_ROW_REM = 2.5

/** The box's own 1px border, top and bottom, at the 16px root. */
const BOX_BORDERS_REM = 0.125

/**
 * Per-size floors. The utility strings are written out rather than built from
 * `boxRem` because Tailwind only emits classes it can find spelled out in the
 * source; `composer-sizing.test.ts` checks they still agree with the
 * arithmetic, so a change to one half cannot silently leave the other behind.
 */
export const COMPOSER_SIZING = {
  /** Active and historical conversations. */
  compact: {
    boxRem: 6,
    box: "min-h-24",
    editable: "min-h-[3.375rem]",
  },
  /** The welcome (new-conversation) input, which sits in a roomy empty state. */
  tall: {
    boxRem: 7.5,
    box: "min-h-30",
    editable: "min-h-[4.875rem]",
  },
} as const

/** Exported for the test that pins the two halves together. */
export const COMPOSER_SIZING_PARTS = { ACTION_ROW_REM, BOX_BORDERS_REM }

/** The box's floor. */
export function composerBoxMinHeight(tall: boolean): string {
  return (tall ? COMPOSER_SIZING.tall : COMPOSER_SIZING.compact).box
}

/**
 * The editable area's floor.
 *
 * `hasStripAbove` is the thumbnail strip for image attachments. It stands the
 * floor down, because the floor only has to be stated while the box is actually
 * resting on it: with a strip above the editor the box already clears its floor
 * on content alone, so no free space is in play, and the editable area keeps
 * the natural height it has always had there.
 */
export function composerEditableMinHeight(
  tall: boolean,
  hasStripAbove: boolean
): string {
  if (hasStripAbove) return "min-h-0"
  return (tall ? COMPOSER_SIZING.tall : COMPOSER_SIZING.compact).editable
}

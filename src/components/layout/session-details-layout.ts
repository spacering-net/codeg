/**
 * The Session Details panel's column: the summary and the sections under it
 * drawn straight on the panel, no card around any of them, a hairline between
 * each two — an accordion, whose folded sections stack as a row each. Its
 * sides are `SESSION_DETAILS_GUTTER`'s.
 */
export const SESSION_DETAILS_COLUMN =
  "min-w-0 divide-y divide-border/50 px-4 pb-2 text-sm"

/** The column's side padding, as a negative margin: what a sticky header
 *  spreads across so rows scrolling under it never show at its sides. */
export const SESSION_DETAILS_GUTTER = "-mx-4 px-4"

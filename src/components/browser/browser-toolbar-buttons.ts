// The two button shapes of a browser tab's toolbar row, shared by the three
// files that render controls into it (`browser-toolbar.tsx` and the two
// controls it mounts). Here rather than in the toolbar itself so the controls
// can import them without an import cycle.

/**
 * A control ON the row, beside the address field: back, forward, reload, the
 * profile chip, the overflow menu.
 *
 * Circular, like the tab strip's buttons directly above this row
 * (`STRIP_ICON_BTN` in `file-workspace-tab-bar.tsx`). The toolbar is the file
 * column's top row, so the two are stacked with nothing between them, and a
 * row of 4px-cornered squares under a row of circles reads as two unrelated
 * toolbars. The width override on the profile chip turns the same class into a
 * pill, which is the shape's other half.
 */
export const ICON_BTN =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/**
 * A control INSIDE the address field: the agent share control on its left, the
 * activity record and the hand-off to a conversation on its right.
 *
 * Two sizes down from the row's own buttons, because it has to sit within the
 * field's 28px without crowding its edge — the same trade every browser makes
 * for the things it puts in the address bar.
 */
export const FIELD_BTN =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/** `FIELD_BTN`'s pill half: a control inside the field that carries a word as
 *  well as a glyph. */
export const FIELD_PILL =
  "flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium transition-colors"

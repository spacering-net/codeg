/**
 * DOM order for a group's conversation views, decoupled from the strip order.
 *
 * Dragging a tab in the strip permutes the tab list, and the views used to be
 * rendered in that same order. React realises a keyed permutation by moving
 * the existing DOM nodes (`insertBefore`), and moving a node out and back into
 * the document resets every scroll offset inside it to 0 without firing a
 * scroll event. The transcript is virtualized (virtua): it keeps rendering the
 * rows for the offset it last saw, which is usually the bottom of a long
 * conversation, while the viewport now sits at the top over an empty spacer.
 * The moved tab, or any hidden tab React happened to move, shows up blank
 * until the user scrolls.
 *
 * So the views are emitted in an order that a strip reorder cannot change
 * (sorted by tab id, which is fixed for the life of a mounted view), and the
 * strip order only reaches the screen through the CSS `order` property, which
 * matters only in tiled mode (a flex row) and never touches the DOM tree.
 * Opening or closing a tab inserts or removes one node and leaves every other
 * node where it is.
 */
export interface OrderedTabView<T> {
  tab: T
  /** Position of the tab in the strip (its visual slot in a tiled row). */
  visualIndex: number
}

export function stableTabViewOrder<T extends { id: string }>(
  tabs: readonly T[]
): OrderedTabView<T>[] {
  return tabs
    .map((tab, visualIndex) => ({ tab, visualIndex }))
    .sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0))
}

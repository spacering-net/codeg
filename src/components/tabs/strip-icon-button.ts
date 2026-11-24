/**
 * The tab strips' own round icon buttons: the conversation strip's
 * new-conversation and maximize/restore buttons, and the file strip's "+" and
 * maximize/restore. One class string so the two strips read as one piece of
 * chrome: a circular ghost button evenly inset from the strip's edges, with the
 * adaptive `bg-foreground/10` hover tint and `backdrop-blur-sm` so the fill
 * reads as frosted glass over a workspace background image rather than a muddy
 * patch.
 *
 * `self-start` — NOT `self-center` — is what centers these. The trailing box
 * they sit in is shortened by the strip's `pt-1.5`, so `self-center` centers an
 * `h-7` button in 34px and lands it 3px BELOW the strip midline (the tab
 * labels' line); seating it against the top instead yields an equal 6px above
 * and below, putting its centre back on that midline.
 */
export const STRIP_ICON_BTN =
  "flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full text-muted-foreground backdrop-blur-sm transition-colors hover:bg-foreground/10 hover:text-foreground"

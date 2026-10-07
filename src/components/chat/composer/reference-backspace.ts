import type { Command } from "@tiptap/pm/state"

/** Node name of the inline badge. Kept local: `reference-node.ts` imports this
 *  module for its keymap, so the constant cannot travel the other way. */
const REFERENCE = "reference"

/** The separator every badge insertion leaves behind (see
 *  `use-composer-attachments.insertFileReferences` and the `@` panel's
 *  `handleReferenceSelect`): one plain space, so the next thing typed does not
 *  glue onto the badge. */
const GAP = " "

/**
 * Backspace directly after a badge's trailing space deletes the badge, not the
 * space.
 *
 * Every badge lands as `[badge][" "]` with the caret after the space, so the
 * person's first Backspace used to consume that space — a keystroke with
 * nothing to show for it, since the space is invisible. The badge only started
 * responding once the caret had been walked back onto it (where ProseMirror
 * deletes the inline atom itself), which reads as "Backspace cannot delete
 * this". Reported for the built-in browser's "pick an element", where the badge
 * arrives without anyone typing and removing it again is the whole undo.
 *
 * The rule is the one the person can see — a badge, one space, the caret — not
 * the document's node boundaries, which differ for the same picture: inserting
 * into the middle of a draft merges the gap into the text that follows it.
 * Everywhere else Backspace keeps its ordinary meaning, including a run of
 * spaces the person typed themselves (the space before the caret must be the
 * one touching the badge) and a caret already against the badge (ProseMirror
 * deletes the atom there on its own).
 *
 * Badge and gap go together in one press: leaving the space behind would be a
 * second invisible keystroke, and it would glue whatever follows onto the word
 * before it.
 */
export const deleteReferenceThroughGap: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false
  const $caret = selection.$head
  // An atom (1) plus its space (1) is the least that can sit before the caret.
  // A cheap bound, not the safety: at the top of a block `pos - 1` lands on the
  // boundary, where `nodeBefore` is the paragraph (or nothing) and the check
  // below refuses anyway — so Backspace there still means "join with the
  // paragraph above" and cannot reach a badge that ended it.
  if ($caret.parentOffset < 2) return false
  const $gap = state.doc.resolve($caret.pos - 1)
  // Whatever precedes that last character has to be the badge itself. In a run
  // of spaces this resolves inside the text node instead, and reports the text.
  const badge = $gap.nodeBefore
  if (!badge || badge.type.name !== REFERENCE) return false
  if (state.doc.textBetween($gap.pos, $caret.pos) !== GAP) return false
  if (dispatch) dispatch(state.tr.delete($gap.pos - badge.nodeSize, $caret.pos))
  return true
}

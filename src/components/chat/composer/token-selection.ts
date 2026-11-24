import type { Editor } from "@tiptap/core"

import { textTokenAt, type TextToken } from "@/lib/text-token-at"

/** A token found in the document, with the range that selects it. */
export interface ComposerTokenSelection {
  token: TextToken
  /** Document position of the token's first character. */
  from: number
  /** Document position one past the token's last character. */
  to: number
}

/**
 * The token under a document position, or null when the position is not inside
 * text (an empty paragraph, a reference badge) or lands in whitespace.
 *
 * Only the text node under the position is inspected, so a token never runs
 * across a badge into unrelated prose.
 */
export function composerTokenAt(
  editor: Editor,
  pos: number
): ComposerTokenSelection | null {
  const { doc } = editor.state
  if (pos < 0 || pos > doc.content.size) return null

  const resolved = doc.resolve(pos)
  const parent = resolved.parent
  if (!parent.isTextblock) return null

  const offset = resolved.parentOffset
  // `childAfter` is the node the position opens; at a node boundary (the end of
  // the block, or right after a word) `childBefore` is the one it closes.
  let hit = parent.childAfter(offset)
  if (!hit.node?.isText) hit = parent.childBefore(offset)
  const text = hit.node?.isText ? (hit.node.text ?? "") : ""
  if (!text) return null

  const token = textTokenAt(text, offset - hit.offset)
  if (!token) return null

  const base = resolved.start() + hit.offset
  return { token, from: base + token.start, to: base + token.end }
}

/** The whole selection read as one token, or null when it is not one. */
function selectedToken(editor: Editor): TextToken | null {
  const { from, to } = editor.state.selection
  // Both separators are a newline so anything that is not plain text — a
  // reference badge, a hard break, a paragraph boundary — reads as whitespace.
  // A token can never contain whitespace, so a selection spanning one of those
  // reports no token instead of gluing the two halves into an address or a url
  // that is nowhere in the document (`https://example.com` ⏎ `/private`).
  const text = editor.state.doc.textBetween(from, to, "\n", "\n")
  const token = textTokenAt(text, 0)
  if (!token || token.start !== 0 || token.end !== text.length) return null
  return token
}

/**
 * Point the composer at what the user right-clicked, and report the token the
 * menu can act on.
 *
 * With nothing selected, the token under the pointer is selected first, so
 * Cut/Copy (and the token's own actions) apply to it without the user
 * highlighting it by hand. A right click INSIDE a live selection keeps that
 * selection untouched, the way every native text field behaves; one outside it
 * moves to the new token, again like a native field.
 *
 * The pointer position comes from the coordinates, falling back to the caret —
 * browsers place it at the click point before dispatching `contextmenu`, so the
 * fallback lands in the same place when hit-testing declines to answer.
 */
export function selectTokenForContextMenu(
  editor: Editor,
  clientX: number,
  clientY: number
): TextToken | null {
  const { selection } = editor.state
  let pos: number | null = null
  try {
    pos = editor.view.posAtCoords({ left: clientX, top: clientY })?.pos ?? null
  } catch {
    pos = null
  }
  const at = pos ?? selection.head

  if (!selection.empty && at >= selection.from && at <= selection.to) {
    return selectedToken(editor)
  }

  const hit = composerTokenAt(editor, at)
  if (!hit) return null
  editor.chain().focus().setTextSelection({ from: hit.from, to: hit.to }).run()
  return hit.token
}

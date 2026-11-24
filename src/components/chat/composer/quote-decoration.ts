import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { quoteMarkerLength } from "@/lib/message-quote"

/** CSS class painted over one `> ` marker (see globals.css). */
export const QUOTE_MARKER_CLASS = "codeg-quote-marker"

/** Plugin state is the decoration set for the current document. */
export const quoteLineDecorationKey = new PluginKey<DecorationSet>(
  "quoteLineDecoration"
)

/**
 * Stand-in for an inline atom (a reference badge) while scanning a line.
 *
 * The scan has to stay aligned with ProseMirror POSITIONS, not with serialized
 * text: a badge occupies exactly one position but `referenceToMarkdown` expands
 * it to a whole `[label](uri)` token, so scanning `textBetween` output would
 * shift every marker on a line that contains a badge. One placeholder character
 * per position keeps the accumulator index and the PM offset identical.
 */
const ATOM_PLACEHOLDER = "￼"

/**
 * Decorate every line-leading blockquote marker in the document.
 *
 * Pure, so it can be asserted against a real editor state in tests.
 *
 * "Line" means a visual line: the composer is a plain-text editor whose content
 * is normally ONE paragraph with `hardBreak` nodes between lines
 * ({@link "./plain-text-content".textToInlineContent}), though a native
 * ProseMirror paste can also produce several paragraphs — both are handled by
 * scanning each textblock and breaking on `hardBreak`.
 *
 * Each nesting level gets its own decoration, so `> > x` draws two rules at
 * their own indents.
 */
export function quoteLineDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // `forEach` offsets are relative to the block's content, which starts one
    // position after the block node itself.
    const base = pos + 1
    let lineStart = 0
    let lineText = ""

    const markLine = () => {
      let offset = 0
      let width = quoteMarkerLength(lineText)
      while (width > 0) {
        const from = base + lineStart + offset
        decorations.push(
          Decoration.inline(from, from + width, { class: QUOTE_MARKER_CLASS })
        )
        offset += width
        width = quoteMarkerLength(lineText.slice(offset))
      }
    }

    node.forEach((child, offset) => {
      if (child.type.name === "hardBreak") {
        markLine()
        lineStart = offset + child.nodeSize
        lineText = ""
        return
      }
      lineText += child.isText
        ? (child.text ?? "")
        : ATOM_PLACEHOLDER.repeat(child.nodeSize)
    })
    markLine()
    return false
  })

  return DecorationSet.create(doc, decorations)
}

/**
 * Paint literal `> ` markers in the composer as a blockquote rule.
 *
 * The quote action ({@link "@/lib/message-quote".buildQuotedMarkdown}) inserts
 * real `> ` characters because this composer is plain text and the agent has to
 * receive Markdown. Shown raw that's a wall of `>`; shown as a rule it reads
 * like the transcript does.
 *
 * This is a DECORATION, never a schema change. Adding a blockquote node would
 * change what `serializeDocToText` walks, what the clipboard round-trips, and —
 * worst — what `setContent` does to drafts saved by an older build (an unknown
 * node type silently wipes the whole document; see `composer-draft-sanitize.ts`).
 * Decorations touch none of that: the two characters stay in the document, still
 * occupy their width, and still delete with two backspaces. The CSS only makes
 * their glyphs transparent and draws the rule in their place — so what the user
 * sends, copies and re-opens is byte-for-byte what it was before.
 *
 * Recomputed only when the document actually changes; otherwise the previous
 * set (which is bound to the same doc) is reused.
 */
export const QuoteLineDecoration = Extension.create({
  name: "quoteLineDecoration",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: quoteLineDecorationKey,
        state: {
          init: (_config, state) => quoteLineDecorations(state.doc),
          apply: (tr, value) =>
            tr.docChanged ? quoteLineDecorations(tr.doc) : value,
        },
        props: {
          decorations(state) {
            return quoteLineDecorationKey.getState(state)
          },
        },
      }),
    ]
  },
})

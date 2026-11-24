import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildComposerExtensions } from "./editor-config"
import { textToSeededInlineContent } from "./plain-text-content"
import { QUOTE_MARKER_CLASS, quoteLineDecorations } from "./quote-decoration"
import { serializeDocToText } from "./to-prompt-blocks"
import type { ReferenceAttrs } from "./types"

function ref(
  partial: Partial<ReferenceAttrs> & { refType: ReferenceAttrs["refType"] }
): ReferenceAttrs {
  return { id: "", label: "", uri: null, meta: null, ...partial }
}

/**
 * The `> ` markers the quote action inserts are literal text (the composer has
 * no blockquote node), so they're painted with decorations instead. These assert
 * the decorated RANGES, which is what the CSS hangs off — and, on every case,
 * that send serialization is untouched.
 */
describe("quoteLineDecorations", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({ extensions: buildComposerExtensions() })
  })

  afterEach(() => {
    editor?.destroy()
  })

  /** Decorated ranges plus the exact text each one covers. */
  function marked() {
    const doc = editor.state.doc
    return quoteLineDecorations(doc)
      .find()
      .map((decoration) => ({
        from: decoration.from,
        to: decoration.to,
        text: doc.textBetween(decoration.from, decoration.to),
        class: (
          decoration as unknown as { type: { attrs?: { class?: string } } }
        ).type.attrs?.class,
      }))
  }

  const seed = (text: string) =>
    editor.commands.insertContent(textToSeededInlineContent(text))

  it("marks the leading `> ` of a single quoted line", () => {
    seed("> quoted")
    // Position 1 is the start of the paragraph's content.
    expect(marked()).toEqual([
      { from: 1, to: 3, text: "> ", class: QUOTE_MARKER_CLASS },
    ])
  })

  it("marks every line of a hard-break separated quote", () => {
    seed("> first\n> second")
    // "> first" is 7 chars from position 1, then the hardBreak occupies one.
    expect(marked().map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [9, 11],
    ])
  })

  it("marks a bare `>` blank line inside the quote", () => {
    seed("> a\n>\n> b")
    expect(marked().map((m) => [m.from, m.to, m.text])).toEqual([
      [1, 3, "> "],
      [5, 6, ">"],
      [7, 9, "> "],
    ])
  })

  it("marks each nesting level of `> > x` separately", () => {
    seed("> > x")
    // Two rules, each at its own indent.
    expect(marked().map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [3, 5],
    ])
  })

  it("stays aligned when the line contains a reference badge", () => {
    editor.commands.insertContent([
      { type: "text", text: "> see " },
      { type: "reference", attrs: ref({ refType: "file", label: "a.ts" }) },
      { type: "hardBreak" },
      { type: "text", text: "> and here" },
    ])
    expect(marked().map((m) => [m.from, m.to, m.text])).toEqual([
      [1, 3, "> "],
      // "> see " is 6 positions, the badge 1, the hardBreak 1 → line 2 at 9.
      [9, 11, "> "],
    ])
  })

  it("does not decorate a line that STARTS with a badge", () => {
    // The regression this guards: a badge is ONE position but contributes no
    // text. Scanning text alone would read this line as "> after" and paint a
    // rule over the badge itself. The scan counts positions, so the line reads
    // as starting with an atom and is not a quote at all.
    editor.commands.insertContent([
      { type: "reference", attrs: ref({ refType: "file", label: "a.ts" }) },
      { type: "text", text: "> after" },
    ])
    expect(marked()).toEqual([])
  })

  it("marks the start of every paragraph, not just the first", () => {
    // A native ProseMirror paste can produce several paragraphs even though the
    // composer normally holds one.
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "> one" }] },
        { type: "paragraph", content: [{ type: "text", text: "> two" }] },
      ],
    })
    expect(marked().map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [8, 10],
    ])
  })

  it("ignores a `>` that is not line-leading, and unquoted prose", () => {
    seed("a > b\nplain text")
    expect(marked()).toEqual([])
  })

  it("leaves send serialization byte-for-byte unchanged", () => {
    const source = "> quoted line\n>\n> more\n\nmy question"
    seed(source)
    // The decoration is display only: the markers are still in the document, so
    // the agent receives exactly the Markdown the quote action built.
    expect(serializeDocToText(editor.state.doc)).toBe(source)
    expect(marked().length).toBe(3)
  })
})

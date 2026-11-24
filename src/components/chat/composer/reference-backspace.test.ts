import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildComposerExtensions } from "./editor-config"
import { deleteReferenceThroughGap } from "./reference-backspace"
import type { ReferenceAttrs } from "./types"

const badge: ReferenceAttrs = {
  refType: "file",
  id: "codeg://embedded/1",
  label: "button#export",
  uri: "codeg://embedded/1",
  meta: { fileKind: "file" },
}

describe("deleteReferenceThroughGap", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({ extensions: buildComposerExtensions() })
  })

  afterEach(() => {
    editor?.destroy()
  })

  /** Insert a badge exactly the way every insertion path does: the atom, then
   *  the separating space, caret left after it. */
  function insertBadge(): void {
    editor.chain().focus().insertReference(badge).insertContent(" ").run()
  }

  /** Put an empty caret at `pos`. */
  function caretAt(pos: number): void {
    const { tr, doc } = editor.state
    editor.view.dispatch(tr.setSelection(TextSelection.create(doc, pos)))
  }

  /** How many badges the document still holds. */
  function badgeCount(): number {
    let seen = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === "reference") seen++
    })
    return seen
  }

  function run(): boolean {
    return deleteReferenceThroughGap(editor.state, editor.view.dispatch)
  }

  it("deletes the badge and its gap where an insertion leaves the caret", () => {
    insertBadge()
    // The state the reported bug starts from: badge, space, caret after both.
    expect(editor.state.doc.textContent).toBe(" ")

    expect(run()).toBe(true)
    expect(editor.state.doc.textContent).toBe("")
    expect(editor.getJSON().content?.[0]?.content).toBeUndefined()
  })

  it("keeps what follows the gap", () => {
    // A badge inserted mid-draft: ProseMirror merges the gap into the text
    // after it, so the same picture has a different shape in the document.
    insertBadge()
    const caret = editor.state.selection.from
    editor.chain().insertContent("ask about this").run()
    caretAt(caret)

    expect(run()).toBe(true)
    expect(editor.state.doc.textContent).toBe("ask about this")
  })

  it("keeps prose before the badge", () => {
    editor.chain().focus().insertContent("look at ").run()
    insertBadge()

    expect(run()).toBe(true)
    expect(editor.state.doc.textContent).toBe("look at ")
  })

  it("leaves a second badge alone", () => {
    insertBadge()
    insertBadge()

    expect(run()).toBe(true)
    // One badge and its space survive; the caret now sits after them.
    expect(editor.state.doc.textContent).toBe(" ")
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2)
  })

  it("does not fire on ordinary prose", () => {
    editor.chain().focus().insertContent("hello ").run()
    expect(run()).toBe(false)
    expect(editor.state.doc.textContent).toBe("hello ")
  })

  it("does not fire when the person typed their own spaces", () => {
    insertBadge()
    editor.chain().insertContent(" ").run()
    // Two spaces: Backspace means "delete one space", as it does anywhere else.
    expect(run()).toBe(false)
    expect(editor.state.doc.textContent).toBe("  ")
  })

  it("still fires from the badge's own space in a longer run", () => {
    insertBadge()
    editor.chain().insertContent(" ").run()
    // Back onto the space the insertion left: the picture is badge, caret —
    // whatever the person typed after it stays.
    caretAt(editor.state.selection.from - 1)

    expect(run()).toBe(true)
    expect(editor.state.doc.textContent).toBe(" ")
  })

  it("does not fire with the caret already against the badge", () => {
    insertBadge()
    caretAt(editor.state.selection.from - 1)
    // ProseMirror deletes an inline atom the caret sits behind on its own.
    expect(run()).toBe(false)
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2)
  })

  it("never reaches back into the paragraph above", () => {
    // A native paste can leave several paragraphs in this composer. Backspace
    // at the top of one means "join with the previous paragraph" — it must
    // never reach across and take a badge that ended that paragraph. Both
    // carets sit where `pos - 1` would walk out of the block.
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "reference", attrs: badge }] },
        { type: "paragraph", content: [{ type: "text", text: " abc" }] },
      ],
    })
    const contentStart = editor.state.doc.content.size - 5

    caretAt(contentStart) // very start of the second paragraph
    expect(run()).toBe(false)
    caretAt(contentStart + 1) // just past its leading space
    expect(run()).toBe(false)

    expect(editor.state.doc.childCount).toBe(2)
    expect(badgeCount()).toBe(1)
  })

  it("does not fire on a selection", () => {
    insertBadge()
    editor.commands.selectAll()
    expect(run()).toBe(false)
  })

  it("changes nothing when asked without a dispatch", () => {
    insertBadge()
    const before = editor.getJSON()
    expect(deleteReferenceThroughGap(editor.state, undefined)).toBe(true)
    expect(editor.getJSON()).toEqual(before)
  })
})

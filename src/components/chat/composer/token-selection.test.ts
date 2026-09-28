import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildComposerExtensions } from "./editor-config"
import { textToSeededDoc } from "./plain-text-content"
import { composerTokenAt, selectTokenForContextMenu } from "./token-selection"

/**
 * The composer's right-click token selection, driven through a real Tiptap
 * editor: jsdom has no layout, so `posAtCoords` is stubbed where a test needs a
 * specific hit and left alone (it answers null) where the caret fallback is the
 * thing under test.
 */

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

function makeEditor(text: string): Editor {
  const created = new Editor({ extensions: buildComposerExtensions() })
  created.commands.setContent(textToSeededDoc(text))
  editor = created
  return created
}

/** Document position of `index` in the first paragraph's text. */
function pos(index: number): number {
  return index + 1
}

function hitAt(target: number) {
  return { pos: target, inside: -1 }
}

function selectedText(target: Editor): string {
  const { from, to } = target.state.selection
  return target.state.doc.textBetween(from, to)
}

describe("composerTokenAt", () => {
  it("maps a token back to its document range", () => {
    const target = makeEditor("mail adam@example.com now")
    const hit = composerTokenAt(target, pos(8))
    expect(hit?.token.kind).toBe("email")
    expect(hit?.from).toBe(pos(5))
    expect(hit?.to).toBe(pos(21))
  })

  it("finds nothing in whitespace", () => {
    const target = makeEditor("alpha  beta")
    expect(composerTokenAt(target, pos(6))).toBeNull()
  })

  it("finds nothing in an empty document", () => {
    const target = makeEditor("")
    expect(composerTokenAt(target, pos(0))).toBeNull()
  })

  it("stays inside one text node instead of crossing a line break", () => {
    const target = makeEditor("alpha\nbeta")
    // The hard break sits between the two text nodes; a position on either side
    // of it resolves to that side's word only.
    expect(composerTokenAt(target, pos(5))?.token.value).toBe("alpha")
    expect(composerTokenAt(target, pos(6))?.token.value).toBe("beta")
  })
})

describe("selectTokenForContextMenu", () => {
  it("selects the token under the pointer with nothing selected", () => {
    const target = makeEditor("ping adam@example.com today")
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(9)))

    const token = selectTokenForContextMenu(target, 40, 12)

    expect(token?.kind).toBe("email")
    expect(token?.href).toBe("mailto:adam@example.com")
    expect(selectedText(target)).toBe("adam@example.com")
  })

  it("falls back to the caret when hit-testing declines", () => {
    const target = makeEditor("see https://example.com/docs later")
    target.commands.setTextSelection(pos(12))
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(null)

    const token = selectTokenForContextMenu(target, 0, 0)

    expect(token?.kind).toBe("url")
    expect(selectedText(target)).toBe("https://example.com/docs")
  })

  it("keeps a live selection when the click lands inside it", () => {
    const target = makeEditor("keep this whole phrase intact")
    target.commands.setTextSelection({ from: pos(5), to: pos(22) })
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(12)))

    expect(selectTokenForContextMenu(target, 30, 12)).toBeNull()
    expect(selectedText(target)).toBe("this whole phrase")
  })

  it("reports a hand-made selection that is itself one token", () => {
    const target = makeEditor("ping adam@example.com today")
    target.commands.setTextSelection({ from: pos(5), to: pos(21) })
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(9)))

    const token = selectTokenForContextMenu(target, 40, 12)

    expect(token?.kind).toBe("email")
    expect(selectedText(target)).toBe("adam@example.com")
  })

  it("reports no token for a hand-made selection that crosses a line break", () => {
    // The two halves are one token only once the break between them is dropped;
    // `https://example.com/private` is nowhere in the document, so the menu must
    // not offer to open it.
    const target = makeEditor("https://example.com\n/private")
    target.commands.setTextSelection({ from: pos(0), to: pos(28) })
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(10)))

    expect(selectTokenForContextMenu(target, 40, 12)).toBeNull()
    // …and the selection the user made is still theirs.
    expect(target.state.selection.from).toBe(pos(0))
  })

  it("moves to the new token when the click lands outside the selection", () => {
    const target = makeEditor("alpha beta gamma")
    target.commands.setTextSelection({ from: pos(0), to: pos(5) })
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(13)))

    expect(selectTokenForContextMenu(target, 90, 12)?.value).toBe("gamma")
    expect(selectedText(target)).toBe("gamma")
  })

  it("leaves the caret alone when the pointer is over whitespace", () => {
    const target = makeEditor("alpha  beta")
    target.commands.setTextSelection(pos(2))
    vi.spyOn(target.view, "posAtCoords").mockReturnValue(hitAt(pos(6)))

    expect(selectTokenForContextMenu(target, 45, 12)).toBeNull()
    expect(target.state.selection.empty).toBe(true)
    expect(target.state.selection.from).toBe(pos(2))
  })
})

import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildQuotedMarkdown } from "@/lib/message-quote"

import { buildComposerExtensions } from "./editor-config"
import { textToSeededInlineContent } from "./plain-text-content"
import { docToPromptBlocks, serializeDocToText } from "./to-prompt-blocks"

/**
 * End-to-end check for "quote a message selection": the blockquote the bubble
 * builds has to survive the composer's plain-text schema and come back out of
 * send serialization byte-for-byte, so the agent receives real Markdown.
 *
 * `insert` mirrors `RichComposerHandle.insertTextAtCursor` (the path
 * MessageInput's append-mode inject takes) — `\n` becomes a hardBreak node, and
 * `serializeDocToText` turns it back into `\n`.
 */
describe("quoting a selection into the composer", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({ extensions: buildComposerExtensions() })
  })

  afterEach(() => {
    editor?.destroy()
  })

  const insert = (text: string) =>
    editor.chain().focus().insertContent(textToSeededInlineContent(text)).run()

  const sentText = () => {
    const blocks = docToPromptBlocks(editor)
    return blocks.length === 0 ? "" : (blocks[0] as { text: string }).text
  }

  it("round-trips a multi-line quote through the plain-text schema", () => {
    const quoted = buildQuotedMarkdown("first line\nsecond line")
    insert(`${quoted}\n\n`)
    expect(sentText()).toBe("> first line\n> second line")
  })

  it("keeps the blank-line marker that holds one blockquote together", () => {
    const quoted = buildQuotedMarkdown("para one\n\npara two")
    insert(`${quoted}\n\n`)
    expect(sentText()).toBe("> para one\n>\n> para two")
  })

  it("appends after an existing draft with a blank line between", () => {
    insert("what does this mean?")
    const existing = serializeDocToText(editor.state.doc)
    // Same gap rule MessageInput applies for `mode: "append"`.
    const gap = existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n"
    insert(`${gap}${buildQuotedMarkdown("quoted bit")}\n\n`)
    expect(sentText()).toBe("what does this mean?\n\n> quoted bit")
  })

  it("leaves Markdown inside the quote literal", () => {
    insert(`${buildQuotedMarkdown("# Heading\n- item *emphasis*")}\n\n`)
    expect(sentText()).toBe("> # Heading\n> - item *emphasis*")
  })
})

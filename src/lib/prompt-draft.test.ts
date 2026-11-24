import { describe, expect, it } from "vitest"

import type { PromptDraft, PromptInputBlock } from "@/lib/types"

import {
  buildSteerPayload,
  draftRidesBlocks,
  extractUserImagesFromDraft,
  extractUserResourcesFromDraft,
  promptDraftTitleSeed,
} from "./prompt-draft"

function draft(blocks: PromptInputBlock[]): PromptDraft {
  return { blocks, displayText: "" }
}

const grokImageResource: PromptInputBlock = {
  type: "resource",
  uri: "clipboard://image.png-abc",
  mime_type: "image/png",
  text: null,
  blob: "QUJD",
}

const textResource: PromptInputBlock = {
  type: "resource",
  uri: "clipboard://notes.txt",
  mime_type: "text/plain",
  text: "hi",
  blob: null,
}

describe("buildSteerPayload", () => {
  const text = (s: string): PromptInputBlock => ({ type: "text", text: s })

  it("joins plain-text blocks and rides no block list", () => {
    const d: PromptDraft = {
      blocks: [text(" go "), text("left")],
      displayText: "ignored",
    }
    expect(buildSteerPayload(d)).toEqual({ text: "go \nleft" })
  })

  it("returns null when there is no text at all", () => {
    expect(buildSteerPayload({ blocks: [], displayText: "" })).toBeNull()
    expect(
      buildSteerPayload({ blocks: [text("   ")], displayText: "" })
    ).toBeNull()
  })

  it("rides the full block list and display text once a non-text block is present", () => {
    const blocks = [text("look"), grokImageResource]
    const d: PromptDraft = { blocks, displayText: "look [附件 1]" }
    expect(buildSteerPayload(d)).toEqual({
      text: "look [附件 1]",
      blocks,
    })
  })

  it("attaches only a text resource too (it is not a text block)", () => {
    const blocks = [text("note"), textResource]
    const d: PromptDraft = { blocks, displayText: "note chip" }
    expect(buildSteerPayload(d)?.blocks).toBe(blocks)
  })

  // The affordance gate (a pull-channel session can't carry blocks) reads the
  // same predicate the encoder does, so the two can't disagree about which
  // drafts need the native wire.
  it("agrees with draftRidesBlocks about what needs the block wire", () => {
    const plain: PromptDraft = { blocks: [text("go")], displayText: "go" }
    const attached: PromptDraft = {
      blocks: [text("look"), grokImageResource],
      displayText: "look",
    }
    expect(draftRidesBlocks(plain)).toBe(false)
    expect(buildSteerPayload(plain)?.blocks).toBeUndefined()
    expect(draftRidesBlocks(attached)).toBe(true)
    expect(buildSteerPayload(attached)?.blocks).toBe(attached.blocks)
  })
})

describe("extractUserImagesFromDraft", () => {
  it("includes native image blocks", () => {
    const images = extractUserImagesFromDraft(
      draft([
        { type: "image", data: "QUJD", mime_type: "image/png", uri: null },
      ])
    )
    expect(images).toEqual([
      { name: "image.png", data: "QUJD", mime_type: "image/png", uri: null },
    ])
  })

  it("promotes an image-mime embedded resource to a thumbnail (Grok's encoding)", () => {
    const images = extractUserImagesFromDraft(draft([grokImageResource]))
    expect(images).toHaveLength(1)
    // Bytes come from `blob`, and the origin uri is preserved.
    expect(images[0]).toMatchObject({
      data: "QUJD",
      mime_type: "image/png",
      uri: "clipboard://image.png-abc",
    })
  })

  it("ignores a non-image embedded resource", () => {
    expect(extractUserImagesFromDraft(draft([textResource]))).toEqual([])
  })
})

describe("extractUserResourcesFromDraft", () => {
  it("excludes an image-mime embedded resource (it renders as a thumbnail)", () => {
    expect(extractUserResourcesFromDraft(draft([grokImageResource]))).toEqual(
      []
    )
  })

  it("keeps a non-image embedded resource as a chip", () => {
    expect(extractUserResourcesFromDraft(draft([textResource]))).toEqual([
      {
        name: "notes.txt",
        uri: "clipboard://notes.txt",
        mime_type: "text/plain",
      },
    ])
  })
})

describe("promptDraftTitleSeed", () => {
  // A page handed over with nothing typed: the badge's link alone runs past
  // the cut, and a link cut in half no longer reads as a badge's name.
  it("names a new conversation after the badge, not half its link", () => {
    const displayText =
      "[Marked-up screenshot](codeg://embedded/https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dcodeg#2f5c8f1a-1b2c-4d5e-8f90-a1b2c3d4e5f6)"
    expect(promptDraftTitleSeed({ blocks: [], displayText }, "Attached")).toBe(
      "Marked-up screenshot"
    )
  })

  it("keeps what was typed around a badge and cuts only the result", () => {
    const displayText = `[app.ts](file:///repo/src/app.ts) ${"x".repeat(100)}`
    const title = promptDraftTitleSeed({ blocks: [], displayText }, "Attached")
    expect(title.startsWith("app.ts xxx")).toBe(true)
    expect(title).toHaveLength(80)
  })

  it("falls back when nothing was typed or attached inline", () => {
    expect(
      promptDraftTitleSeed({ blocks: [], displayText: "  " }, "Attached")
    ).toBe("Attached")
    // …or when all there was folds away to nothing.
    expect(
      promptDraftTitleSeed(
        { blocks: [], displayText: "[ ](https://x.test)" },
        "Attached"
      )
    ).toBe("Attached")
  })
})

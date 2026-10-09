import { describe, expect, it } from "vitest"

import {
  imageAttachmentToPromptBlock,
  type ImageInputAttachment,
} from "./message-input-attachments"

function image(
  overrides: Partial<ImageInputAttachment> = {}
): ImageInputAttachment {
  return {
    id: "image:1:0:uuid",
    type: "image",
    data: "QkFTRTY0",
    uri: null,
    name: "screenshot.png",
    mimeType: "image/png",
    ...overrides,
  }
}

describe("imageAttachmentToPromptBlock", () => {
  it("emits a native image block when the agent accepts image content", () => {
    const block = imageAttachmentToPromptBlock(
      image({ uri: "file:///a/shot.png" }),
      { image: true, embedded_context: false }
    )
    expect(block).toEqual({
      type: "image",
      data: "QkFTRTY0",
      mime_type: "image/png",
      uri: "file:///a/shot.png",
    })
  })

  it("preserves a null uri on the image block for a path-less paste", () => {
    const block = imageAttachmentToPromptBlock(image(), {
      image: true,
      embedded_context: true,
    })
    expect(block).toMatchObject({ type: "image", uri: null })
  })

  it("still emits a native image block for Grok when initialize lies (image:false)", () => {
    const block = imageAttachmentToPromptBlock(
      image(),
      { image: false, embedded_context: true },
      "grok"
    )
    expect(block).toMatchObject({
      type: "image",
      mime_type: "image/png",
      data: "QkFTRTY0",
    })
  })

  it("emits an embedded resource blob when a non-Grok agent only accepts embedded context", () => {
    const block = imageAttachmentToPromptBlock(image(), {
      image: false,
      embedded_context: true,
    })
    expect(block).toMatchObject({
      type: "resource",
      mime_type: "image/png",
      text: null,
      blob: "QkFTRTY0",
    })
    // A path-less paste gets a stable, non-empty synthetic identifier.
    expect(block.type === "resource" && block.uri).toBeTruthy()
    expect(
      block.type === "resource" && block.uri.startsWith("clipboard://")
    ).toBe(true)
  })

  it("reuses a real file:// origin as the embedded resource uri", () => {
    const block = imageAttachmentToPromptBlock(
      image({ uri: "file:///a/shot.png" }),
      { image: false, embedded_context: true }
    )
    expect(block).toMatchObject({
      type: "resource",
      uri: "file:///a/shot.png",
      blob: "QkFTRTY0",
    })
  })

  it("derives the synthetic uri deterministically from the same attachment", () => {
    const att = image()
    const a = imageAttachmentToPromptBlock(att, {
      image: false,
      embedded_context: true,
    })
    const b = imageAttachmentToPromptBlock(att, {
      image: false,
      embedded_context: true,
    })
    expect(a.type === "resource" && a.uri).toEqual(
      b.type === "resource" && b.uri
    )
  })
})

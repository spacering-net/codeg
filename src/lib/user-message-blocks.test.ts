import { describe, expect, it } from "vitest"

import { contentBlocksFromUserMessage } from "./user-message-blocks"

describe("contentBlocksFromUserMessage", () => {
  it("passes text through unchanged", () => {
    expect(
      contentBlocksFromUserMessage([{ type: "text", text: "ship it" }])
    ).toEqual([{ type: "text", text: "ship it" }])
  })

  it("widens an image to a content block with an explicit null uri", () => {
    // A broadcast image is carried by its bytes — there is no path to name, and
    // the display-name derivation downstream keys off that absence.
    expect(
      contentBlocksFromUserMessage([
        { type: "image", data: "aGk=", mime_type: "image/png" },
      ])
    ).toEqual([
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ])
  })

  it("preserves order across a mixed message", () => {
    // Order is the message: an image sent after a sentence must not float above
    // it, since the same list renders as one user turn.
    expect(
      contentBlocksFromUserMessage([
        { type: "text", text: "this colour" },
        { type: "image", data: "aGk=", mime_type: "image/png" },
        { type: "text", text: "please" },
      ])
    ).toEqual([
      { type: "text", text: "this colour" },
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
      { type: "text", text: "please" },
    ])
  })

  it("maps an empty list to an empty list", () => {
    expect(contentBlocksFromUserMessage([])).toEqual([])
  })
})

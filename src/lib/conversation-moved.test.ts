import { describe, expect, it } from "vitest"

import {
  ConversationMovedError,
  asConversationMovedError,
} from "./conversation-moved"

describe("asConversationMovedError", () => {
  it("reads the Tauri rejection (the bare Display string) and its folder", () => {
    const err = asConversationMovedError(
      "conversation moved to another folder (folder 12)"
    )
    expect(err).toBeInstanceOf(ConversationMovedError)
    expect(err?.folderId).toBe(12)
  })

  it("reads the web rejection (an AppCommandError body)", () => {
    const err = asConversationMovedError({
      code: "invalid_input",
      message: "conversation moved to another folder (folder 3)",
    })
    expect(err?.folderId).toBe(3)
  })

  it("keeps the marker even if the folder is not named", () => {
    expect(
      asConversationMovedError("conversation moved to another folder")?.folderId
    ).toBeNull()
  })

  it("passes an already-typed error through", () => {
    const typed = new ConversationMovedError(5)
    expect(asConversationMovedError(typed)).toBe(typed)
  })

  it("is null for any other failure", () => {
    expect(asConversationMovedError("turn already in progress")).toBeNull()
    expect(asConversationMovedError(new Error("boom"))).toBeNull()
    expect(asConversationMovedError(null)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import type { MessageTurn } from "@/lib/types"
import { needsEditReceipt, resolveEditableUserTurn } from "./message-edit"

function user(id: string, text = "same", offset = 0): MessageTurn {
  return {
    id,
    role: "user",
    timestamp: new Date(1700000000000 + offset).toISOString(),
    blocks: [{ type: "text", text }],
  }
}

describe("verified edit target identity", () => {
  it("accepts a backend receipt despite arbitrary delivery delay", () => {
    const local = user("optimistic-uuid")
    const target = user("turn-2", "same", 120000)
    expect(needsEditReceipt(local)).toBe(true)
    expect(
      resolveEditableUserTurn(local, [user("turn-0"), target], target)
    ).toBe(target)
  })
  it("never guesses a local target from content or timing", () => {
    const local = user("optimistic-uuid")
    expect(resolveEditableUserTurn(local, [user("turn-0")])).toBeNull()
  })
  it("accepts a proven receipt after provider whitespace normalization", () => {
    const local = user("optimistic-uuid", "explain a  b\t\tc")
    const parsed = user("turn-0", "explain a b c", 120000)
    expect(resolveEditableUserTurn(local, [parsed], parsed)).toBe(parsed)
    expect(resolveEditableUserTurn(local, [parsed])).toBeNull()
    expect(
      resolveEditableUserTurn(
        local,
        [user("turn-0", "changed", 120000)],
        parsed
      )
    ).toBeNull()
  })
  it("accepts a proven receipt when providers regroup text blocks", () => {
    const local: MessageTurn = {
      ...user("optimistic-uuid"),
      blocks: [
        { type: "text", text: "  first" },
        { type: "text", text: "second  part  " },
      ],
    }
    // Claude trims each block; Codex additionally collapses repeated spaces.
    for (const text of ["first\nsecond  part", "first\nsecond part"]) {
      const parsed = user("turn-0", text, 120000)
      expect(resolveEditableUserTurn(local, [parsed], parsed)).toBe(parsed)
    }
  })
  it("matches a historical occurrence by immutable snapshot", () => {
    const target = user("turn-2", "same", 10000)
    expect(needsEditReceipt(target)).toBe(false)
    expect(resolveEditableUserTurn(target, [user("turn-0"), target])).toBe(
      target
    )
  })
  it("rejects compaction or edits that changed a receipt's position", () => {
    const local = user("optimistic-uuid")
    const target = user("turn-2")
    expect(
      resolveEditableUserTurn(local, [user("turn-2", "different")], target)
    ).toBeNull()
    expect(
      resolveEditableUserTurn(local, [user("turn-2", "same", 10000)], target)
    ).toBeNull()
    expect(resolveEditableUserTurn(local, [user("turn-0")], target)).toBeNull()
    expect(
      resolveEditableUserTurn(local, [{ ...target, role: "assistant" }], target)
    ).toBeNull()
  })
  it("checks the receipt content and role, including image-only messages", () => {
    const image = {
      type: "image" as const,
      data: "bytes",
      mime_type: "image/png",
    }
    const local = {
      ...user("optimistic-image", "Attached image"),
      prompt_text: "",
      blocks: [image],
    }
    const parsed = { ...user("turn-0"), blocks: [image] }
    expect(resolveEditableUserTurn(local, [parsed], parsed)).toBe(parsed)
    expect(resolveEditableUserTurn(local, [user("turn-0")], parsed)).toBeNull()
    expect(
      resolveEditableUserTurn(
        local,
        [{ ...parsed, blocks: [{ ...image, data: "different" }] }],
        parsed
      )
    ).toBeNull()
    expect(
      resolveEditableUserTurn(local, [parsed], { ...parsed, role: "assistant" })
    ).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import type { MessageTurn } from "@/lib/types"
import { resolveEditableUserTurn } from "./message-edit"

function user(id: string, text = "same", offset = 0): MessageTurn {
  return {
    id,
    role: "user",
    timestamp: new Date(1_700_000_000_000 + offset).toISOString(),
    blocks: [{ type: "text", text }],
  }
}

describe("edit target identity", () => {
  it("uses sent prose instead of synthetic image-only display text", () => {
    const image = {
      type: "image" as const,
      data: "bytes",
      mime_type: "image/png",
    }
    const local = {
      ...user("optimistic-image", "Attached 1 attachment"),
      prompt_text: "",
    }
    local.blocks.push(image)
    const parsed = { ...user("turn-0"), blocks: [image] }
    expect(
      resolveEditableUserTurn(local, [parsed], {
        timeline: [local],
        loadedFromStart: true,
      })
    ).toBe(parsed)
  })

  it("requires a verified anchor when older history is unloaded", () => {
    const local = user("optimistic-latest")
    expect(
      resolveEditableUserTurn(local, [user("turn-8")], {
        timeline: [local],
        loadedFromStart: false,
      })
    ).toBeNull()
    const anchor = user("turn-6", "older", -10000)
    const parsed = user("turn-8", "same", 100)
    expect(
      resolveEditableUserTurn(local, [anchor, parsed], {
        timeline: [anchor, local],
        loadedFromStart: false,
      })
    ).toBe(parsed)
  })

  it("counts repeated locally sent prompts and refuses the unflushed second one", () => {
    const first = user("optimistic-first")
    const second = user("optimistic-second", "same", 100)
    const parsedFirst = user("turn-0", "same", 50)
    const parsedSecond = user("turn-2", "same", 150)
    const context = { timeline: [first, second], loadedFromStart: true }
    expect(resolveEditableUserTurn(second, [parsedFirst], context)).toBeNull()
    expect(
      resolveEditableUserTurn(second, [parsedFirst, parsedSecond], context)
    ).toBe(parsedSecond)
  })

  it("selects the specific historical occurrence, including repeated prompts", () => {
    const first = user("turn-0")
    const selected = user("turn-2", "same", 10000)
    expect(
      resolveEditableUserTurn(selected, [first, selected], {
        timeline: [first, selected],
        loadedFromStart: true,
      })
    ).toBe(selected)
  })

  it("refuses a positional id reassigned by compaction", () => {
    expect(
      resolveEditableUserTurn(user("turn-2"), [user("turn-2", "different")])
    ).toBeNull()
    expect(
      resolveEditableUserTurn(user("turn-2"), [user("turn-2", "same", 10000)])
    ).toBeNull()
    expect(resolveEditableUserTurn(user("turn-2"), [user("turn-0")])).toBeNull()
  })

  it("resolves the latest local UUID after persistence without assuming tail", () => {
    const local = user("optimistic-uuid")
    const persisted = user("turn-2", "same", 200)
    expect(
      resolveEditableUserTurn(
        local,
        [user("turn-0", "same", -20000), persisted],
        {
          timeline: [user("turn-0", "same", -20000), local],
          loadedFromStart: true,
        }
      )
    ).toBe(persisted)
  })

  it("refuses ambiguous repeated messages and a transcript not yet flushed", () => {
    const local = user("optimistic-uuid")
    expect(
      resolveEditableUserTurn(local, [user("turn-0")], {
        timeline: [user("turn-0"), local],
        loadedFromStart: true,
      })
    ).toBeNull()
    expect(
      resolveEditableUserTurn(local, [], {
        timeline: [local],
        loadedFromStart: true,
      })
    ).toBeNull()
  })

  it("matches image bytes despite parser image ordering and nullable uri", () => {
    const local = user("optimistic-uuid")
    const image = {
      type: "image" as const,
      data: "bytes",
      mime_type: "image/png",
    }
    local.blocks.unshift({ ...image, uri: "file:///upload.png" })
    const parsed = user("turn-0", "same", 200)
    parsed.blocks.push(image)
    expect(
      resolveEditableUserTurn(local, [parsed], {
        timeline: [local],
        loadedFromStart: true,
      })
    ).toBe(parsed)
    parsed.blocks[1] = { ...image, data: "other" }
    expect(
      resolveEditableUserTurn(local, [parsed], {
        timeline: [local],
        loadedFromStart: true,
      })
    ).toBeNull()
  })

  it("does not infer identity from an invalid timestamp or non-user turn", () => {
    const local = { ...user("uuid"), timestamp: "" }
    expect(
      resolveEditableUserTurn(local, [user("turn-0")], {
        timeline: [local],
        loadedFromStart: true,
      })
    ).toBeNull()
    expect(
      resolveEditableUserTurn({ ...user("turn-0"), role: "assistant" }, [
        user("turn-0"),
      ])
    ).toBeNull()
  })
})

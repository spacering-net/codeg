import { describe, expect, it } from "vitest"

import { messageText, messageWords } from "../../matter-text"
import type { ItemInfo } from "@/lib/types"

const item = (over: Partial<ItemInfo>): ItemInfo =>
  ({
    id: 1,
    kind: "message",
    summary: "Waiting for 产品's answer: 请基于…",
    ...over,
  }) as ItemInfo

describe("a message's matter", () => {
  it("reads what was written off its line, all of it", () => {
    const m = item({ written: "请基于\n第二行", direction: "out" })
    expect(messageWords(m)).toEqual({ text: "请基于\n第二行", toMe: false })
    expect(messageText(m)).toBe("请基于\n第二行")
  })

  it("knows one written to this assistant", () => {
    expect(messageWords(item({ written: "看一下", direction: "in" }))).toEqual({
      text: "看一下",
      toMe: true,
    })
  })

  it("shows an older read's summary as it is", () => {
    const old = item({})
    expect(messageWords(old)).toBeNull()
    expect(messageText(old)).toBe(old.summary)
  })
})

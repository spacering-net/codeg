import { describe, expect, it } from "vitest"

import { isOneCard } from "./reply-split"

describe("isOneCard", () => {
  const card = '```spec\n{"root":"a","elements":{}}\n```'
  it("is a reply that is one spec fence and nothing else", () => {
    expect(isOneCard(card)).toBe(true)
    expect(isOneCard(`\n${card}\n\n`)).toBe(true)
    expect(isOneCard("````spec\n```\ninner\n```\n````")).toBe(true)
    // Written with CRLF line ends, as Streamdown reads it too.
    expect(isOneCard(card.replace(/\n/g, "\r\n"))).toBe(true)
  })

  it("is not one with words around it, two cards, or another fence", () => {
    expect(isOneCard(`Here it is:\n\n${card}`)).toBe(false)
    expect(isOneCard(`${card}\n\nThat's all.`)).toBe(false)
    expect(isOneCard(`${card}\n\n${card}`)).toBe(false)
    expect(isOneCard("```ts\nconst a = 1\n```")).toBe(false)
    expect(isOneCard("```spec\n{}")).toBe(false)
    expect(isOneCard("plain words")).toBe(false)
  })
})

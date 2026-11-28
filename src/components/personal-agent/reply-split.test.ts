import { describe, expect, it } from "vitest"

import { replyPieces } from "./reply-split"

describe("replyPieces", () => {
  const card = '```spec\n{"op":"add","path":"/root","value":"a"}\n```'

  it("cuts a reply's words from its cards, in order", () => {
    expect(replyPieces(`Here it is:\n\n${card}\n\nThat's all.`)).toEqual([
      { kind: "text", text: "Here it is:" },
      { kind: "card", text: card },
      { kind: "text", text: "That's all." },
    ])
    expect(replyPieces(`\n${card}\n\n`)).toEqual([{ kind: "card", text: card }])
    expect(replyPieces(`${card}\n${card}`)).toEqual([
      { kind: "card", text: card },
      { kind: "card", text: card },
    ])
    // Written with CRLF line ends: kept, as the card's id is its source's.
    const crlf = card.replace(/\n/g, "\r\n")
    expect(replyPieces(`Hi\r\n\r\n${crlf}\r\n`)).toEqual([
      { kind: "text", text: "Hi" },
      { kind: "card", text: crlf },
    ])
  })

  it("keeps words as written but for the blank lines round them", () => {
    // Code indented four spaces right after a card is still code; a line's
    // own spaces stay.
    expect(replyPieces(`${card}\n\n    npm run build\nDone.  \n\n`)).toEqual([
      { kind: "card", text: card },
      { kind: "text", text: "    npm run build\nDone.  " },
    ])
  })

  it("takes a card up to three spaces in, and leaves one in a quote", () => {
    const indented = `  ${card.replace(/\n/g, "\n  ")}`
    expect(replyPieces(indented)).toEqual([{ kind: "card", text: indented }])
    const quoted = `> ${card.replace(/\n/g, "\n> ")}`
    expect(replyPieces(quoted)).toEqual([{ kind: "text", text: quoted }])
  })

  it("takes a card still being written to the end of the text", () => {
    expect(replyPieces('Look:\n```spec\n{"op":"add"')).toEqual([
      { kind: "text", text: "Look:" },
      { kind: "card", text: '```spec\n{"op":"add"' },
    ])
    // Not a card until its first line is one: code till then, as drawn.
    expect(replyPieces("Look:\n```spec\n")).toEqual([
      { kind: "text", text: "Look:\n```spec" },
    ])
  })

  it("leaves other fences, a spec that is no card and one inside a fence in the words", () => {
    const code = "```ts\nconst a = 1\n```"
    expect(replyPieces(`Run:\n${code}`)).toEqual([
      { kind: "text", text: `Run:\n${code}` },
    ])
    const rpm = "```spec\nName: codeg\n```"
    expect(replyPieces(rpm)).toEqual([{ kind: "text", text: rpm }])
    const shown = `\`\`\`\`markdown\n${card}\n\`\`\`\``
    expect(replyPieces(shown)).toEqual([{ kind: "text", text: shown }])
    // A longer fence closes only on one at least as long.
    const long = '````spec\n{"op":"add"}\n```\nstill in\n````'
    expect(replyPieces(`${long}\nafter`)).toEqual([
      { kind: "card", text: long },
      { kind: "text", text: "after" },
    ])
    expect(replyPieces("plain words")).toEqual([
      { kind: "text", text: "plain words" },
    ])
    expect(replyPieces("  \n ")).toEqual([])
  })
})

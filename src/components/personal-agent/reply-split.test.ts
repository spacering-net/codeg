import { describe, expect, it } from "vitest"

import { splitReply } from "./reply-split"

describe("splitReply", () => {
  it("splits short paragraphs at blank lines", () => {
    expect(
      splitReply("Done.\n\nThe build is green.\n \nNext: the PR.")
    ).toEqual(["Done.", "The build is green.", "Next: the PR."])
  })

  it("keeps one paragraph whole", () => {
    expect(splitReply("Done.\nThe build is green.")).toEqual([
      "Done.\nThe build is green.",
    ])
  })

  it("keeps a reply with a long paragraph whole", () => {
    const long = "x".repeat(281)
    expect(splitReply(`Short.\n\n${long}`)).toEqual([`Short.\n\n${long}`])
    // 280 counts characters, not UTF-16 units.
    const cjk = "派".repeat(280)
    expect(splitReply(`好。\n\n${cjk}`)).toEqual(["好。", cjk])
  })

  it("keeps a reply with a code block or a card whole", () => {
    const code = "Here:\n\n```ts\nconst a = 1\n```\n\nThat is all."
    expect(splitReply(code)).toEqual([code])
    const card =
      'Look:\n\n```spec\n{"op":"add","path":"/root","value":"m"}\n```'
    expect(splitReply(card)).toEqual([card])
    const tilde = "A.\n\n~~~\nx\n~~~"
    expect(splitReply(tilde)).toEqual([tilde])
  })

  it("makes at most four bubbles, the rest joining the last", () => {
    expect(splitReply("a\n\nb\n\nc\n\nd\n\ne\n\nf")).toEqual([
      "a",
      "b",
      "c",
      "d\n\ne\n\nf",
    ])
  })
})

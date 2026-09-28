import { describe, expect, it } from "vitest"

import { chunkSpeakableText, toSpeakableText } from "./speakable-text"

const labels = {
  codeOmitted: "Code block omitted",
  tableOmitted: "Table omitted",
}

describe("toSpeakableText", () => {
  it("replaces fenced code with the label and keeps inline code", () => {
    const md = "Run `pnpm test` first.\n\n```ts\nconst x = 1\n```\n\nDone"
    expect(toSpeakableText(md, labels)).toBe(
      "Run pnpm test first. Code block omitted. Done."
    )
  })

  it("keeps link text and drops link targets and bare URLs", () => {
    const md =
      "See [the docs](https://example.com/a) or https://example.com/b now"
    expect(toSpeakableText(md, labels)).toBe("See the docs or now.")
  })

  it("replaces tables with the label", () => {
    const md = "Results:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
    expect(toSpeakableText(md, labels)).toBe("Results: Table omitted.")
  })

  it("reads headings, list items and quotes as sentences", () => {
    const md = "# Summary\n\n- first item\n- second item!\n\n> quoted"
    expect(toSpeakableText(md, labels)).toBe(
      "Summary. first item. second item! quoted."
    )
  })

  it("drops images, html, rules and footnote definitions; unwraps emphasis", () => {
    const md =
      "A **bold** _and_ ~~gone~~ word[^1]\n\n![alt](x.png)\n\n<div>raw</div>\n\n---\n\n[^1]: note"
    expect(toSpeakableText(md, labels)).toBe("A bold and gone word.")
  })
})

describe("chunkSpeakableText", () => {
  it("packs whole sentences up to maxLen", () => {
    expect(chunkSpeakableText("One. Two. Three.", 10)).toEqual([
      "One. Two.",
      " Three.",
    ])
  })

  it("splits CJK sentences on full-width punctuation and hard-splits long runs", () => {
    const text = "你好。今天天气很好！" + "长".repeat(12)
    const chunks = chunkSpeakableText(text, 5)
    expect(chunks.every((c) => c.length <= 5)).toBe(true)
    expect(chunks.join("")).toBe(text)
    expect(chunks[0]).toBe("你好。")
  })

  it("hard-splits a long Latin sentence at the last space", () => {
    const chunks = chunkSpeakableText("alpha beta gamma delta", 12)
    expect(chunks).toEqual(["alpha beta ", "gamma delta"])
  })

  it("keeps every chunk within maxLen and loses nothing on a 10 000-char input", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. "
    const text = sentence.repeat(Math.ceil(10_000 / sentence.length)).trim()
    const chunks = chunkSpeakableText(text, 220)
    expect(text.length).toBeGreaterThanOrEqual(10_000)
    expect(chunks.every((c) => c.length <= 220)).toBe(true)
    expect(chunks.join("")).toBe(text)
  })
})

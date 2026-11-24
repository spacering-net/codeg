import { describe, expect, it } from "vitest"

import { textTokenAt } from "./text-token-at"

/** Offset of the first character of `needle`, plus `within` characters. */
function at(text: string, needle: string, within = 1): number {
  const index = text.indexOf(needle)
  expect(index).toBeGreaterThanOrEqual(0)
  return index + within
}

describe("textTokenAt", () => {
  it("returns nothing for empty text", () => {
    expect(textTokenAt("", 0)).toBeNull()
  })

  it("returns nothing when the caret sits in whitespace", () => {
    const text = "ping  adam@example.com"
    expect(textTokenAt(text, 5)).toBeNull()
  })

  it("reads an address out of a sentence", () => {
    const text = "mail adam.d@example.co.uk about it"
    const token = textTokenAt(text, at(text, "adam.d@", 3))
    expect(token).toEqual({
      kind: "email",
      value: "adam.d@example.co.uk",
      start: 5,
      end: 25,
      href: "mailto:adam.d@example.co.uk",
    })
  })

  it("keeps an address whole through wrapping punctuation", () => {
    const text = "(adam@example.com),"
    const token = textTokenAt(text, at(text, "adam"))
    expect(token?.kind).toBe("email")
    expect(token?.value).toBe("adam@example.com")
  })

  it("unwraps a mailto address to the same action", () => {
    const token = textTokenAt("mailto:adam@example.com", 12)
    expect(token?.kind).toBe("email")
    expect(token?.value).toBe("mailto:adam@example.com")
    expect(token?.href).toBe("mailto:adam@example.com")
  })

  it("reads a url with a scheme, including its query", () => {
    const text = "see https://example.com/docs?q=1#top for more"
    const token = textTokenAt(text, at(text, "https", 8))
    expect(token?.kind).toBe("url")
    expect(token?.value).toBe("https://example.com/docs?q=1#top")
    expect(token?.href).toBe("https://example.com/docs?q=1#top")
  })

  it("completes a schemeless url to https", () => {
    const token = textTokenAt("www.example.com/path", 4)
    expect(token?.kind).toBe("url")
    expect(token?.href).toBe("https://www.example.com/path")
  })

  it("reads a bare host with a common web tld as a url", () => {
    const token = textTokenAt("try example.com today", 6)
    expect(token?.kind).toBe("url")
    expect(token?.value).toBe("example.com")
    expect(token?.href).toBe("https://example.com")
  })

  it("keeps a source filename out of the url bucket", () => {
    const token = textTokenAt("open utils.ts please", 7)
    expect(token?.kind).toBe("word")
    expect(token?.value).toBe("utils.ts")
    expect(token?.href).toBeUndefined()
  })

  it("drops the sentence period after a url but keeps a balanced paren", () => {
    const text = "read https://en.wikipedia.org/wiki/Ruby_(gem)."
    const token = textTokenAt(text, at(text, "wiki"))
    expect(token?.value).toBe("https://en.wikipedia.org/wiki/Ruby_(gem)")
  })

  it("drops an unbalanced closing paren", () => {
    const text = "(see https://example.com/a)"
    const token = textTokenAt(text, at(text, "example"))
    expect(token?.value).toBe("https://example.com/a")
  })

  it("reads a Windows path whole", () => {
    const text = "edit C:\\Users\\adam\\notes.md now"
    const token = textTokenAt(text, at(text, "Users"))
    expect(token?.kind).toBe("path")
    expect(token?.value).toBe("C:\\Users\\adam\\notes.md")
    expect(token?.href).toBeUndefined()
  })

  it("reads a UNC path whole", () => {
    const token = textTokenAt("\\\\build\\share\\out.log", 9)
    expect(token?.kind).toBe("path")
    expect(token?.value).toBe("\\\\build\\share\\out.log")
  })

  it("reads a POSIX path whole, line suffix included", () => {
    const text = "crash at /var/log/app.log:42 tonight"
    const token = textTokenAt(text, at(text, "/var"))
    expect(token?.kind).toBe("path")
    expect(token?.value).toBe("/var/log/app.log:42")
  })

  it("reads home and relative paths as paths", () => {
    expect(textTokenAt("~/.config/codeg", 4)?.kind).toBe("path")
    expect(textTokenAt("./src/lib/utils.ts", 4)?.kind).toBe("path")
    expect(textTokenAt("../sibling/main.rs", 4)?.kind).toBe("path")
  })

  it("reads a bare repo-relative path as a path", () => {
    const token = textTokenAt("src/components/chat/message-input.tsx", 6)
    expect(token?.kind).toBe("path")
    expect(token?.value).toBe("src/components/chat/message-input.tsx")
  })

  it("reads a plain word and drops its trailing comma", () => {
    const text = "hello, world"
    const token = textTokenAt(text, 2)
    expect(token).toEqual({
      kind: "word",
      value: "hello",
      start: 0,
      end: 5,
    })
  })

  it("keeps an apostrophe inside a word but not around it", () => {
    expect(textTokenAt("it's", 1)?.value).toBe("it's")
    expect(textTokenAt("'quoted'", 3)?.value).toBe("quoted")
  })

  it("takes the run starting at the caret when it sits on the first character", () => {
    const text = "alpha beta"
    expect(textTokenAt(text, 6)?.value).toBe("beta")
  })

  it("reaches back for the run the caret ends", () => {
    const text = "alpha beta"
    expect(textTokenAt(text, 5)?.value).toBe("alpha")
    expect(textTokenAt(text, text.length)?.value).toBe("beta")
  })

  it("clamps an out-of-range offset instead of failing", () => {
    expect(textTokenAt("alpha", -5)?.value).toBe("alpha")
    expect(textTokenAt("alpha", 99)?.value).toBe("alpha")
  })

  it("selects a run made only of punctuation rather than nothing", () => {
    const token = textTokenAt("a ... b", 3)
    expect(token?.kind).toBe("word")
    expect(token?.value).toBe("...")
  })
})

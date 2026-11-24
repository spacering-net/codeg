import { describe, expect, it } from "vitest"

import { normalizeItemDetail } from "./normalize"
import {
  approximateTokens,
  languageName,
  promptLength,
  promptRights,
  promptTextOf,
  QUICK_MESSAGE_MAX_BYTES,
  QUICK_MESSAGE_TITLE_MAX,
  quickMessageDraft,
} from "./prompt"
import { PROMPT_TEXT, rawPromptDetail } from "./test-fixtures"

describe("a prompt's length", () => {
  it("counts characters as a person does, not UTF-16 units", () => {
    expect(promptLength("héllo 🎬").chars).toBe(7)
    expect(promptLength("动效").chars).toBe(2)
  })

  it("estimates tokens at four characters each in Latin script", () => {
    expect(approximateTokens("a".repeat(400))).toBe(100)
    expect(approximateTokens("a".repeat(2711))).toBe(680)
  })

  it("counts Chinese, Japanese and Korean at about a token a character", () => {
    expect(approximateTokens("帮我做一个原创的手游")).toBe(10)
    expect(approximateTokens("ひらがなカタカナ한국어")).toBe(11)
  })

  it("rounds to two significant figures, never below one for some text", () => {
    expect(approximateTokens("a".repeat(5123 * 4))).toBe(5100)
    expect(approximateTokens("ab")).toBe(1)
    expect(approximateTokens("")).toBe(0)
  })
})

describe("saving a prompt as a quick message", () => {
  it("takes the title on one line and the text exactly as it is", () => {
    const text = "  Line one\n\n\tline two  "
    expect(quickMessageDraft("  A title\nthat wraps  ", text)).toEqual({
      ok: true,
      title: "A title that wraps",
      content: text,
    })
  })

  it("cuts a long title to what a menu line shows", () => {
    const draft = quickMessageDraft("word ".repeat(40), "Text")
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    expect(Array.from(draft.title)).toHaveLength(QUICK_MESSAGE_TITLE_MAX)
    expect(draft.title.endsWith("…")).toBe(true)
  })

  it("cuts by characters, never through one", () => {
    const draft = quickMessageDraft("🎬".repeat(100), "Text")
    expect(draft.ok && Array.from(draft.title).slice(0, -1).join("")).toBe(
      "🎬".repeat(QUICK_MESSAGE_TITLE_MAX - 1)
    )
  })

  it("does not save a prompt with no text, or one past the size a request takes", () => {
    expect(quickMessageDraft("Title", " \n\t")).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(
      quickMessageDraft("Title", "a".repeat(QUICK_MESSAGE_MAX_BYTES + 1))
    ).toEqual({ ok: false, reason: "tooLong" })
    // Bytes, not characters: three bytes each.
    expect(
      quickMessageDraft("Title", "动".repeat(QUICK_MESSAGE_MAX_BYTES / 3 + 1))
    ).toEqual({ ok: false, reason: "tooLong" })
  })
})

describe("whose a prompt is", () => {
  it("reads the two rights the catalog names, and nothing else", () => {
    expect(promptRights({ rights: "creators" })).toBe("creators")
    expect(promptRights({ rights: "license" })).toBe("license")
    expect(promptRights({ rights: "public-domain" })).toBe("unknown")
    expect(promptRights(undefined)).toBe("unknown")
  })
})

describe("a prompt's text", () => {
  it("is the one the item carries", () => {
    const item = normalizeItemDetail(rawPromptDetail())
    expect(promptTextOf(item)).toBe(PROMPT_TEXT)
  })

  it("is asked for on its own when the item carries none", () => {
    expect(
      promptTextOf(normalizeItemDetail(rawPromptDetail({ text: "" })))
    ).toBe(null)
    const bare = rawPromptDetail()
    delete (bare.install as Record<string, unknown>).prompt
    expect(promptTextOf(normalizeItemDetail(bare))).toBe(null)
  })
})

describe("a language's name", () => {
  it("is in the interface's language", () => {
    expect(languageName("ja", "en")).toBe("Japanese")
    expect(languageName("en", "de")).toBe("Englisch")
  })

  it("is the code as given when there is no name for it", () => {
    expect(languageName("not a code", "en")).toBe("not a code")
  })
})

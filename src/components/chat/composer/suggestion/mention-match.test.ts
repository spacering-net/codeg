import { describe, expect, it } from "vitest"

import { canStartMentionAt } from "./mention-match"

/** `@` appended to `prefix`, asked about at the `@`'s own offset. */
function afterPrefix(prefix: string): boolean {
  return canStartMentionAt(`${prefix}@app`, prefix.length)
}

describe("canStartMentionAt", () => {
  it("allows the start of the text node and any whitespace", () => {
    // Index 0 is also where an `@` typed right after a reference badge or a
    // hard break lands: each starts a fresh text node.
    expect(canStartMentionAt("@app", 0)).toBe(true)
    for (const prefix of [" ", "\n", "\t", " ", "　"]) {
      expect(afterPrefix(prefix)).toBe(true)
    }
  })

  it("allows the scripts that are written without spaces between words", () => {
    // Han, kana, Hangul, Bopomofo and the punctuation those scripts use — a
    // Chinese sentence never offers a space before `@`.
    for (const prefix of [
      "请看",
      "汇",
      "テスト",
      "ん",
      "한글",
      "ㄅ",
      "你好，",
      "结束。",
      "「引用」",
      "（括号）",
      "标题：",
    ]) {
      expect(afterPrefix(prefix)).toBe(true)
    }
  })

  it("allows the Common-script marks that CJK words end on", () => {
    // ー (U+30FC) and ・ (U+30FB) are `Script=Common`, so no script class claims
    // them, yet ー is where a katakana word ends — the very position an `@`
    // follows. Listed individually rather than reached by widening the classes
    // to `Script_Extensions` (see the next test for why).
    expect(afterPrefix("ユーザー")).toBe(true)
    expect(afterPrefix("サーバー")).toBe(true)
    expect(afterPrefix("ヨミ・カナ")).toBe(true)
    expect(afterPrefix("ゲーム゠センター")).toBe(true)
    // The middle dot separates transliterated names in Chinese (玛丽·居里).
    expect(afterPrefix("玛丽·居里")).toBe(true)
  })

  it("does not let a combining mark carry a Latin local part past the guard", () => {
    // `Script_Extensions=Katakana` reaches U+0305 and U+0323, which are the
    // marks a Latin letter takes. Since the check reads the last code point,
    // admitting them would make the mark — not the `a` it sits on — the
    // "character before the @", and `a◌̣@example.com` would open the panel.
    //
    // Escapes, not literals: normalizing this file to NFC would fold `a` +
    // U+0323 to the precomposed U+1EA1, which the guard rejects for being a
    // Latin letter — the assertion would still pass while no longer touching
    // the combining-mark path it exists to pin.
    expect(afterPrefix("a\u0323")).toBe(false)
    expect(afterPrefix("o\u0305")).toBe(false)
    expect(afterPrefix("me\u0323")).toBe(false)
  })

  it("allows a Han character from beyond the BMP", () => {
    // 𠀋 is a surrogate pair, so the code unit right before `@` is only its low
    // half — stepping back one unit instead of one code point would reject it.
    expect(afterPrefix("𠀋")).toBe(true)
    expect(afterPrefix("先祖𠀋")).toBe(true)
  })

  it("keeps blocking the tail of an email's local part", () => {
    // `me@x.com`, `foo9@…`, `a.b@…`, `a_b@…`, `a-b@…`: opening the file picker
    // mid-address is the false positive the prefix rule exists to stop.
    for (const prefix of [
      "me",
      "Z",
      "foo9",
      "a.b",
      "a_b",
      "a-b",
      "a+b",
      "100%",
      "(",
      "[",
    ]) {
      expect(afterPrefix(prefix)).toBe(false)
    }
  })
})

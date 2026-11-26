import { describe, expect, it } from "vitest"

import { messageFingerprint, normalizeCheckText } from "./message-check"

describe("messageFingerprint", () => {
  it("is the backend's: FNV-1a 64 of the normalized text", () => {
    // The same values as fact_check.rs's unit test.
    expect(messageFingerprint("")).toBe("cbf29ce484222325")
    expect(messageFingerprint("a")).toBe("af63dc4c8601ec8c")
    expect(messageFingerprint("改了 3 个文件")).toBe("08c7c756ba473467")
    expect(
      messageFingerprint("The build passes now.\nI changed src/build.rs.")
    ).toBe("f0d7e28de5fba698")
  })

  it("leaves out blank edges and Windows line ends, nothing else", () => {
    expect(messageFingerprint("  hello\r\nworld\n\n")).toBe("7401c5c6850a2279")
    expect(messageFingerprint("hello\nworld")).toBe("7401c5c6850a2279")
    expect(messageFingerprint("hello  world")).not.toBe(
      messageFingerprint("hello world")
    )
    // Only ASCII whitespace, as the backend trims: a no-break space stays.
    expect(normalizeCheckText("\u00a0x\u00a0 ")).toBe("\u00a0x\u00a0")
  })
})

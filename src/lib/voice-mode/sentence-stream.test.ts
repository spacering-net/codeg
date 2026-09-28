import { describe, expect, it } from "vitest"
import { createSentenceStream } from "./sentence-stream"

const labels = {
  codeOmitted: "Code block omitted.",
  tableOmitted: "Table omitted.",
}

describe("createSentenceStream", () => {
  it("splits text on sentence boundaries", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("Hello")).toEqual([])
    expect(stream.push(" world. ")).toEqual(["Hello world."])
    expect(stream.push("This is ")).toEqual([])
    expect(stream.push("a test! And")).toEqual(["This is a test!"])
    expect(stream.flush()).toEqual(["And."])
  })

  it("handles CJK punctuation", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("你好")).toEqual([])
    expect(stream.push("世界。")).toEqual(["你好世界。"])
    expect(stream.push("測試！")).toEqual(["測試！"])
  })

  it("handles code fences and emits one label when closed", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("Here is code:\n```t")).toEqual(["Here is code:"])
    expect(stream.push("s\nconst x = 1;\n")).toEqual([])
    expect(stream.push("```\nAnd more")).toEqual(["Code block omitted."])
    expect(stream.flush()).toEqual(["And more."])
  })

  it("does not split inside a code block", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("```\nHello. World. \n```")).toEqual([
      "Code block omitted.",
    ])
  })

  it("flushes tail properly", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("Just some text")).toEqual([])
    expect(stream.flush()).toEqual(["Just some text."])
  })

  it("drops empty results from toSpeakableText", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("![image](url) ")).toEqual([])
    expect(stream.push("\n\n")).toEqual([])
    expect(stream.flush()).toEqual([])
  })

  it("handles a chunk over 400 chars splitting on space", () => {
    const stream = createSentenceStream(labels)
    const longWord = "a".repeat(300)
    const text = `${longWord} ${longWord} `
    expect(stream.push(text)).toEqual([`${longWord} ${longWord}.`])
    expect(stream.flush()).toEqual([])
  })

  it("handles inline code and links via toSpeakableText", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("Click [here](http://test) to see `code`. ")).toEqual([
      "Click here to see code.",
    ])
  })

  it("does not split on terminator without whitespace unless flush", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("version 3.")).toEqual([])
    expect(stream.push("14 is out.")).toEqual([])
    expect(stream.flush()).toEqual(["version 3.14 is out."])
  })

  it("handles fence marker split across deltas", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("`")).toEqual([])
    expect(stream.push("``js\ncode\n``")).toEqual([])
    expect(stream.push("`\nAfter.")).toEqual(["Code block omitted."])
    expect(stream.flush()).toEqual(["After."])
  })

  it("handles a delta splitting a word mid-way", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("This is a spl")).toEqual([])
    expect(stream.push("it word. ")).toEqual(["This is a split word."])
  })

  it("speaks one code-omitted label for a fence left open at the end", () => {
    const stream = createSentenceStream(labels)
    expect(stream.push("Run this:\n```sh\nnpm test\n")).toEqual(["Run this:"])
    expect(stream.flush()).toEqual(["Code block omitted."])
  })
})

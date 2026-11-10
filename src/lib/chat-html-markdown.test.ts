import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "@/components/ai-elements/message"
import { createChatHtmlProcessor } from "./chat-html-markdown"

describe("聊天 HTML 片段识别", () => {
  it("按顶层 Markdown AST 识别 HTML，保留前后正文和内部空行", () => {
    const source =
      'Before.\n\n<div style="display:grid">\n\n<p>A</p>\n\n</div>\n\nAfter.'
    const result = createChatHtmlProcessor()(source, false)
    expect(result).toContain("Before.")
    expect(result).toContain("After.")
    expect(result).toContain("```codeg-html\n<div")
    expect(result).toContain("\n\n<p>A</p>\n\n</div>")
  })

  it("将前置 style 与其后的根元素放在同一个片段", () => {
    const result = createChatHtmlProcessor()(
      '<style>.x { color:red }</style>\n\n<div class="x">A</div>',
      false
    )
    expect(result.match(/```codeg-html\n/g)).toHaveLength(1)
    expect(result).toContain(
      '<style>.x { color:red }</style>\n\n<div class="x">A</div>'
    )
  })

  it.each([
    "```text\n<div>Example</div>\n```",
    "An inline `<div>Example</div>`.",
    "Some <span>inline HTML</span> text.",
    "    <div>Indented code</div>",
  ])("不重写普通代码和行内 HTML：%s", (source) => {
    expect(createChatHtmlProcessor()(source, false)).toBe(source)
  })

  it("正确跳过注释、属性中的尖括号和 CSS 原始文本", () => {
    const source =
      '<!-- <div> -->\n<style>.x::before{content:"</div>"}</style>\n<div title="a > b"><svg><path d="M0 0" /></svg><br>A</div>'
    const result = createChatHtmlProcessor()(source, false)
    expect(result).toContain("```codeg-html\n")
    expect(result).toContain(source)
  })

  it("流式内容不完整时使用等待状态，结束后保留源码", () => {
    const source = '<div class="card"><p>Partial</p>'
    const process = createChatHtmlProcessor()
    expect(process(source, true)).toContain("```codeg-html-pending\n")
    expect(process(source, false)).toContain("```codeg-html-source\n")
  })

  it("完整前缀不受后续 HTML 和 Markdown 追加影响，编辑历史内容时重置缓存", () => {
    const process = createChatHtmlProcessor()
    const first = process("<div>First</div>\n\nTail", true)
    expect(first).toContain("```codeg-html\n<div>First</div>\n```")
    expect(process("<div>First</div>\n\nTail.", true)).toBe(first + ".")
    const changed = process("<div>Changed</div>", false)
    expect(changed).toContain("Changed")
    expect(changed).not.toContain("First")
  })

  it("片段在其后出现内容前仍可能接上同一 HTML 块的根元素，因此保持等待", () => {
    const process = createChatHtmlProcessor()
    const style = "<style>.c{color:red}</style>\n"
    expect(process(style + '<div class="c">A</div>', true)).toContain(
      "```codeg-html-pending\n"
    )
    expect(process(style + '<div class="c">A</div>\n', true)).toContain(
      "```codeg-html-pending\n"
    )
    const whole = style + '<div class="c">A</div>\n<div class="c">B</div>'
    const result = process(whole + "\n\nAfter.", true)
    expect(result.match(/```codeg-html\n/g)).toHaveLength(1)
    expect(result).toContain("```codeg-html\n" + whole + "\n```")
  })

  it("使用足够长的围栏，HTML 内部的反引号不会逃逸成主页面内容", () => {
    const result = createChatHtmlProcessor()(
      "<div>```\n<script>no()</script></div>",
      false
    )
    expect(result).toContain("````codeg-html\n")
    expect(result.trimEnd().endsWith("````")).toBe(true)
  })

  it("完整页面也作为单个 HTML 片段处理", () => {
    const source =
      "<!doctype html>\n<html><head><style>body{color:red}</style></head><body><p>A</p></body></html>"
    expect(createChatHtmlProcessor()(source, false)).toContain(
      "```codeg-html\n" + source
    )
  })

  it("同一原始 HTML 块中的相邻根元素都被保留在预览内", () => {
    const html =
      '<style>.x{color:red}</style>\n<div class="x">A</div>\n<div class="x">B</div>'
    const result = createChatHtmlProcessor()(html, false)
    expect(result).toContain('class="x">B</div>\n```')
    expect(result.match(/```codeg-html\n/g)).toHaveLength(1)
  })

  it("单独的 style 不吞掉其后的 Markdown 正文", () => {
    const result = createChatHtmlProcessor()(
      "<style>.x{color:red}</style>\n\nNormal **prose**.",
      false
    )
    expect(result).toContain("</style>\n```\n\nNormal **prose**.")
  })

  it("同一 HTML 块中第二个根元素未闭合时不提前渲染", () => {
    const result = createChatHtmlProcessor()("<div>A</div>\n<div>B", true)
    expect(result).toContain("```codeg-html-pending\n")
  })

  it("Markdown 预处理只影响正文，不改写 HTML 的原始字节", () => {
    const html = '<div title="literal">```\\(inside\\)</div>'
    const result = createChatHtmlProcessor()(
      "Outside\\(x\\)\n\n" + html,
      false,
      (text) => text.split("\\(").join("$")
    )
    expect(result).toContain("Outside$x\\)")
    expect(result).toContain(html)
  })

  it.each([
    [
      "Markdown 包在标签里（<details> 里的列表）",
      "Intro.\n\n<details>\n<summary>More</summary>\n\n- item **one**\n- item two\n\n</details>\n\nAfter.",
    ],
    [
      "根元素一直没有闭合，后面是 Markdown",
      '<div align="center">\n\n**Title**\n\n- a\n- b\n\n## Heading\n\nMore text.',
    ],
    [
      "同一块中第二个根元素没有闭合，后面是 Markdown",
      "<div>A</div>\n<p>B\n\nMore **markdown** here.\n\n## Heading",
    ],
    [
      "闭合标签落在段落中间",
      "<div>\nstart\n\nsome *md* paragraph </div> trailing words\n\nNext para",
    ],
  ])("标签跨过 Markdown 才闭合时不当作片段：%s", (_, source) => {
    for (const streaming of [true, false])
      expect(createChatHtmlProcessor()(source, streaming)).toBe(source)
  })

  it("块内空行后缩进四格的 HTML 仍属同一片段", () => {
    const html =
      '<div class="grid">\n    <div class="card">A</div>\n\n    <div class="card">B</div>\n</div>'
    const result = createChatHtmlProcessor()(html + "\n\nAfter.", false)
    expect(result).toBe("```codeg-html\n" + html + "\n```\n\nAfter.")
  })

  it("闭合的 HTML 围栏即使不是单个根元素也直接预览，流式中不再显示等待", () => {
    const source = "```html\nHello <b>x</b>\n```\n\nMore prose"
    for (const streaming of [true, false])
      expect(createChatHtmlProcessor()(source, streaming)).toBe(
        "```codeg-html\nHello <b>x</b>\n```\n\nMore prose"
      )
  })

  it("围栏的闭合行写完之前仍在等待；被截断的围栏只在有完整根元素时预览", () => {
    const process = createChatHtmlProcessor()
    expect(process("```html\n<p>x</p>\n```", true)).toContain(
      "codeg-html-pending"
    )
    expect(process("```html\n<p>x</p>\n```\n", true)).toContain(
      "```codeg-html\n<p>x</p>\n```"
    )
    expect(createChatHtmlProcessor()("```html\nHello <b", false)).toContain(
      "codeg-html-source"
    )
  })

  it("先到的等待片段不会被后面完成的片段一起封存", () => {
    const source =
      "```html\nHello<br>world\n```\n\n```html\n<div>Complete</div>\n```"
    const process = createChatHtmlProcessor()
    for (let i = 1; i <= source.length; i++) process(source.slice(0, i), true)
    const done = process(source, false)
    expect(done).not.toContain("codeg-html-pending")
    expect(done.match(/```codeg-html\n/g)).toHaveLength(2)
  })

  it("CRLF 换行的围栏在流式中也能闭合", () => {
    const process = createChatHtmlProcessor()
    process("```html\r\n<p>x</p>\r\n", true)
    expect(process("```html\r\n<p>x</p>\r\n```\r\n\r\nNext", true)).toContain(
      "```codeg-html\n"
    )
  })

  it("逐字流式的结果在结束时与一次性处理完全相同", () => {
    const documents = [
      'Intro **text** with `Map<string, T>`.\n\n<style>.c{color:red}</style>\n<div class="c">A</div>\n<div class="c">B</div>\n\nMiddle \\(a+b\\) here.\n\n```html\n<p>Fence</p>\n```\n\n<details>\n<summary>S</summary>\n\n- item\n\n</details>\n\n```tsx\n<Button />\n  <div>x</div>\n```\n\nEnd \\[c\\].',
      '<div align="center">\n\n**Title**\n\n</div>\n\nText <b>x</b>\n\n<table><tr><td>1</td></tr></table>\n',
      "```html\nHello<br>world\n```\n\n```html\n<div>Complete</div>\n```",
      '<div class="grid">\n    <div class="card">A</div>\n\n    <div class="card">B</div>\n</div>\n\n<section>\n<p>one</p>\n\n<p>two</p>\n</section>',
      // Display math across a blank line: the Markdown between fragments is
      // transformed a whole stretch at a time, however it arrived.
      "\\[\nx\n<a\n\nb\n\\]\n\nAfter.",
    ]
    for (const document of documents) {
      for (const transform of [undefined, normalizeMathDelimiters]) {
        const process = createChatHtmlProcessor()
        for (let i = 1; i <= document.length; i++)
          process(document.slice(0, i), true, transform)
        expect(process(document, false, transform)).toBe(
          createChatHtmlProcessor()(document, false, transform)
        )
      }
    }
  })

  it("文本被改写（不是追加）时重新处理，不沿用旧的结论", () => {
    const process = createChatHtmlProcessor()
    process("<div>\n<p>Card</p>\n\nold", true)
    const edited = "<div>\n<p>Card</p>\n\n</div>"
    expect(process(edited, false)).toBe(
      createChatHtmlProcessor()(edited, false)
    )
    expect(process(edited, false)).toContain("```codeg-html\n<div>")

    process("Intro\n\n```html\n<div>", true)
    expect(process("Intro\n\nPlain prose now.", true)).toBe(
      "Intro\n\nPlain prose now."
    )
  })
})

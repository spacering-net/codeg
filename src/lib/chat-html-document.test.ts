import { describe, expect, it } from "vitest"
import { buildChatHtmlDocument } from "./chat-html-document"

const options = {
  nonce: "test-nonce",
  dark: true,
  theme: ":root{--foreground:#eee}",
}

describe("聊天 HTML 文档隔离", () => {
  it("保留 CSS、SVG 和文档属性，剥离脚本、事件、嵌入和跳转", async () => {
    const doc = await buildChatHtmlDocument(
      '<html lang="zh" class="theme"><head><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><style>.x{display:flex}</style></head><body class="cards" onload="attack()"><div onclick="attack()"><script>attack()</script><iframe srcdoc="attack"></iframe><a href="javascript:attack()">A</a><svg><path d="M0 0" /></svg></div></body></html>',
      options
    )
    expect(doc).toContain('lang="zh"')
    expect(doc).toContain('class="cards"')
    expect(doc).toContain(".x{display:flex}")
    expect(doc).toContain("<svg>")
    expect(doc).not.toContain("attack")
    expect(doc).not.toContain("https://example.com")
    expect(doc.match(/<script/g)).toHaveLength(1)
    expect(doc).toContain("script-src 'nonce-test-nonce'")
    expect(doc).toContain('nonce="test-nonce"')
    expect(doc).not.toContain("'unsafe-eval'")
  })

  it("把主题默认值放在作者 CSS 之前，且不被 CSS 中的伪结束标签误导", async () => {
    const doc = await buildChatHtmlDocument(
      '<div><style>.x::before{content:"</head></body>"}body{margin:20px}</style><p>A</p></div>',
      options
    )
    const template = document.createElement("template")
    template.innerHTML = doc
    const styles = [...template.content.querySelectorAll("style")]
    expect(styles[0].textContent).toContain("--foreground:#eee")
    expect(styles[1].textContent).toContain('content:"</head></body>"')
    expect(
      template.content.querySelector("script")?.getAttribute("nonce")
    ).toBe("test-nonce")
  })

  it("剥离 SVG 的 xlink:href 和用动画写入的链接，保留指向文档自身的引用", async () => {
    const doc = await buildChatHtmlDocument(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/><path id="p" d="M0 0"/></defs><a xlink:href="https://attack.example/x"><text>A</text></a><a><set attributeName="href" to="https://attack.example/y"/><animate attributeName="xlink:href" values="https://attack.example/z"/><text>B</text></a><use href="#p"/><use xlink:href="#p"/><rect fill="url(#g)"/></svg><a href="#top">Top</a>',
      options
    )
    expect(doc).not.toContain("attack.example")
    expect(doc).not.toMatch(/<set|<animate/)
    expect(doc).toContain('<use href="#p">')
    expect(doc).toContain('<use xlink:href="#p">')
    expect(doc).toContain('<a href="#top">')
  })
})

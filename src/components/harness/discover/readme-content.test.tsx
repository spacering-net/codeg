import { fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@/lib/platform", () => ({ openUrl }))

import { ReadmeContent, readmeNodes } from "./readme-content"

/** The attributes the renderer itself puts on what it builds. */
const OWN_ATTRIBUTES = new Set(["class", "dir"])
const LINK_ATTRIBUTES = new Set(["class", "href", "target", "rel", "title"])

function renderFragment(fragment: string, omitHeading?: string[]) {
  const { container } = render(
    <ReadmeContent fragment={fragment} omitHeading={omitHeading} />
  )
  const root = container.firstElementChild as HTMLElement
  return { root, all: Array.from(root.querySelectorAll("*")) }
}

declare global {
  var __readmeSampleRan: boolean | undefined
}

beforeEach(() => {
  openUrl.mockClear()
  globalThis.__readmeSampleRan = undefined
})

describe("ReadmeContent — what a description may contain", () => {
  it("keeps paragraphs, headings, lists, code, tables, quotes and links", () => {
    const { root } = renderFragment(`
      <h1>Sample Toolkit</h1>
      <p>A <strong>toolkit</strong> with <em>examples</em> and <code>inline()</code>.</p>
      <h2>Usage</h2>
      <ul><li>First</li><li>Second <ol><li>Nested</li></ol></li></ul>
      <pre><code class="language-python">print("hello")
print("world")</code></pre>
      <blockquote><p>Quoted text.</p></blockquote>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>size</td><td>128</td></tr></tbody>
      </table>
      <hr>
      <p>See <a href="https://example.com/docs">the docs</a>.<br>Second line.</p>
    `)

    expect(root.querySelector("p strong")?.textContent).toBe("toolkit")
    expect(root.querySelector("p em")?.textContent).toBe("examples")
    expect(root.querySelector("p > code")?.textContent).toBe("inline()")
    expect(root.querySelectorAll("ul > li")).toHaveLength(2)
    expect(root.querySelector("ul ol li")?.textContent).toBe("Nested")
    expect(root.querySelector("pre code")?.textContent).toBe(
      'print("hello")\nprint("world")'
    )
    expect(root.querySelector("blockquote p")?.textContent).toBe("Quoted text.")
    expect(root.querySelectorAll("table thead th")).toHaveLength(2)
    expect(root.querySelector("table tbody td")?.textContent).toBe("size")
    expect(root.querySelector("hr")).not.toBeNull()
    expect(root.querySelector("br")).not.toBeNull()
    const link = root.querySelector("a")
    expect(link?.getAttribute("href")).toBe("https://example.com/docs")
    expect(link?.textContent).toBe("the docs")
  })

  it("starts its headings below the page's own, and never deeper than h6", () => {
    const { root } = renderFragment(
      "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>"
    )
    expect(
      Array.from(root.children).map((element) => element.tagName.toLowerCase())
    ).toEqual(["h4", "h5", "h6", "h6", "h6", "h6"])
    expect(root.querySelector("h1, h2, h3")).toBeNull()
  })

  it("leaves out an opening heading that repeats the item's title", () => {
    const fragment = "<h1>PDF Tools</h1><p>Body.</p>"
    expect(renderFragment(fragment, ["pdf tools"]).root.textContent).toBe(
      "Body."
    )
    expect(renderFragment(fragment, ["Other"]).root.textContent).toBe(
      "PDF ToolsBody."
    )
    // Only an opening heading, and only a first-level one.
    expect(
      renderFragment("<p>Intro.</p><h1>PDF Tools</h1>", ["PDF Tools"]).root
        .textContent
    ).toBe("Intro.PDF Tools")
    expect(
      renderFragment("<h2>PDF Tools</h2><p>Body.</p>", ["PDF Tools"]).root
        .textContent
    ).toBe("PDF ToolsBody.")
  })
})

describe("ReadmeContent — what a description may not do", () => {
  // Ordinary markup of the kinds that have no place in a description: a
  // script, handlers and styles written as attributes, embedded content, a
  // form, and links that do not lead to an https address.
  const SAMPLE = `
    <h2 id="intro" class="title" style="color: red" onclick="window.__readmeSampleRan = true">Intro</h2>
    <script>window.__readmeSampleRan = true</script>
    <style>p { display: none }</style>
    <p style="position: fixed" onmouseover="window.__readmeSampleRan = true" data-note="x" title="tip">
      Visible <span class="badge" style="font-weight: bold">text</span>.
    </p>
    <img src="https://example.com/picture.png" alt="A picture" onerror="window.__readmeSampleRan = true">
    <iframe src="https://example.com/frame"></iframe>
    <object data="https://example.com/thing"></object>
    <embed src="https://example.com/thing">
    <svg viewBox="0 0 1 1"><circle r="1" onload="window.__readmeSampleRan = true"></circle></svg>
    <form action="https://example.com/submit" method="post">
      <input name="field" value="typed">
      <textarea>written</textarea>
      <select><option>choice</option></select>
      <button type="submit">Send</button>
    </form>
    <video src="https://example.com/clip.mp4"></video>
    <audio src="https://example.com/clip.mp3"></audio>
    <link rel="stylesheet" href="https://example.com/sheet.css">
    <meta http-equiv="refresh" content="0; url=https://example.com/">
    <base href="https://example.com/">
    <ul>
      <li><a href="https://example.com/a" target="_self" rel="opener" class="x" onclick="window.__readmeSampleRan = true" style="color: blue" id="keep">Secure link</a></li>
      <li><a href="http://example.com/b">Plain http link</a></li>
      <li><a href="javascript:void(0)">Script link</a></li>
      <li><a href="mailto:someone@example.com">Mail link</a></li>
      <li><a href="/relative/path">Relative link</a></li>
      <li><a href="data:text/html,hello">Data link</a></li>
      <li><a>No address</a></li>
    </ul>
    <div class="note"><p>Inside a div.</p></div>
    <details><summary>More</summary><p>Folded text.</p></details>
  `

  it("builds nothing but allowlisted elements", () => {
    const { all } = renderFragment(SAMPLE)
    const tags = new Set(all.map((element) => element.tagName.toLowerCase()))
    expect([...tags].sort()).toEqual(["a", "h5", "li", "p", "ul"])
  })

  it("carries over no attribute but a link's address", () => {
    const { root, all } = renderFragment(SAMPLE)
    for (const element of [root, ...all]) {
      const allowed = element.tagName === "A" ? LINK_ATTRIBUTES : OWN_ATTRIBUTES
      for (const name of element.getAttributeNames()) {
        expect(allowed.has(name), `<${element.tagName}> ${name}`).toBe(true)
      }
    }
    // None of the fragment's own classes, ids, styles or handlers survive.
    expect(root.innerHTML).not.toMatch(/\bstyle=|\bon[a-z]+=|\bid=|data-note/)
    expect(root.querySelector(".title, .badge, .note, .x")).toBeNull()
  })

  it("drops scripts, styles, embedded content and forms together with what they hold", () => {
    const { root } = renderFragment(SAMPLE)
    const text = root.textContent ?? ""
    expect(text).not.toContain("__readmeSampleRan")
    expect(text).not.toContain("display: none")
    expect(text).not.toContain("Send")
    expect(text).not.toContain("written")
    expect(text).not.toContain("choice")
    expect(text).not.toContain("A picture")
    expect(
      root.querySelector(
        "script, style, img, iframe, object, embed, svg, form, input, textarea, select, button, video, audio, link, meta, base"
      )
    ).toBeNull()
  })

  it("keeps the text of elements it does not rebuild", () => {
    const { root } = renderFragment(SAMPLE)
    const text = root.textContent ?? ""
    expect(text).toContain("Visible text.")
    expect(text).toContain("Inside a div.")
    expect(text).toContain("MoreFolded text.")
  })

  it("runs nothing while parsing or rendering", () => {
    renderFragment(SAMPLE)
    expect(globalThis.__readmeSampleRan).toBeUndefined()
  })

  it("links only https addresses; every other link is plain text", () => {
    const { root } = renderFragment(SAMPLE)
    const links = Array.from(root.querySelectorAll("a"))
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/a",
    ])
    const text = root.textContent ?? ""
    for (const label of [
      "Plain http link",
      "Script link",
      "Mail link",
      "Relative link",
      "Data link",
      "No address",
    ]) {
      expect(text).toContain(label)
    }
    // The one link asks for a new window with no way back, whatever the
    // fragment asked for.
    expect(links[0].getAttribute("target")).toBe("_blank")
    expect(links[0].getAttribute("rel")).toBe("noreferrer")
  })

  it("opens a link in the system browser instead of following it", () => {
    const { root } = renderFragment(SAMPLE)
    const link = root.querySelector("a") as HTMLAnchorElement
    const followed = fireEvent.click(link)
    // `false`: the click's default — navigating this page — was prevented.
    expect(followed).toBe(false)
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a")
  })

  it("treats markup inside code as text", () => {
    const { root } = renderFragment(
      "<pre><code>&lt;script&gt;run()&lt;/script&gt; &lt;img src=x&gt;</code></pre>"
    )
    expect(root.querySelector("pre code")?.textContent).toBe(
      "<script>run()</script> <img src=x>"
    )
    expect(root.querySelector("script, img")).toBeNull()
  })

  it("copes with elements named like object properties", () => {
    const { root } = renderFragment(
      "<constructor>Kept</constructor><toString>too</toString><p>End</p>"
    )
    expect(root.textContent).toBe("KepttooEnd")
    expect(root.querySelectorAll("*")).toHaveLength(1)
  })

  it("stops rebuilding beyond a nesting depth, keeping the text", () => {
    const depth = 90
    const fragment = `${"<blockquote>".repeat(depth)}deep${"</blockquote>".repeat(depth)}`
    const { root } = renderFragment(fragment)
    expect(root.textContent).toBe("deep")
    expect(root.querySelectorAll("blockquote").length).toBeLessThanOrEqual(64)
  })

  it("renders nothing for an empty or text-free fragment", () => {
    expect(readmeNodes("")).toEqual([])
    expect(readmeNodes("  \n  ")).toEqual([])
    expect(readmeNodes("<script>1</script><style>x</style>")).toEqual([])
  })

  it("shows loose text as text", () => {
    const { root } = renderFragment("Just words & <b>bold</b> ones")
    expect(root.textContent).toBe("Just words & bold ones")
    expect(root.querySelector("strong")?.textContent).toBe("bold")
  })
})

import { describe, expect, it } from "vitest"
import {
  findHtmlFileMentions,
  isCompleteHtmlDocument,
  parseCodexVisualizeArgs,
  splitCodexVisualizeRefs,
} from "./codex-visualize"

const marker = (json: string) => `visualize${json}`

describe("parseCodexVisualizeArgs", () => {
  it("accepts a path and defaults the mode", () => {
    expect(parseCodexVisualizeArgs('{"path":"/tmp/a.html"}')).toEqual({
      path: "/tmp/a.html",
      mode: "normal",
    })
  })
  it("recognises wide mode and ignores unknown modes", () => {
    expect(
      parseCodexVisualizeArgs('{"path":"/tmp/a.html","mode":"wide"}')?.mode
    ).toBe("wide")
    expect(
      parseCodexVisualizeArgs('{"path":"/tmp/a.html","mode":"huge"}')?.mode
    ).toBe("normal")
  })
  it("rejects malformed payloads", () => {
    expect(parseCodexVisualizeArgs("not json")).toBeNull()
    expect(parseCodexVisualizeArgs('{"mode":"wide"}')).toBeNull()
    expect(parseCodexVisualizeArgs('{"path":"  "}')).toBeNull()
    expect(parseCodexVisualizeArgs('["/tmp/a.html"]')).toBeNull()
  })
})

describe("splitCodexVisualizeRefs", () => {
  it("returns plain text untouched", () => {
    const text = "Just prose, nothing to visualize{here}."
    expect(splitCodexVisualizeRefs(text)).toEqual([{ kind: "markdown", text }])
  })

  it("splits a reply around a marker on its own line", () => {
    const text = `Here is the chart.\n\n${marker('{"path":"/v/chart.html"}')}\n\nLet me know.`
    expect(splitCodexVisualizeRefs(text)).toEqual([
      { kind: "markdown", text: "Here is the chart.\n\n" },
      {
        kind: "visualize",
        ref: { path: "/v/chart.html", mode: "normal" },
        raw: marker('{"path":"/v/chart.html"}'),
      },
      { kind: "markdown", text: "\nLet me know." },
    ])
  })

  it("handles a marker as the whole reply and several markers", () => {
    const a = marker('{"path":"/v/a.html"}')
    const b = marker('{"path":"/v/b.html","mode":"wide"}')
    const segments = splitCodexVisualizeRefs(`${a}\n${b}`)
    expect(segments.map((s) => s.kind)).toEqual(["visualize", "visualize"])
    expect(segments[1]).toMatchObject({ ref: { mode: "wide" } })
  })

  it("keeps text written on the same line as the marker", () => {
    const segments = splitCodexVisualizeRefs(
      `See: ${marker('{"path":"/v/a.html"}')} (interactive)`
    )
    expect(segments).toEqual([
      { kind: "markdown", text: "See: " },
      expect.objectContaining({ kind: "visualize" }),
      { kind: "markdown", text: " (interactive)" },
    ])
  })

  it("leaves markers inside fenced code blocks alone", () => {
    const text = "Use:\n```text\n" + marker('{"path":"/v/a.html"}') + "\n```\n"
    expect(splitCodexVisualizeRefs(text)).toEqual([{ kind: "markdown", text }])
  })

  it("keeps a malformed marker visible as text", () => {
    const bad = marker("{oops")
    expect(splitCodexVisualizeRefs(`x ${bad} y`)).toEqual([
      { kind: "markdown", text: `x ${bad} y` },
    ])
  })

  it("ignores an unterminated marker while it is still streaming", () => {
    const partial = 'visualize{"path":"/v/a.ht'
    expect(splitCodexVisualizeRefs(partial)).toEqual([
      { kind: "markdown", text: partial },
    ])
  })
})

describe("isCompleteHtmlDocument", () => {
  it("tells fragments from documents", () => {
    expect(isCompleteHtmlDocument('<div class="card">hi</div>')).toBe(false)
    expect(isCompleteHtmlDocument("<!doctype html><html></html>")).toBe(true)
    expect(isCompleteHtmlDocument("<body>x</body>")).toBe(true)
  })
})

describe("Hermes ::preview directives", () => {
  it("renders a directive line in place like a visualize marker", () => {
    const segments = splitCodexVisualizeRefs(
      'Done.\n::preview{file="/h/out/report.html"}\nMore.'
    )
    expect(segments.map((s) => s.kind)).toEqual([
      "markdown",
      "visualize",
      "markdown",
    ])
    expect(segments[1]).toMatchObject({
      ref: { path: "/h/out/report.html", mode: "normal" },
    })
  })

  it("ignores a directive inside a fenced code block or mid-sentence", () => {
    const fenced = '```\n::preview{file="/h/a.html"}\n```'
    expect(splitCodexVisualizeRefs(fenced)).toEqual([
      { kind: "markdown", text: fenced },
    ])
    const inline = 'use ::preview{file="/h/a.html"} to show it'
    expect(splitCodexVisualizeRefs(inline)).toEqual([
      { kind: "markdown", text: inline },
    ])
  })
})

describe("findHtmlFileMentions", () => {
  it("collects local HTML files from every common mention style", () => {
    const text = [
      "**MEDIA:/Users/a/out/half-year.html**",
      "入口：`site/index.html`，见 [preview](preview.html#top)",
      "Saved to ~/reports/fitness.html.",
      "Open file:///tmp/My%20Report.html",
    ].join("\n")
    expect(findHtmlFileMentions(text, { limit: 10 })).toEqual([
      "/Users/a/out/half-year.html",
      "site/index.html",
      "preview.html",
      "~/reports/fitness.html",
      "/tmp/My Report.html",
    ])
  })

  it("never treats a web URL as a local file", () => {
    expect(
      findHtmlFileMentions(
        "See https://example.com/docs/a.html and [b](https://x.io/b.htm) or `http://y/c.html`"
      )
    ).toEqual([])
  })

  it("keeps relative paths only when named on purpose", () => {
    expect(findHtmlFileMentions("the index.html file")).toEqual([])
    expect(findHtmlFileMentions("the `index.html` file")).toEqual([
      "index.html",
    ])
  })

  it("skips fenced code, explicit references, exclusions and duplicates", () => {
    const text = [
      "```sh\nopen /tmp/in-code.html\n```",
      '::preview{file="/h/shown.html"}',
      "Also /h/shown.html and /h/other.html and `/h/other.html`",
    ].join("\n")
    expect(findHtmlFileMentions(text, { exclude: ["/h/shown.html"] })).toEqual([
      "/h/other.html",
    ])
  })

  it("caps the number of previews", () => {
    const text = ["/a/1.html", "/a/2.html", "/a/3.html"].join(" ")
    expect(findHtmlFileMentions(text, { limit: 2 })).toEqual([
      "/a/1.html",
      "/a/2.html",
    ])
  })
})

describe("unfenced visualize lines", () => {
  it("renders a bare visualize{…} line (e.g. from Claude Code) in place", () => {
    const text =
      '春节放 9 天。\n\nvisualize{"path":"/Users/u/viz/holiday.html"}\n\n说明文字'
    const segments = splitCodexVisualizeRefs(text)
    expect(segments.map((s) => s.kind)).toEqual([
      "markdown",
      "visualize",
      "markdown",
    ])
    expect(segments[1]).toMatchObject({
      ref: { path: "/Users/u/viz/holiday.html", mode: "normal" },
    })
    expect(findHtmlFileMentions(text)).toEqual([])
  })

  it("leaves prose and invalid payloads that mention the syntax alone", () => {
    for (const text of [
      'Write visualize{"path":"/a.html"} on its own line.',
      "visualize{not json}",
      'visualize{"mode":"wide"}',
    ]) {
      expect(
        splitCodexVisualizeRefs(text).every((s) => s.kind === "markdown")
      ).toBe(true)
    }
  })
})

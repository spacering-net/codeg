import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  getAgentColor,
  getAgentIconUrl,
  getAgentInitial,
  getAgentLabel,
  getCustomAgentDisplayVersion,
  isMonochromeSvgDataUrl,
  setCustomAgentDisplay,
  subscribeCustomAgentDisplay,
} from "@/lib/custom-agents"

beforeEach(() => {
  setCustomAgentDisplay([])
})

describe("setCustomAgentDisplay", () => {
  it("publishes names and icons, and drops agents that are gone", () => {
    setCustomAgentDisplay([
      {
        agentType: "custom:goose",
        name: "goose",
        iconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      },
      { agentType: "custom:qwen-code", name: "Qwen Code", iconUrl: null },
    ])
    expect(getAgentLabel("custom:goose")).toBe("goose")
    expect(getAgentIconUrl("custom:goose")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+"
    )
    // Registered but iconless — the caller falls back to the initial glyph.
    expect(getAgentIconUrl("custom:qwen-code")).toBeNull()
    expect(getAgentInitial("custom:qwen-code")).toBe("Q")

    // A later publish replaces the whole set rather than merging into it.
    setCustomAgentDisplay([{ agentType: "custom:qwen-code", name: "Qwen" }])
    expect(getAgentIconUrl("custom:goose")).toBeNull()
    expect(getAgentLabel("custom:goose")).toBe("Goose")
  })

  it("leaves built-ins alone", () => {
    setCustomAgentDisplay([
      { agentType: "custom:goose", name: "goose", iconUrl: "data:image/png;," },
    ])
    // Built-ins ship compiled-in marks; an icon URL would shadow them.
    expect(getAgentIconUrl("claude_code")).toBeNull()
    expect(getAgentLabel("claude_code")).not.toBe("goose")
    expect(getAgentColor("claude_code")).toBeTruthy()
  })

  it("only notifies subscribers when what they render actually changed", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCustomAgentDisplay(listener)
    const entries = [
      { agentType: "custom:goose", name: "goose", iconUrl: "data:image/png;," },
    ]

    setCustomAgentDisplay(entries)
    expect(listener).toHaveBeenCalledTimes(1)
    const version = getCustomAgentDisplayVersion()

    // The agent list is refetched on unrelated events; an identical payload
    // must not re-render every AgentIcon in the app.
    setCustomAgentDisplay(entries)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getCustomAgentDisplayVersion()).toBe(version)

    setCustomAgentDisplay([
      { agentType: "custom:goose", name: "goose", iconUrl: "data:image/png;x" },
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getCustomAgentDisplayVersion()).toBeGreaterThan(version)

    unsubscribe()
    setCustomAgentDisplay([])
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("isMonochromeSvgDataUrl", () => {
  const encode = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`
  /** A distinct monochrome SVG data URL of roughly `padding` source bytes. */
  const paddedIcon = (tag: string, padding: number) =>
    encode(`<svg><!--${tag}:${"x".repeat(padding)}--></svg>`)

  it("classifies currentColor marks as monochrome", () => {
    // The shape every ACP-registry icon has today.
    expect(
      isMonochromeSvgDataUrl(
        encode('<svg xmlns="x"><path fill="currentColor" d="M0 0h4"/></svg>')
      )
    ).toBe(true)
    // CSS spelling too.
    expect(
      isMonochromeSvgDataUrl(
        encode('<svg><path style="fill: currentColor" d="M0 0"/></svg>')
      )
    ).toBe(true)
  })

  it("treats plain black or unpainted silhouettes as monochrome", () => {
    expect(
      isMonochromeSvgDataUrl(
        encode('<svg viewBox="0 0 4 4"><path fill="#000000" d="M0 0"/></svg>')
      )
    ).toBe(true)
    // No paint at all defaults to black — same one-theme problem.
    expect(
      isMonochromeSvgDataUrl(encode('<svg><path d="M0 0h4v4z"/></svg>'))
    ).toBe(true)
    // `fill-rule` / `fill-opacity` must not read as paints.
    expect(
      isMonochromeSvgDataUrl(
        encode('<svg><path fill-rule="evenodd" fill-opacity="0.4"/></svg>')
      )
    ).toBe(true)
  })

  it("keeps colored marks, gradients and black-white plates as images", () => {
    expect(
      isMonochromeSvgDataUrl(
        encode('<svg><rect fill="#D97757" width="4" height="4"/></svg>')
      )
    ).toBe(false)
    expect(
      isMonochromeSvgDataUrl(
        encode(
          '<svg><linearGradient id="g"><stop stop-color="#EE4D5D"/></linearGradient><path fill="url(#g)"/></svg>'
        )
      )
    ).toBe(false)
    // A white plate under a black glyph would flatten into a solid block
    // under a mask, so the mix stays an <img>.
    expect(
      isMonochromeSvgDataUrl(
        encode(
          '<svg><rect fill="#fff" width="4" height="4"/><path fill="#000" d="M0 0"/></svg>'
        )
      )
    ).toBe(false)
    // Same for currentColor mixed with a real paint.
    expect(
      isMonochromeSvgDataUrl(
        encode(
          '<svg><rect fill="#1783FF"/><path fill="currentColor" d="M0 0"/></svg>'
        )
      )
    ).toBe(false)
  })

  it("only inspects base64 svg data urls, and never throws on garbage", () => {
    expect(isMonochromeSvgDataUrl(null)).toBe(false)
    expect(isMonochromeSvgDataUrl("https://e/i.svg")).toBe(false)
    expect(isMonochromeSvgDataUrl("data:image/png;base64,AAAA")).toBe(false)
    // Percent-encoded svg data urls are not produced by codeg's inliner or
    // the upload form; they stay on the <img> path.
    expect(isMonochromeSvgDataUrl("data:image/svg+xml;utf8,<svg/>")).toBe(false)
    expect(
      isMonochromeSvgDataUrl("data:image/svg+xml;base64,%%%not-base64%%%")
    ).toBe(false)
    // Valid base64 that is not svg markup.
    expect(
      isMonochromeSvgDataUrl(`data:image/svg+xml;base64,${btoa("hello")}`)
    ).toBe(false)
  })

  it("memoizes per url", () => {
    const url = encode('<svg><path fill="currentColor"/></svg>')
    const spy = vi.spyOn(globalThis, "atob")
    isMonochromeSvgDataUrl(url)
    const callsAfterFirst = spy.mock.calls.length
    isMonochromeSvgDataUrl(url)
    expect(spy.mock.calls.length).toBe(callsAfterFirst)
    spy.mockRestore()
  })

  it.each([
    { icons: 192, padding: 0, reason: "many small icons" },
    { icons: 12, padding: 160 * 1024, reason: "a few large icons" },
  ])("evicts old classifications after $reason", ({ icons, padding }) => {
    const icon = (index: number) =>
      paddedIcon(`evict:${padding}:${index}`, padding)
    const oldest = icon(0)
    expect(isMonochromeSvgDataUrl(oldest)).toBe(true)
    let newest = oldest
    for (let index = 1; index < icons; index++) {
      newest = icon(index)
      expect(isMonochromeSvgDataUrl(newest)).toBe(true)
    }

    const decode = vi.spyOn(globalThis, "atob")
    try {
      expect(isMonochromeSvgDataUrl(newest)).toBe(true)
      expect(decode).not.toHaveBeenCalled()
      expect(isMonochromeSvgDataUrl(oldest)).toBe(true)
      expect(decode).toHaveBeenCalledTimes(1)
    } finally {
      decode.mockRestore()
    }
  })

  it("keeps an icon that is still in use while newer ones age out", () => {
    const shown = paddedIcon("lru:shown", 0)
    isMonochromeSvgDataUrl(shown)
    const decode = vi.spyOn(globalThis, "atob")
    try {
      for (let index = 0; index < 300; index++) {
        isMonochromeSvgDataUrl(paddedIcon(`lru:${index}`, 0))
        expect(isMonochromeSvgDataUrl(shown)).toBe(true)
      }
      // Only the newcomers are decoded; the icon on screen never is again.
      expect(decode).toHaveBeenCalledTimes(300)
    } finally {
      decode.mockRestore()
    }
  })

  it("keeps several maximum-size icons cached side by side", () => {
    // 256 KiB is the upload/inline cap for an icon.
    const icons = [0, 1, 2, 3].map((index) =>
      paddedIcon(`max:${index}`, 256 * 1024 - 64)
    )
    for (const url of icons) isMonochromeSvgDataUrl(url)
    const decode = vi.spyOn(globalThis, "atob")
    try {
      // A list re-rendering every icon in turn must not re-decode any.
      for (let pass = 0; pass < 3; pass++) {
        for (const url of icons) expect(isMonochromeSvgDataUrl(url)).toBe(true)
      }
      expect(decode).not.toHaveBeenCalled()
    } finally {
      decode.mockRestore()
    }
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TokensResult } from "shiki"
import {
  SOURCE_VIEW_MAX_BYTES,
  SOURCE_VIEW_MAX_LINES,
} from "@/components/files/file-document-view"

const mocks = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  codeToTokens: vi.fn(),
  loadLanguage: vi.fn(),
  loadTheme: vi.fn(),
}))

vi.mock("shiki", () => ({
  createHighlighter: mocks.createHighlighter,
  bundledLanguagesInfo: [
    { id: "javascript", aliases: ["js"] },
    { id: "typescript", aliases: ["ts"] },
  ],
}))

let service: typeof import("./code-highlighter")
let engine: {
  codeToTokens: typeof mocks.codeToTokens
  loadLanguage: typeof mocks.loadLanguage
  loadTheme: typeof mocks.loadTheme
  getLoadedLanguages: () => string[]
  getLoadedThemes: () => string[]
}

function options(code: string, isIncomplete = false) {
  return {
    code,
    language: "javascript",
    themes: ["github-light", "github-dark"] as [string, string],
    isIncomplete,
  }
}

function highlight(request: ReturnType<typeof options>) {
  return new Promise<TokensResult>((resolve) => {
    const result = service.highlightCode(request, resolve)
    if (result) resolve(result)
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  const languages = new Set<string>()
  const themes = new Set<string>()
  mocks.loadLanguage.mockImplementation(async (name: string) => {
    languages.add(name)
  })
  mocks.loadTheme.mockImplementation(async (name: string) => {
    themes.add(name)
  })
  mocks.codeToTokens.mockImplementation((code: string) => ({
    fg: "#000",
    bg: "#fff",
    tokens: [[{ content: code, color: "#000", offset: 0 }]],
  }))
  engine = {
    codeToTokens: mocks.codeToTokens,
    loadLanguage: mocks.loadLanguage,
    loadTheme: mocks.loadTheme,
    getLoadedLanguages: () => [...languages],
    getLoadedThemes: () => [...themes],
  }
  mocks.createHighlighter.mockResolvedValue(engine)
  service = await import("./code-highlighter")
})

describe("shared code highlighting memory", () => {
  it("does not retain the prefixes of a growing streaming code block", async () => {
    for (let i = 1; i <= 128; i++) {
      await highlight(options("const row = true;\n".repeat(i), true))
    }
    expect(service.getCodeHighlightStats()).toEqual({
      entries: 0,
      estimatedBytes: 0,
      inFlight: 0,
      waiting: 0,
    })
    await highlight(options("const row = true;\n".repeat(128)))
    expect(service.getCodeHighlightStats().entries).toBe(1)
  })

  it("bounds completed results by bytes and keeps recently used entries", async () => {
    const first = options("first:" + "x".repeat(80_000))
    const hot = options("hot:" + "x".repeat(80_000))
    await highlight(first)
    await highlight(hot)
    for (let i = 0; i < 80; i++) {
      expect(service.getCachedHighlightedCode(hot)).not.toBeNull()
      await highlight(options(`${i}:` + "x".repeat(80_000)))
      expect(
        service.getCodeHighlightStats().estimatedBytes
      ).toBeLessThanOrEqual(service.HIGHLIGHT_LIMITS.cacheBytes)
    }
    expect(service.getCachedHighlightedCode(first)).toBeNull()
    expect(service.getCachedHighlightedCode(hot)).not.toBeNull()
  })

  it("also bounds the number of small completed snippets", async () => {
    for (let i = 0; i < 200; i++) await highlight(options(`const x = ${i}`))
    expect(service.getCodeHighlightStats().entries).toBe(
      service.HIGHLIGHT_LIMITS.cacheEntries
    )
    expect(service.getCachedHighlightedCode(options("const x = 0"))).toBeNull()
  })

  it("shares one engine, grammar load and computation between subscribers", async () => {
    const a = highlight(options("const x = 1"))
    const b = highlight(options("const x = 1"))
    expect(await a).toBe(await b)
    await highlight({ ...options("const x = 2"), language: "typescript" })
    expect(mocks.createHighlighter).toHaveBeenCalledTimes(1)
    expect(mocks.loadLanguage).toHaveBeenCalledTimes(2)
    expect(mocks.loadTheme).toHaveBeenCalledTimes(2)
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(2)
  })

  it("unsubscribes a code view that unmounts before the engine is ready", async () => {
    const listener = vi.fn()
    const unsubscribe = service.subscribeHighlightedCode(
      options("hello"),
      listener
    )
    unsubscribe()
    await highlight(options("hello"))
    expect(listener).not.toHaveBeenCalled()
    expect(service.getCodeHighlightStats().inFlight).toBe(0)
  })

  it("keeps equal-length snippets with matching ends distinct", async () => {
    const a = "x".repeat(101) + "A" + "y".repeat(101)
    const b = "x".repeat(101) + "B" + "y".repeat(101)
    const first = await highlight(options(a))
    const second = await highlight(options(b))
    expect(first.tokens[0][0].content).toBe(a)
    expect(second.tokens[0][0].content).toBe(b)
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(2)
  })

  it("preserves large code as plaintext without loading the engine", async () => {
    const code = "x".repeat(service.HIGHLIGHT_LIMITS.codeLength + 1)
    const result = await highlight(options(code))
    expect(result.tokens[0][0].content).toBe(code)
    expect(mocks.createHighlighter).not.toHaveBeenCalled()
    expect(service.getCodeHighlightStats().entries).toBe(0)
  })

  it("highlights every file the source view agrees to show", async () => {
    const line = "x".repeat(
      Math.floor(SOURCE_VIEW_MAX_BYTES / SOURCE_VIEW_MAX_LINES) - 1
    )
    const code = Array(SOURCE_VIEW_MAX_LINES).fill(line).join("\n")
    expect(code.length).toBeLessThanOrEqual(SOURCE_VIEW_MAX_BYTES)
    expect(code.length).toBeGreaterThan(SOURCE_VIEW_MAX_BYTES - 5_000)
    const result = await highlight(options(code))
    expect(result.fg).toBe("#000")
    expect(mocks.codeToTokens).toHaveBeenCalledOnce()
  })

  it("does not cache a token tree larger than the entire budget", async () => {
    mocks.codeToTokens.mockReturnValueOnce({
      tokens: [Array(100_000).fill({ content: "x", offset: 0 })],
    })
    await highlight(options("many tokens"))
    expect(service.getCodeHighlightStats().estimatedBytes).toBe(0)
  })

  it("bounds cold requests and still shows the content when saturated", async () => {
    let release!: (value: typeof engine) => void
    mocks.createHighlighter.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const requests = Array.from(
      { length: service.HIGHLIGHT_LIMITS.inFlight },
      (_, i) => highlight(options(`cold ${i}`))
    )
    const overflow = await highlight(options("still readable"))
    expect(overflow.tokens[0][0].content).toBe("still readable")
    expect(service.getCodeHighlightStats().inFlight).toBe(
      service.HIGHLIGHT_LIMITS.inFlight
    )
    release(engine)
    await Promise.all(requests)
    await vi.waitFor(() =>
      expect(service.getCodeHighlightStats().inFlight).toBe(0)
    )
  })

  it("normalizes aliases and uses plaintext for unknown languages", async () => {
    const plugin = await service.createCodePlugin()
    expect(plugin.supportsLanguage(" JS ")).toBe(true)
    expect(plugin.supportsLanguage("##")).toBe(false)
    await highlight({ ...options("let x = 1"), language: "js" })
    expect(mocks.codeToTokens).toHaveBeenLastCalledWith(
      "let x = 1",
      expect.objectContaining({ lang: "javascript" })
    )
    await highlight({ ...options("a log line"), language: "log" })
    expect(mocks.codeToTokens).toHaveBeenLastCalledWith(
      "a log line",
      expect.objectContaining({ lang: "text" })
    )
  })

  it("retries all mounted overflow subscribers within the concurrency bound", async () => {
    let release!: (value: typeof engine) => void
    mocks.createHighlighter.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const listeners = Array.from({ length: 80 }, () => vi.fn())
    const cleanups = listeners.map((listener, i) =>
      service.subscribeHighlightedCode(options(`mounted ${i}`), listener)
    )
    expect(service.getCodeHighlightStats().inFlight).toBe(16)
    expect(service.getCodeHighlightStats().waiting).toBe(64)
    // The waiting view remains readable while the engine is cold.
    expect(listeners[79].mock.lastCall?.[0].fg).toBe("inherit")
    cleanups[79]()
    await vi.waitFor(() =>
      expect(mocks.createHighlighter).toHaveBeenCalledOnce()
    )
    release(engine)
    await vi.waitFor(() => {
      expect(service.getCodeHighlightStats().waiting).toBe(0)
      expect(service.getCodeHighlightStats().inFlight).toBe(0)
    })
    for (const listener of listeners.slice(0, 79)) {
      expect(listener.mock.lastCall?.[0].fg).toBe("#000")
    }
    expect(listeners[79]).toHaveBeenCalledTimes(1)
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(79)
    cleanups.forEach((cleanup) => cleanup())
  })

  it("retries callback-only Streamdown highlights after saturation", async () => {
    let release!: (value: typeof engine) => void
    mocks.createHighlighter.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const callbacks = Array.from({ length: 24 }, () => vi.fn())
    for (const [index, callback] of callbacks.entries()) {
      const result = service.highlightCode(
        options(`streamdown ${index}`),
        callback
      )
      if (index < 16) expect(result).toBeNull()
      else expect(result?.fg).toBe("inherit")
    }
    expect(service.getCodeHighlightStats().inFlight).toBe(16)
    expect(service.getCodeHighlightStats().waiting).toBe(8)
    await vi.waitFor(() =>
      expect(mocks.createHighlighter).toHaveBeenCalledOnce()
    )
    release(engine)
    await vi.waitFor(() => {
      expect(service.getCodeHighlightStats().waiting).toBe(0)
      expect(service.getCodeHighlightStats().inFlight).toBe(0)
    })
    for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1)
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(24)
  })

  it("drops superseded streaming waiters and cancels queued Markdown on unmount", async () => {
    let release!: (value: typeof engine) => void
    mocks.createHighlighter.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const cold = Array.from({ length: 16 }, (_, i) =>
      highlight(options(`busy ${i}`))
    )
    const listener = vi.fn()
    let abort = new AbortController()
    for (let i = 0; i < 200; i++) {
      abort.abort()
      abort = new AbortController()
      service.highlightCode(
        { ...options(`prefix ${i}`, true), signal: abort.signal },
        listener
      )
      expect(service.getCodeHighlightStats().waiting).toBe(1)
    }
    abort.abort()
    expect(service.getCodeHighlightStats().waiting).toBe(0)
    await vi.waitFor(() =>
      expect(mocks.createHighlighter).toHaveBeenCalledOnce()
    )
    release(engine)
    await Promise.all(cold)
    expect(listener).not.toHaveBeenCalled()
    expect(mocks.codeToTokens).toHaveBeenCalledTimes(16)
  })

  it("bounds queued legacy callers that have no cancellation lifecycle", async () => {
    let release!: (value: typeof engine) => void
    mocks.createHighlighter.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const listener = vi.fn()
    for (let i = 0; i < 1000; i++) {
      service.highlightCode(options(`detached ${i}`), listener)
    }
    expect(service.getCodeHighlightStats().inFlight).toBe(16)
    expect(service.getCodeHighlightStats().waiting).toBe(
      service.HIGHLIGHT_LIMITS.detachedWaiters
    )
    await vi.waitFor(() =>
      expect(mocks.createHighlighter).toHaveBeenCalledOnce()
    )
    release(engine)
    await vi.waitFor(() => {
      expect(service.getCodeHighlightStats().waiting).toBe(0)
      expect(service.getCodeHighlightStats().inFlight).toBe(0)
    })
    expect(listener).toHaveBeenCalledTimes(
      16 + service.HIGHLIGHT_LIMITS.detachedWaiters
    )
  })
})

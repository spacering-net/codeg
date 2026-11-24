import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// Handles shared between the mock factories (hoisted above the imports) and the
// assertions, so we can drive/inspect the lazily-imported engines.
const mocks = vi.hoisted(() => ({
  highlight: vi.fn(() => null),
  supportsLanguage: vi.fn(() => true),
  createMathPlugin: vi.fn(() => ({
    name: "katex",
    type: "math",
    remarkPlugin: () => {},
    rehypePlugin: () => {},
  })),
}))

// `cjk` is the only eagerly-imported plugin — keep it a plain stub.
vi.mock("@streamdown/cjk", () => ({
  cjk: {
    name: "cjk",
    type: "cjk",
    remarkPluginsBefore: [],
    remarkPluginsAfter: [],
    remarkPlugins: [],
  },
}))
// The three heavy engines are dynamically imported by `ensure()`; vitest mocks
// intercept dynamic `import()` too, so these stand in for shiki/katex/mermaid.
vi.mock("@/lib/code-highlighter", () => ({
  createCodePlugin: async () => ({
    name: "shiki",
    type: "code-highlighter",
    highlight: mocks.highlight,
    supportsLanguage: mocks.supportsLanguage,
    getSupportedLanguages: () => [],
    getThemes: () => ["light", "dark"],
  }),
}))
vi.mock("@streamdown/math", () => ({
  createMathPlugin: mocks.createMathPlugin,
}))
vi.mock("@streamdown/mermaid", () => ({
  mermaid: {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getInstance: () => ({}),
  },
}))

import {
  __resetStreamdownPluginsForTest,
  detectHeavyPlugins,
  prefetchHeavyPlugins,
  useStreamdownPlugins,
} from "./streamdown-plugins"

afterEach(() => {
  __resetStreamdownPluginsForTest()
  mocks.highlight.mockClear()
  mocks.supportsLanguage.mockClear()
  mocks.createMathPlugin.mockClear()
  mocks.supportsLanguage.mockReturnValue(true)
})

describe("detectHeavyPlugins", () => {
  it("flags code for any fenced block, not for plain text", () => {
    expect(detectHeavyPlugins("```js\nx\n```").code).toBe(true)
    expect(detectHeavyPlugins("~~~\nx\n~~~").code).toBe(true)
    expect(detectHeavyPlugins("just prose, no fence").code).toBe(false)
  })

  it("flags code for indented (non-fenced) blocks, including in blockquotes", () => {
    // CommonMark renders these as <pre><code>; the old eager plugin covered
    // them, so the detector must not miss them (superset invariant).
    expect(detectHeavyPlugins("text\n\n    const x = 1").code).toBe(true)
    expect(detectHeavyPlugins("text\n\n\tconst x = 1").code).toBe(true)
    // Indented code inside a blockquote — the 4 spaces follow the `>` marker(s),
    // so a line-start-anchored check would miss it; the run-anywhere superset
    // catches it.
    expect(detectHeavyPlugins(">     const x = 1").code).toBe(true)
    expect(detectHeavyPlugins("   >     const x = 1").code).toBe(true)
    expect(detectHeavyPlugins("prose with no indent or tab").code).toBe(false)
  })

  it("flags math for $$ / \\[ / \\( / math fences, not a lone $", () => {
    expect(detectHeavyPlugins("price $5").math).toBe(false)
    expect(detectHeavyPlugins("Set $HOME and $1").math).toBe(false)
    expect(detectHeavyPlugins("energy $$E=mc^2$$").math).toBe(true)
    expect(detectHeavyPlugins("令 $T$ 和 $AV$ 满足 $A - T$。").math).toBe(true)
    expect(detectHeavyPlugins("\\[ x^2 \\]").math).toBe(true)
    expect(detectHeavyPlugins("\\( y \\)").math).toBe(true)
    expect(detectHeavyPlugins("```math\nx\n```").math).toBe(true)
    expect(detectHeavyPlugins("~~~math\nx\n~~~").math).toBe(true)
    expect(detectHeavyPlugins("no dollar, no math").math).toBe(false)
  })

  it("flags mermaid only for a mermaid fence, not the bare word", () => {
    expect(detectHeavyPlugins("```mermaid\ngraph TD\n```").mermaid).toBe(true)
    expect(detectHeavyPlugins("~~~mermaid\n~~~").mermaid).toBe(true)
    expect(detectHeavyPlugins("``` mermaid\n```").mermaid).toBe(true)
    expect(detectHeavyPlugins("```js\nconst x=1\n```").mermaid).toBe(false)
    expect(detectHeavyPlugins("the word mermaid in prose").mermaid).toBe(false)
  })
})

describe("prefetchHeavyPlugins", () => {
  it("warms the code engine so a later consumer gets it on first render (no flash)", async () => {
    prefetchHeavyPlugins(["code"])
    // Flush the (mocked) dynamic import so the engine is cached before any
    // consumer renders.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // A code message mounting AFTER the warm-up gets the engine SYNCHRONOUSLY on
    // its first render (no waitFor) — only possible if the prefetch loaded it off
    // the render path.
    const { result } = renderHook(() => useStreamdownPlugins("```\nx\n```"))
    expect(result.current.code).toBeDefined()
  })

  it("warms only the requested engine, not the others", async () => {
    prefetchHeavyPlugins(["code"])
    await act(async () => {
      await Promise.resolve()
    })
    // math was never requested ⇒ its engine factory is never invoked.
    expect(mocks.createMathPlugin).not.toHaveBeenCalled()

    const math = renderHook(() => useStreamdownPlugins("energy $$E=mc^2$$"))
    await waitFor(() => expect(math.result.current.math).toBeDefined())
    const code = renderHook(() => useStreamdownPlugins("```\nx\n```"))
    // code was prefetched ⇒ available immediately, no waitFor needed.
    expect(code.result.current.code).toBeDefined()
  })

  it("is idempotent — repeated calls don't re-load", async () => {
    prefetchHeavyPlugins(["code"])
    prefetchHeavyPlugins(["code"])
    const { result } = renderHook(() => useStreamdownPlugins("```\nx\n```"))
    await waitFor(() => expect(result.current.code).toBeDefined())
    // Serving a second consumer stays synchronous (single cached engine).
    const second = renderHook(() => useStreamdownPlugins("```\ny\n```"))
    expect(second.result.current.code).toBeDefined()
  })
})

describe("useStreamdownPlugins", () => {
  it("returns cjk-only and loads no engine for plain text", async () => {
    const { result } = renderHook(() => useStreamdownPlugins("just text"))

    expect(result.current.cjk).toBeDefined()
    expect(result.current.code).toBeUndefined()
    expect(result.current.math).toBeUndefined()
    expect(result.current.mermaid).toBeUndefined()

    await act(async () => {
      await Promise.resolve()
    })

    // No trigger syntax ⇒ the dynamic engine imports never ran.
    expect(mocks.createMathPlugin).not.toHaveBeenCalled()
    expect(result.current.code).toBeUndefined()
  })

  it("lazily loads the code engine when a fence appears and splices it in", async () => {
    const { result } = renderHook(() => useStreamdownPlugins("```js\nx\n```"))

    // First render: needed but not yet resolved ⇒ fallback (cjk only).
    expect(result.current.code).toBeUndefined()
    expect(result.current.cjk).toBeDefined()

    // Once the lazy import resolves, the hook re-renders with the engine.
    await waitFor(() => expect(result.current.code).toBeDefined())
    expect(result.current.code).toMatchObject({ type: "code-highlighter" })
  })

  it("loads math only, not code/mermaid, for a `$$`-only document", async () => {
    const { result } = renderHook(() =>
      useStreamdownPlugins("energy $$E=mc^2$$")
    )

    await waitFor(() => expect(result.current.math).toBeDefined())
    expect(result.current.code).toBeUndefined()
    expect(result.current.mermaid).toBeUndefined()
    expect(mocks.createMathPlugin).toHaveBeenCalledWith({
      singleDollarTextMath: false,
    })
  })

  it("wraps the code engine so an unsupported language falls back to `text`", async () => {
    const { result } = renderHook(() => useStreamdownPlugins("```\nx\n```"))
    await waitFor(() => expect(result.current.code).toBeDefined())

    mocks.supportsLanguage.mockReturnValue(false)
    result.current.code?.highlight(
      {
        code: "x",
        language: "##" as never,
        themes: ["light", "dark"] as never,
      },
      undefined
    )

    expect(mocks.highlight).toHaveBeenCalledWith(
      expect.objectContaining({ language: "text" }),
      undefined
    )
  })

  it("serves an already-loaded engine synchronously to a later consumer (no flash)", async () => {
    const first = renderHook(() => useStreamdownPlugins("```\ny\n```"))
    await waitFor(() => expect(first.result.current.code).toBeDefined())

    // A message mounting AFTER the engine is cached gets it on first render.
    const second = renderHook(() => useStreamdownPlugins("```\nz\n```"))
    expect(second.result.current.code).toBeDefined()
  })

  it("lazily loads code for a 4-space indented block with no fence", async () => {
    const { result } = renderHook(() =>
      useStreamdownPlugins("paragraph\n\n    const x = 1\n")
    )
    await waitFor(() => expect(result.current.code).toBeDefined())
  })

  it("lazily loads code for indented code inside a blockquote", async () => {
    const { result } = renderHook(() =>
      useStreamdownPlugins(">     const x = 1\n")
    )
    await waitFor(() => expect(result.current.code).toBeDefined())
  })

  it("keeps the plugins ref stable as streaming text grows (needs unchanged)", async () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamdownPlugins(text),
      { initialProps: { text: "```js\nconst a = 1\n```" } }
    )
    await waitFor(() => expect(result.current.code).toBeDefined())
    const ref = result.current

    // A streaming batch appends more code; the needs booleans are unchanged, so
    // the consumer must receive the SAME plugins object (no per-token churn).
    rerender({ text: "```js\nconst a = 1\nconst b = 2\n```" })
    expect(result.current).toBe(ref)
  })

  it("returns the same cjk-only ref across plain-text batches", () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamdownPlugins(text),
      { initialProps: { text: "hello" } }
    )
    const ref = result.current
    rerender({ text: "hello world" })
    expect(result.current).toBe(ref)
  })
})

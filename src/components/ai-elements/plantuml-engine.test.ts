import { beforeEach, describe, expect, it, vi } from "vitest"

type RenderToString = (
  lines: string[],
  onSuccess: (svg: string) => void,
  onError: (message: string) => void,
  options?: { dark?: boolean }
) => void

const mocks = vi.hoisted(() => ({
  renderToString: vi.fn<RenderToString>(),
  vizInstance: () => Promise.resolve({}),
  /** Module evaluations, in order — Graphviz has to be there before the engine. */
  evaluated: [] as string[],
  /** Whether the `Viz` global was set by the time the engine was evaluated. */
  vizWhenEngineLoaded: undefined as unknown,
  /** How many more times the Graphviz chunk fails to load. */
  vizFailures: 0,
}))

// The real engine needs a canvas to measure text, which jsdom does not have;
// what matters here is the order it is loaded in and how it is called.
// Registered per test (`doMock`, after `resetModules`) so every test sees each
// module evaluated afresh — a hoisted `vi.mock` factory runs once per file.
function mockPackage() {
  vi.doMock("@viz-js/viz", () => {
    if (mocks.vizFailures > 0) {
      mocks.vizFailures -= 1
      throw new Error("chunk load failed")
    }
    mocks.evaluated.push("@viz-js/viz")
    return { instance: mocks.vizInstance }
  })
  vi.doMock("@plantuml/core", () => {
    mocks.evaluated.push("plantuml.js")
    mocks.vizWhenEngineLoaded = (globalThis as { Viz?: unknown }).Viz
    return { renderToString: mocks.renderToString }
  })
  vi.doMock("@plantuml/core/themes.js", () => {
    mocks.evaluated.push("themes.js")
    return {}
  })
  vi.doMock("@plantuml/core/emoji.js", () => ({}))
  vi.doMock("@plantuml/core/openiconic.js", () => ({}))
}

/** A fresh copy of the module: no engine loaded yet, nothing queued. */
async function freshEngine() {
  vi.resetModules()
  mockPackage()
  return import("./plantuml-engine")
}

/** Leaves every render pending; returns the callbacks of each call made. */
function holdRenders() {
  const calls: { ok: (svg: string) => void; fail: (m: string) => void }[] = []
  mocks.renderToString.mockImplementation((_lines, ok, fail) => {
    calls.push({ ok, fail })
  })
  return calls
}

function linesOfCall(index: number): string[] {
  return mocks.renderToString.mock.calls[index][0]
}

/** Let queued promise callbacks run without advancing any timers. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  mocks.renderToString.mockReset()
  mocks.evaluated.length = 0
  mocks.vizWhenEngineLoaded = undefined
  mocks.vizFailures = 0
  const host = globalThis as { PLANTUML_STDLIB_LOADER?: unknown; Viz?: unknown }
  delete host.PLANTUML_STDLIB_LOADER
  delete host.Viz
})

describe("withDiagramMarkers", () => {
  it("wraps a fence without its own @start line as a UML diagram", async () => {
    const { withDiagramMarkers } = await freshEngine()
    expect(withDiagramMarkers("Alice -> Bob: hi")).toBe(
      "@startuml\nAlice -> Bob: hi\n@enduml"
    )
  })

  it("leaves a source with its own markers alone, whatever the diagram type", async () => {
    const { withDiagramMarkers } = await freshEngine()
    for (const source of [
      "@startuml\nA -> B\n@enduml",
      "@startmindmap\n* root\n@endmindmap",
      "\n  @startuml\nA -> B\n@enduml",
    ]) {
      expect(withDiagramMarkers(source)).toBe(source)
    }
  })
})

describe("renderPlantUml", () => {
  it("hands Graphviz to the engine as its Viz global, then renders the fence as lines", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.renderToString.mockImplementation((_lines, ok) => ok("<svg/>"))

    await expect(
      renderPlantUml("Alice -> Bob: hi", { dark: false })
    ).resolves.toBe("<svg/>")

    expect(mocks.evaluated).toEqual(["@viz-js/viz", "plantuml.js"])
    // The engine checks for `Viz.instance` whenever it lays a diagram out; it
    // has to be there from the start, not only once something sets it later.
    expect(mocks.vizWhenEngineLoaded).toMatchObject({
      instance: mocks.vizInstance,
    })
    expect(mocks.renderToString).toHaveBeenCalledWith(
      ["@startuml", "Alice -> Bob: hi", "@enduml"],
      expect.any(Function),
      expect.any(Function),
      { dark: false }
    )
  })

  it("passes dark mode through", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.renderToString.mockImplementation((_lines, ok) => ok("<svg/>"))

    await renderPlantUml("@startuml\nA -> B\n@enduml", { dark: true })

    expect(mocks.renderToString.mock.calls[0][3]).toEqual({ dark: true })
  })

  it("loads the engine once for every diagram", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.renderToString.mockImplementation((_lines, ok) => ok("<svg/>"))

    await Promise.all([
      renderPlantUml("A -> B", { dark: false }),
      renderPlantUml("C -> D", { dark: false }),
    ])

    expect(mocks.evaluated).toEqual(["@viz-js/viz", "plantuml.js"])
  })

  it("starts the next diagram only once the engine has answered the last one", async () => {
    const { renderPlantUml } = await freshEngine()
    const calls = holdRenders()

    const first = renderPlantUml("A -> B", { dark: false })
    const second = renderPlantUml("C -> D", { dark: false })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await settle()
    // Overlapping calls clobber the engine's in-progress state, and one of
    // the two never answers.
    expect(calls).toHaveLength(1)

    calls[0].ok("<svg>first</svg>")
    await expect(first).resolves.toBe("<svg>first</svg>")
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(linesOfCall(1)).toEqual(["@startuml", "C -> D", "@enduml"])

    calls[1].ok("<svg>second</svg>")
    await expect(second).resolves.toBe("<svg>second</svg>")
  })

  it("skips a diagram whose caller gave up before its turn came", async () => {
    const { renderPlantUml } = await freshEngine()
    const calls = holdRenders()
    const stale = new AbortController()

    void renderPlantUml("A -> B", { dark: false })
    const skipped = renderPlantUml("A -> B: wor", {
      dark: false,
      signal: stale.signal,
    })
    const latest = renderPlantUml("A -> B: world", { dark: false })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    stale.abort()
    calls[0].ok("<svg/>")

    await expect(skipped).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(linesOfCall(1)).toContain("A -> B: world")
    calls[1].ok("<svg>latest</svg>")
    await expect(latest).resolves.toBe("<svg>latest</svg>")
    expect(mocks.renderToString).toHaveBeenCalledTimes(2)
  })

  it("rejects with the engine's own message and moves on to the next diagram", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.renderToString
      .mockImplementationOnce((_lines, _ok, fail) =>
        fail("java.lang.RuntimeException: Failed to load emoji.js")
      )
      .mockImplementationOnce((_lines, ok) => ok("<svg/>"))

    await expect(renderPlantUml("A -> B", { dark: false })).rejects.toThrow(
      "Failed to load emoji.js"
    )
    await expect(renderPlantUml("A -> B", { dark: false })).resolves.toBe(
      "<svg/>"
    )
  })

  it("does not stall the queue when the engine throws instead of answering", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.renderToString
      .mockImplementationOnce(() => {
        throw new Error("engine crashed")
      })
      .mockImplementationOnce((_lines, ok) => ok("<svg/>"))

    await expect(renderPlantUml("A -> B", { dark: false })).rejects.toThrow(
      "engine crashed"
    )
    await expect(renderPlantUml("A -> B", { dark: false })).resolves.toBe(
      "<svg/>"
    )
  })

  it("tries the engine again after it failed to load", async () => {
    const { renderPlantUml } = await freshEngine()
    mocks.vizFailures = 1
    mocks.renderToString.mockImplementation((_lines, ok) => ok("<svg/>"))

    // Vitest wraps a throwing mock factory in its own message.
    await expect(renderPlantUml("A -> B", { dark: false })).rejects.toThrow()
    await expect(renderPlantUml("A -> B", { dark: false })).resolves.toBe(
      "<svg/>"
    )
  })
})

describe("support files", () => {
  it("installs the loader the engine asks for themes, emoji and icons", async () => {
    const { loadSupportFile, renderPlantUml } = await freshEngine()
    mocks.renderToString.mockImplementation((_lines, ok) => ok("<svg/>"))

    await renderPlantUml("A -> B", { dark: false })

    expect(
      (globalThis as { PLANTUML_STDLIB_LOADER?: unknown })
        .PLANTUML_STDLIB_LOADER
    ).toBe(loadSupportFile)
  })

  it("hands over the package's own copy of a support file", async () => {
    const { loadSupportFile } = await freshEngine()
    const ok = vi.fn()
    const fail = vi.fn()

    expect(loadSupportFile("themes.js", ok, fail)).toBe(true)

    await vi.waitFor(() => expect(ok).toHaveBeenCalledTimes(1))
    expect(mocks.evaluated).toContain("themes.js")
    expect(fail).not.toHaveBeenCalled()
  })

  it("fails a standard-library bundle the package does not ship, without fetching anything", async () => {
    const { loadSupportFile } = await freshEngine()
    const ok = vi.fn()
    const fail = vi.fn()

    // Returning true keeps the engine from appending a <script> of its own.
    expect(loadSupportFile("c4.min.js", ok, fail)).toBe(true)

    expect(fail).toHaveBeenCalledWith("c4.min.js is not available")
    expect(ok).not.toHaveBeenCalled()
    expect(document.querySelector("script")).toBeNull()
  })
})

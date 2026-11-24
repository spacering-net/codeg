import { useState, type ReactElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { mermaidComponents } from "./mermaid-block"

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  getMermaid: vi.fn(),
  renderPlantUml: vi.fn(),
  copyTextToClipboard: vi.fn(async () => true),
  saveDiagram: vi.fn(async () => "saved" as const),
  /** Flips the mocked appearance context — see the mock factory below. */
  setDarkMode: (() => {}) as (on: boolean) => void,
}))

// Stand in for the lazily-imported `@streamdown/mermaid` singleton. The real
// engine needs a layout-capable DOM; what matters here is that the block calls
// it with the right config and renders whatever SVG comes back.
vi.mock("./streamdown-plugins", () => ({
  useMermaidEngine: () => ({
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid: mocks.getMermaid,
  }),
}))

// `useAppearance` is a context in the app, so a theme change re-renders the
// block straight through the `memo` around it. Backing the mock with real state
// reproduces that: `setDarkMode` updates from inside the component.
vi.mock("@/hooks/use-appearance", () => ({
  useAppearance: () => {
    const [isDarkMode, setIsDarkMode] = useState(false)
    mocks.setDarkMode = setIsDarkMode
    return { isDarkMode }
  },
}))

vi.mock("@/lib/mermaid-export", () => ({ saveDiagram: mocks.saveDiagram }))

// Stand in for PlantUML's browser engine, which needs a canvas to measure text
// (jsdom has none). The block's job is to ask it with the right source and
// palette, and to show whatever it draws.
vi.mock("./plantuml-engine", () => ({ renderPlantUml: mocks.renderPlantUml }))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: mocks.copyTextToClipboard,
}))

const SOURCE = "graph TD;\n  A-->B;"
const SVG =
  '<svg viewBox="0 0 400 300" style="max-width: 400px;" width="100%">' +
  '<g data-testid="diagram-body"></g></svg>'

const Pre = mermaidComponents.pre as React.ComponentType<{
  children?: React.ReactNode
}>

function mermaidFence(source = SOURCE): ReactElement {
  return (
    <Pre>
      <code className="language-mermaid">{source}</code>
    </Pre>
  )
}

const PLANTUML_SOURCE = "@startuml\nAlice -> Bob: hello\n@enduml"
const PLANTUML_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 106 130" ' +
  'width="106" height="130"><g data-testid="plantuml-body"></g></svg>'

function plantUmlFence(source = PLANTUML_SOURCE, language = "plantuml") {
  return (
    <Pre>
      <code className={`language-${language}`}>{source}</code>
    </Pre>
  )
}

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.render.mockResolvedValue({ svg: SVG })
  mocks.getMermaid.mockImplementation(() => ({
    initialize: vi.fn(),
    render: mocks.render,
  }))
  mocks.renderPlantUml.mockResolvedValue(PLANTUML_SVG)
})

describe("mermaidComponents.pre", () => {
  it("renders a ```mermaid fence as a diagram block", async () => {
    const { container } = renderWithIntl(mermaidFence())

    await waitFor(() =>
      expect(
        container.querySelector('[data-codeg="mermaid-block"]')
      ).not.toBeNull()
    )
    expect(mocks.render).toHaveBeenCalledWith(expect.any(String), SOURCE)
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("strips Mermaid's inline max-width, which would cap every zoom", async () => {
    const { container } = renderWithIntl(mermaidFence())

    const svg = await waitFor(() => {
      const el = container.querySelector("svg")
      expect(el).not.toBeNull()
      return el as SVGElement
    })
    expect(svg.getAttribute("style") ?? "").not.toMatch(/max-width/i)
  })

  it("passes every other fence through with Streamdown's data-block flag", () => {
    const { container } = renderWithIntl(
      <Pre>
        <code className="language-ts">const a = 1</code>
      </Pre>
    )

    const code = container.querySelector("code")
    expect(code?.getAttribute("data-block")).toBe("true")
    expect(container.querySelector('[data-codeg="mermaid-block"]')).toBeNull()
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it("renders non-element children untouched", () => {
    const { container } = renderWithIntl(<Pre>plain text</Pre>)
    expect(container.textContent).toBe("plain text")
  })
})

describe("MermaidBlock theming", () => {
  it("renders with Mermaid's light theme by default", async () => {
    renderWithIntl(mermaidFence())
    await waitFor(() =>
      expect(mocks.getMermaid).toHaveBeenCalledWith({ theme: "default" })
    )
  })

  it("re-renders the diagram with the dark theme when the app turns dark", async () => {
    renderWithIntl(mermaidFence())
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1))

    act(() => mocks.setDarkMode(true))

    await waitFor(() =>
      expect(mocks.getMermaid).toHaveBeenLastCalledWith({ theme: "dark" })
    )
    expect(mocks.render).toHaveBeenCalledTimes(2)
  })
})

describe("MermaidBlock toolbar", () => {
  it("offers download, copy and fullscreen once the diagram is up", async () => {
    renderWithIntl(mermaidFence())

    expect(await screen.findByLabelText("Download")).toBeTruthy()
    expect(screen.getByLabelText("Copy source")).toBeTruthy()
    expect(screen.getByLabelText("View fullscreen")).toBeTruthy()
    expect(screen.getByLabelText("Zoom in")).toBeTruthy()
    expect(screen.getByLabelText("Reset view")).toBeTruthy()
  })

  it("copies the fence source, not the rendered SVG", async () => {
    renderWithIntl(mermaidFence())

    fireEvent.click(await screen.findByLabelText("Copy source"))

    await waitFor(() =>
      expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(SOURCE)
    )
    expect(await screen.findByLabelText("Copied")).toBeTruthy()
  })

  it("opens the fullscreen dialog", async () => {
    renderWithIntl(mermaidFence())

    fireEvent.click(await screen.findByLabelText("View fullscreen"))

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Diagram")
    expect(dialog.querySelector("svg")).not.toBeNull()
    expect(screen.getByLabelText("Close")).toBeTruthy()
  })
})

describe("MermaidBlock errors", () => {
  it("shows the failure with the source, and retries on demand", async () => {
    mocks.render.mockRejectedValueOnce(new Error("Parse error on line 2"))
    const { container } = renderWithIntl(mermaidFence())

    expect(
      await screen.findByText(/Mermaid error: Parse error on line 2/)
    ).toBeTruthy()
    expect(screen.getByText("Show source")).toBeTruthy()
    // Verbatim, not via getByText: its string matcher compares against
    // whitespace-collapsed node text, which would pass on a mangled fence.
    expect(container.querySelector("pre")?.textContent).toBe(SOURCE)

    fireEvent.click(screen.getByText("Retry"))

    await waitFor(() =>
      expect(
        document.querySelector('[data-codeg="mermaid-block"]')
      ).not.toBeNull()
    )
  })

  it("keeps the last good drawing when a re-render fails", async () => {
    const { container } = renderWithIntl(mermaidFence())
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull())

    mocks.render.mockRejectedValueOnce(new Error("boom"))
    act(() => mocks.setDarkMode(true))

    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2))
    // Stale colours beat an empty card.
    expect(container.querySelector("svg")).not.toBeNull()
    expect(screen.queryByText("Retry")).toBeNull()
  })
})

describe("PlantUmlBlock", () => {
  it("renders a ```plantuml fence as a diagram block", async () => {
    const { container } = renderWithIntl(plantUmlFence())

    await waitFor(() =>
      expect(
        container.querySelector('[data-codeg="plantuml-block"]')
      ).not.toBeNull()
    )
    expect(mocks.renderPlantUml).toHaveBeenCalledWith(PLANTUML_SOURCE, {
      dark: false,
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByTestId("plantuml-body")).toBeTruthy()
    // Neither Mermaid nor a plain code block got the fence.
    expect(mocks.render).not.toHaveBeenCalled()
    expect(container.querySelector("code")).toBeNull()
  })

  it("claims ```puml fences too", async () => {
    const { container } = renderWithIntl(
      plantUmlFence("Alice -> Bob: hi", "puml")
    )

    await waitFor(() =>
      expect(
        container.querySelector('[data-codeg="plantuml-block"]')
      ).not.toBeNull()
    )
    expect(mocks.renderPlantUml).toHaveBeenCalledWith(
      "Alice -> Bob: hi",
      expect.objectContaining({ dark: false })
    )
  })

  it("re-renders with PlantUML's dark palette when the app turns dark", async () => {
    renderWithIntl(plantUmlFence())
    await waitFor(() => expect(mocks.renderPlantUml).toHaveBeenCalledTimes(1))

    act(() => mocks.setDarkMode(true))

    await waitFor(() =>
      expect(mocks.renderPlantUml).toHaveBeenLastCalledWith(
        PLANTUML_SOURCE,
        expect.objectContaining({ dark: true })
      )
    )
    expect(mocks.renderPlantUml).toHaveBeenCalledTimes(2)
  })

  it("gives up on a render whose source has moved on", async () => {
    mocks.renderPlantUml.mockReturnValueOnce(new Promise(() => {}))
    const { rerender } = renderWithIntl(plantUmlFence("Alice -> Bo"))
    await waitFor(() => expect(mocks.renderPlantUml).toHaveBeenCalledTimes(1))
    const stale = mocks.renderPlantUml.mock.calls[0][1].signal as AbortSignal

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {plantUmlFence("Alice -> Bob")}
      </NextIntlClientProvider>
    )

    await waitFor(() => expect(mocks.renderPlantUml).toHaveBeenCalledTimes(2))
    expect(stale.aborted).toBe(true)
    expect(await screen.findByTestId("plantuml-body")).toBeTruthy()
  })

  it("offers the source as a .puml file", async () => {
    renderWithIntl(plantUmlFence())

    fireEvent.keyDown(await screen.findByLabelText("Download"), {
      key: "Enter",
    })
    fireEvent.click(await screen.findByText("Download source (.puml)"))

    await waitFor(() =>
      expect(mocks.saveDiagram).toHaveBeenCalledWith({
        format: "puml",
        svg: PLANTUML_SVG,
        source: PLANTUML_SOURCE,
      })
    )
    expect(screen.queryByText("Download source (.mmd)")).toBeNull()
  })

  it("shows the engine's failure as a PlantUML error, and retries on demand", async () => {
    mocks.renderPlantUml.mockRejectedValueOnce(
      new Error("Failed to load emoji.js")
    )
    renderWithIntl(plantUmlFence())

    expect(
      await screen.findByText(/PlantUML error: Failed to load emoji.js/)
    ).toBeTruthy()

    fireEvent.click(screen.getByText("Retry"))

    expect(await screen.findByTestId("plantuml-body")).toBeTruthy()
  })
})

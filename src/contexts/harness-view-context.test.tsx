import { StrictMode, useState, type ReactNode } from "react"
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { defineHarnessSlot } from "@/lib/harness-slots"
import type { HarnessTargetFor } from "@/lib/harness-sections"
import {
  HarnessViewProvider,
  useConsumeHarnessTarget,
  useHarnessSlot,
  useHarnessTarget,
  useHarnessView,
  useOptionalHarnessView,
} from "./harness-view-context"

const SECTION_KEY = "workspace:harness-section"

function providerWith(discoverEnabled?: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HarnessViewProvider discoverEnabled={discoverEnabled}>
        {children}
      </HarnessViewProvider>
    )
  }
}

function renderView(discoverEnabled?: boolean) {
  return renderHook(() => useHarnessView(), {
    wrapper: providerWith(discoverEnabled),
  })
}

beforeEach(() => localStorage.clear())

describe("HarnessViewProvider — current section", () => {
  it("opens on Discover the first time, with all five sections", () => {
    const { result } = renderView()

    expect(result.current.section).toBe("discover")
    expect(result.current.sections).toEqual([
      "discover",
      "mcp",
      "skills",
      "plugins",
      "packs",
    ])
    expect(result.current.discoverEnabled).toBe(true)
    // Showing the default is not a choice to remember.
    expect(localStorage.getItem(SECTION_KEY)).toBeNull()
  })

  it("remembers the section the user switched to", () => {
    const first = renderView()
    act(() => first.result.current.setSection("skills"))

    expect(first.result.current.section).toBe("skills")
    expect(localStorage.getItem(SECTION_KEY)).toBe("skills")

    // A new provider is a new window, or the next launch.
    first.unmount()
    const second = renderView()
    expect(second.result.current.section).toBe("skills")
  })

  it("has no Discover, and starts on MCP, with the catalog switched off", () => {
    const { result } = renderView(false)

    expect(result.current.discoverEnabled).toBe(false)
    expect(result.current.sections).toEqual([
      "mcp",
      "skills",
      "plugins",
      "packs",
    ])
    expect(result.current.section).toBe("mcp")
  })

  it("ignores a switch to a section the window does not offer", () => {
    const { result } = renderView(false)
    act(() => result.current.setSection("discover"))

    expect(result.current.section).toBe("mcp")
    expect(localStorage.getItem(SECTION_KEY)).toBeNull()
  })

  it("keeps a remembered Discover for when the catalog is back", () => {
    localStorage.setItem(SECTION_KEY, "discover")
    let discoverEnabled = false
    const { result, rerender } = renderHook(() => useHarnessView(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <HarnessViewProvider discoverEnabled={discoverEnabled}>
          {children}
        </HarnessViewProvider>
      ),
    })

    // Off: the page shows MCP, without forgetting what was remembered.
    expect(result.current.section).toBe("mcp")
    expect(localStorage.getItem(SECTION_KEY)).toBe("discover")

    // The flag arrives from the backend after mount, so it can change under
    // a live provider.
    discoverEnabled = true
    rerender()
    expect(result.current.section).toBe("discover")
  })

  it("leaves Discover when the catalog is switched off under it", () => {
    let discoverEnabled = true
    const { result, rerender } = renderHook(() => useHarnessView(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <HarnessViewProvider discoverEnabled={discoverEnabled}>
          {children}
        </HarnessViewProvider>
      ),
    })
    expect(result.current.section).toBe("discover")

    discoverEnabled = false
    rerender()
    expect(result.current.section).toBe("mcp")
    expect(result.current.sections).not.toContain("discover")
  })
})

describe("HarnessViewProvider — open", () => {
  it("goes to the requested section and parks its target", () => {
    const { result } = renderView()
    let outcome: ReturnType<typeof result.current.open> | undefined
    act(() => {
      outcome = result.current.open({ section: "packs", tab: "office" })
    })

    expect(outcome).toEqual({ section: "packs", targeted: true })
    expect(result.current.section).toBe("packs")
    expect(result.current.pendingTarget).toEqual({
      section: "packs",
      tab: "office",
    })
    // Being sent somewhere counts as having been there.
    expect(localStorage.getItem(SECTION_KEY)).toBe("packs")
  })

  it("carries each kind of target to its own section", () => {
    const { result } = renderView()

    act(() => {
      result.current.open({ section: "discover", itemRef: "acme/pdf-tools" })
    })
    expect(result.current.pendingTarget).toEqual({
      section: "discover",
      itemRef: "acme/pdf-tools",
    })

    act(() => {
      result.current.open({ section: "mcp", serverKey: "github" })
    })
    expect(result.current.pendingTarget).toEqual({
      section: "mcp",
      serverKey: "github",
    })

    act(() => {
      result.current.open({ section: "skills", skillId: "pdf" })
    })
    expect(result.current.pendingTarget).toEqual({
      section: "skills",
      skillId: "pdf",
    })
  })

  it("parks what a link wants done with an item along with it", () => {
    const { result } = renderView()
    act(() => {
      result.current.open({
        section: "discover",
        itemRef: "acme/pdf-tools",
        intent: "install",
      })
    })
    expect(result.current.section).toBe("discover")
    expect(result.current.pendingTarget).toEqual({
      section: "discover",
      itemRef: "acme/pdf-tools",
      intent: "install",
    })
  })

  it("only switches section for a request that names no target", () => {
    const { result } = renderView()
    let outcome: ReturnType<typeof result.current.open> | undefined
    act(() => {
      outcome = result.current.open({ section: "mcp" })
    })

    expect(outcome).toEqual({ section: "mcp", targeted: false })
    expect(result.current.section).toBe("mcp")
    expect(result.current.pendingTarget).toBeNull()
  })

  it("stays where it was with no request at all", () => {
    const { result } = renderView()
    act(() => result.current.setSection("skills"))
    let outcome: ReturnType<typeof result.current.open> | undefined
    act(() => {
      outcome = result.current.open()
    })

    expect(outcome).toEqual({ section: "skills", targeted: false })
    expect(result.current.section).toBe("skills")
  })

  it("answers with the section it stayed on when Discover is switched off", () => {
    const { result } = renderView(false)
    act(() => result.current.setSection("packs"))
    let outcome: ReturnType<typeof result.current.open> | undefined
    act(() => {
      outcome = result.current.open({
        section: "discover",
        itemRef: "acme/pdf-tools",
      })
    })

    // Not an error: the caller reads that the section differs and that nothing
    // was targeted, and says so in its own words.
    expect(outcome).toEqual({ section: "packs", targeted: false })
    expect(result.current.section).toBe("packs")
    expect(result.current.pendingTarget).toBeNull()
  })

  it("parks a new target for the same request asked twice", () => {
    const { result } = renderView()
    act(() => {
      result.current.open({ section: "packs", tab: "ui" })
    })
    const first = result.current.pendingTarget
    act(() => {
      result.current.open({ section: "packs", tab: "ui" })
    })

    expect(result.current.pendingTarget).toEqual(first)
    expect(result.current.pendingTarget).not.toBe(first)
  })

  it("lets a newer request supersede a parked target", () => {
    const { result } = renderView()
    act(() => {
      result.current.open({ section: "mcp", serverKey: "github" })
    })
    act(() => {
      result.current.open({ section: "skills" })
    })

    expect(result.current.section).toBe("skills")
    expect(result.current.pendingTarget).toBeNull()
  })

  it("drops a parked target when the user walks away from it", () => {
    const { result } = renderView()
    act(() => {
      result.current.open({ section: "mcp", serverKey: "github" })
    })
    act(() => result.current.setSection("skills"))

    // Otherwise it would go off the next time they came back to MCP.
    expect(result.current.pendingTarget).toBeNull()
  })

  it("clears only the target it is handed", () => {
    const { result } = renderView()
    act(() => {
      result.current.open({ section: "mcp", serverKey: "github" })
    })
    const stale = result.current.pendingTarget!
    act(() => {
      result.current.open({ section: "mcp", serverKey: "linear" })
    })

    // A section finishing with an older target must not take a newer one
    // down with it.
    act(() => result.current.clearPendingTarget(stale))
    expect(result.current.pendingTarget).toEqual({
      section: "mcp",
      serverKey: "linear",
    })

    act(() => result.current.clearPendingTarget(result.current.pendingTarget!))
    expect(result.current.pendingTarget).toBeNull()
  })

  it("keeps `open` and `setSection` stable across section switches", () => {
    // Callers put them in effect deps and callbacks; a new identity on every
    // switch would re-run those for nothing.
    const { result } = renderView()
    const { open, setSection } = result.current
    act(() => result.current.setSection("skills"))
    act(() => {
      result.current.open({ section: "packs", tab: "science" })
    })

    expect(result.current.open).toBe(open)
    expect(result.current.setSection).toBe(setSection)
  })
})

describe("HarnessViewProvider — updates count", () => {
  it("starts at zero and takes what it is given", () => {
    const { result } = renderView()
    expect(result.current.updatesCount).toBe(0)

    act(() => result.current.setUpdatesCount(3))
    expect(result.current.updatesCount).toBe(3)
  })

  it("never holds anything a badge could not show", () => {
    const { result } = renderView()
    for (const [given, held] of [
      [-2, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [2.9, 2],
    ] as const) {
      act(() => result.current.setUpdatesCount(given))
      expect(result.current.updatesCount).toBe(held)
    }
  })
})

describe("useHarnessView / useOptionalHarnessView", () => {
  it("throws outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => renderHook(() => useHarnessView())).toThrow(
      /HarnessViewProvider/
    )
    spy.mockRestore()
  })

  it("answers null outside the provider when asked optionally", () => {
    const { result } = renderHook(() => useOptionalHarnessView())
    expect(result.current).toBeNull()
  })
})

const QUERY = defineHarnessSlot<string>("discover", () => "")
const SORT = defineHarnessSlot<string>("discover", () => "popular")

/** Stands in for a page section: it has a search box whose text lives in a
 *  slot, and reports every render. */
function SearchBox({ onRender }: { onRender?: () => void }) {
  const [query, setQuery] = useHarnessSlot(QUERY)
  onRender?.()
  return (
    <input
      aria-label="search"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  )
}

function SortPicker({ onRender }: { onRender?: () => void }) {
  const [sort, setSort] = useHarnessSlot(SORT)
  onRender?.()
  return (
    <button type="button" onClick={() => setSort("newest")}>
      sort: {sort}
    </button>
  )
}

/** The workbench in miniature: the provider stays, the page comes and goes. */
function Workbench({ children }: { children: ReactNode }) {
  const [pageOpen, setPageOpen] = useState(true)
  return (
    <HarnessViewProvider>
      <button type="button" onClick={() => setPageOpen((open) => !open)}>
        toggle page
      </button>
      {pageOpen ? children : null}
    </HarnessViewProvider>
  )
}

describe("useHarnessSlot", () => {
  it("keeps a section's state while the page is unmounted", () => {
    render(
      <Workbench>
        <SearchBox />
      </Workbench>
    )
    fireEvent.change(screen.getByLabelText("search"), {
      target: { value: "pdf" },
    })

    // Back to a conversation: the page, and the input, are gone.
    fireEvent.click(screen.getByText("toggle page"))
    expect(screen.queryByLabelText("search")).toBeNull()

    // …and back again.
    fireEvent.click(screen.getByText("toggle page"))
    expect(screen.getByLabelText("search")).toHaveValue("pdf")
  })

  it("re-renders only the readers of the slot that was written", () => {
    const onSearchRender = vi.fn()
    const onSortRender = vi.fn()
    render(
      <Workbench>
        <SearchBox onRender={onSearchRender} />
        <SortPicker onRender={onSortRender} />
      </Workbench>
    )
    onSearchRender.mockClear()
    onSortRender.mockClear()

    fireEvent.change(screen.getByLabelText("search"), {
      target: { value: "p" },
    })

    expect(onSearchRender).toHaveBeenCalledTimes(1)
    expect(onSortRender).not.toHaveBeenCalled()
  })

  it("does not touch the context value, so the sidebar hears no keystrokes", () => {
    const values: unknown[] = []
    function ContextWatcher() {
      values.push(useHarnessView())
      return null
    }
    render(
      <Workbench>
        <ContextWatcher />
        <SearchBox />
      </Workbench>
    )
    const before = values.length

    fireEvent.change(screen.getByLabelText("search"), {
      target: { value: "pdf" },
    })

    expect(values.length).toBe(before)
  })

  it("can be written while no reader is mounted", () => {
    // What a running install does while the user is in a conversation: its
    // stream keeps writing through the store, with no page there to render.
    function Writer() {
      const { slots } = useHarnessView()
      return (
        <button type="button" onClick={() => slots.set(QUERY, "from afar")}>
          write
        </button>
      )
    }
    function Page() {
      const [query] = useHarnessSlot(QUERY)
      return <output>{query}</output>
    }
    function Shell() {
      const [pageOpen, setPageOpen] = useState(false)
      return (
        <HarnessViewProvider>
          <Writer />
          <button type="button" onClick={() => setPageOpen(true)}>
            open page
          </button>
          {pageOpen ? <Page /> : null}
        </HarnessViewProvider>
      )
    }
    const { container } = render(<Shell />)

    fireEvent.click(screen.getByText("write"))
    fireEvent.click(screen.getByText("open page"))

    expect(container.querySelector("output")?.textContent).toBe("from afar")
  })

  it("keeps each provider's slots to itself", () => {
    // One provider per window: what one window typed is not another's.
    function Page({ label }: { label: string }) {
      const [query, setQuery] = useHarnessSlot(QUERY)
      return (
        <button type="button" onClick={() => setQuery(label)}>
          {label}: {query || "empty"}
        </button>
      )
    }
    render(
      <>
        <HarnessViewProvider>
          <Page label="a" />
        </HarnessViewProvider>
        <HarnessViewProvider>
          <Page label="b" />
        </HarnessViewProvider>
      </>
    )

    fireEvent.click(screen.getByText("a: empty"))

    expect(screen.getByText("a: a")).toBeTruthy()
    expect(screen.getByText("b: empty")).toBeTruthy()
  })
})

/** A section that honours its target by remembering it, as Skill packs does
 *  with its tab. */
function PacksProbe({
  onApply,
}: {
  onApply: (target: HarnessTargetFor<"packs">) => void
}) {
  const target = useConsumeHarnessTarget("packs", onApply)
  const { pendingTarget } = useHarnessView()
  return (
    <div>
      <span data-testid="seen">{target?.tab ?? "none"}</span>
      <span data-testid="parked">{pendingTarget ? "parked" : "clear"}</span>
    </div>
  )
}

function OpenButton({ label, run }: { label: string; run: () => void }) {
  return (
    <button type="button" onClick={run}>
      {label}
    </button>
  )
}

function OpenPacks({ tab }: { tab: "experts" | "science" | "office" | "ui" }) {
  const { open } = useHarnessView()
  return (
    <OpenButton
      label={`open ${tab}`}
      run={() => open({ section: "packs", tab })}
    />
  )
}

describe("useConsumeHarnessTarget", () => {
  it("hands the section its target once, then clears it", () => {
    const onApply = vi.fn()
    render(
      <HarnessViewProvider>
        <OpenPacks tab="office" />
        <PacksProbe onApply={onApply} />
      </HarnessViewProvider>
    )
    expect(onApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("open office"))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ section: "packs", tab: "office" })
    expect(screen.getByTestId("parked").textContent).toBe("clear")
    expect(screen.getByTestId("seen").textContent).toBe("none")
  })

  it("hands Discover what a link wants done with the item", () => {
    const onApply = vi.fn()
    function DiscoverProbe() {
      useConsumeHarnessTarget("discover", onApply)
      return null
    }
    function OpenFromLink() {
      const { open } = useHarnessView()
      return (
        <OpenButton
          label="open from link"
          run={() =>
            open({
              section: "discover",
              itemRef: "acme/pdf-tools",
              intent: "install",
            })
          }
        />
      )
    }
    render(
      <HarnessViewProvider>
        <OpenFromLink />
        <DiscoverProbe />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open from link"))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      section: "discover",
      itemRef: "acme/pdf-tools",
      intent: "install",
    })
  })

  it("applies the same request again when it is asked again", () => {
    const onApply = vi.fn()
    render(
      <HarnessViewProvider>
        <OpenPacks tab="office" />
        <PacksProbe onApply={onApply} />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open office"))
    fireEvent.click(screen.getByText("open office"))

    expect(onApply).toHaveBeenCalledTimes(2)
  })

  it("applies a target parked before the section mounted", () => {
    // The usual order: the request is made from a conversation, and the page
    // — with this section in it — mounts afterwards.
    const onApply = vi.fn()
    function Late() {
      const [mounted, setMounted] = useState(false)
      return (
        <>
          <OpenButton label="mount section" run={() => setMounted(true)} />
          {mounted ? <PacksProbe onApply={onApply} /> : null}
        </>
      )
    }
    render(
      <HarnessViewProvider>
        <OpenPacks tab="science" />
        <Late />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open science"))
    expect(onApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("mount section"))

    expect(onApply).toHaveBeenCalledWith({ section: "packs", tab: "science" })
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })

  it("shows the section its target during the render before it is taken", () => {
    const seen: (string | null)[] = []
    function Watcher() {
      seen.push(useHarnessTarget("packs")?.tab ?? null)
      return null
    }
    render(
      <HarnessViewProvider>
        <OpenPacks tab="ui" />
        <Watcher />
        <PacksProbe onApply={() => {}} />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open ui"))

    // The first frame after the request already knows the tab — that is what
    // lets a section paint on it instead of on the remembered one.
    expect(seen).toContain("ui")
    expect(seen[seen.length - 1]).toBeNull()
  })

  it("only drops the target when the section cannot honour one yet", () => {
    function McpProbe() {
      useConsumeHarnessTarget("mcp")
      const { pendingTarget, section } = useHarnessView()
      return (
        <span data-testid="state">
          {section}:{pendingTarget ? "parked" : "clear"}
        </span>
      )
    }
    function OpenMcp() {
      const { open } = useHarnessView()
      return (
        <OpenButton
          label="open mcp"
          run={() => open({ section: "mcp", serverKey: "github" })}
        />
      )
    }
    render(
      <HarnessViewProvider>
        <OpenMcp />
        <McpProbe />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open mcp"))

    // The section opened; nothing is left to go off later.
    expect(screen.getByTestId("state").textContent).toBe("mcp:clear")
  })

  it("leaves a target for another section alone", () => {
    const onApply = vi.fn()
    function OpenSkill() {
      const { open } = useHarnessView()
      return (
        <OpenButton
          label="open skill"
          run={() => open({ section: "skills", skillId: "pdf" })}
        />
      )
    }
    render(
      <HarnessViewProvider>
        <OpenSkill />
        <PacksProbe onApply={onApply} />
      </HarnessViewProvider>
    )
    fireEvent.click(screen.getByText("open skill"))

    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByTestId("parked").textContent).toBe("parked")
  })

  it("still clears the target when effects run twice (StrictMode)", () => {
    const onApply = vi.fn()
    render(
      <StrictMode>
        <HarnessViewProvider>
          <OpenPacks tab="office" />
          <PacksProbe onApply={onApply} />
        </HarnessViewProvider>
      </StrictMode>
    )
    fireEvent.click(screen.getByText("open office"))

    expect(onApply).toHaveBeenCalledWith({ section: "packs", tab: "office" })
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })
})

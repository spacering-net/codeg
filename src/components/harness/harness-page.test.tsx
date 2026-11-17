import { useState, type ReactNode } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { Direction } from "radix-ui"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  mobile: false,
  /** Every tab the (stubbed) Skill-packs section was drawn on, in order. */
  packTabs: [] as string[],
}))

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

// Skills and Skill packs have tests of their own (skills/skills-section.test,
// packs/packs-section.test), and a backend the page's tests have no business
// with. Their stubs keep what the page relies on: the target a request
// carried, the tab kept in the provider, and the host label each section
// heads itself with.
vi.mock("./skills/skills-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  const { HarnessHostLabel } = await import("./harness-host-label")
  return {
    SkillsSection: () => {
      const [skillId, setSkillId] = useState("none")
      useConsumeHarnessTarget("skills", (target) => setSkillId(target.skillId))
      return (
        <div data-testid="skills-section" data-skill={skillId}>
          <HarnessHostLabel />
        </div>
      )
    },
  }
})
vi.mock("./packs/packs-section", async () => {
  const { useConsumeHarnessTarget, useHarnessSlot } =
    await import("@/contexts/harness-view-context")
  const { PACKS_TAB } = await import("@/lib/harness/packs-state")
  const { HarnessHostLabel } = await import("./harness-host-label")
  return {
    PacksSection: () => {
      const [stored, setTab] = useHarnessSlot(PACKS_TAB)
      const target = useConsumeHarnessTarget("packs", (requested) =>
        setTab(requested.tab)
      )
      const tab = target?.tab ?? stored
      mocks.packTabs.push(tab)
      return (
        <div data-testid="packs-section" data-tab={tab}>
          <HarnessHostLabel />
          <button type="button" onClick={() => setTab("science")}>
            pick science
          </button>
        </div>
      )
    },
  }
})

// MCP has tests of its own (mcp/mcp-section.test.tsx), and a backend the
// page's tests have no business with. Its stub keeps what the page relies on:
// the server a request asked for, and the host label the section heads itself
// with.
vi.mock("./mcp/mcp-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  const { HarnessHostLabel } = await import("./harness-host-label")
  return {
    McpSection: () => {
      const [serverKey, setServerKey] = useState("none")
      useConsumeHarnessTarget("mcp", (target) => setServerKey(target.serverKey))
      return (
        <div data-testid="mcp-section" data-server={serverKey}>
          <HarnessHostLabel />
        </div>
      )
    },
  }
})

// Discover has tests of its own (discover/discover-section.test.tsx), and a
// backend the page's tests have no business with. Its stub keeps the one
// thing the page hands it: the item a request asked for.
vi.mock("./discover/discover-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  return {
    DiscoverSection: () => {
      const [itemRef, setItemRef] = useState("none")
      useConsumeHarnessTarget("discover", (target) =>
        setItemRef(target.itemRef)
      )
      return <div data-testid="discover-section" data-item={itemRef} />
    },
  }
})

import { AppearanceContext } from "@/components/appearance-provider"
import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import type { HarnessOpenRequest } from "@/lib/harness-sections"
import { HarnessPage, HarnessPageTitle } from "./harness-page"

const SECTION_KEY = "workspace:harness-section"

function Intl({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

function renderPage(options: { discoverEnabled?: boolean } = {}) {
  return render(
    <Intl>
      <HarnessViewProvider discoverEnabled={options.discoverEnabled}>
        <HarnessPage />
      </HarnessViewProvider>
    </Intl>
  )
}

const tab = (name: string) => screen.getByRole("tab", { name })
const tabNames = () =>
  screen.getAllByRole("tab").map((el) => el.textContent ?? "")
const selectedTab = () =>
  screen
    .getAllByRole("tab")
    .filter((el) => el.getAttribute("aria-selected") === "true")
    .map((el) => el.textContent ?? "")

/** jsdom reports 0 for every layout measurement, so the page width the layout
 *  goes by is stubbed on the prototype — as `use-element-width.test` does. */
function stubPageWidth(width: number): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  )
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", original)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.mobile = false
  mocks.packTabs.length = 0
})

describe("HarnessPage — sections", () => {
  it("says what the page is for, and opens on Discover the first time", () => {
    renderPage()

    expect(
      screen.getByText(
        "Manage your agents' MCP servers, skills and skill packs, and find more from SRN Harness under Discover."
      )
    ).toBeTruthy()
    expect(tabNames()).toEqual(["Discover", "MCP", "Skills", "Skill Packs"])
    expect(selectedTab()).toEqual(["Discover"])
    const panel = screen.getByRole("tabpanel", { name: "Discover" })
    expect(within(panel).getByTestId("discover-section")).toBeTruthy()
  })

  it("is a labelled column of tabs on a wide page", () => {
    renderPage()

    const list = screen.getByRole("tablist", { name: "Harness sections" })
    expect(list).toHaveAttribute("aria-orientation", "vertical")
    // Each tab names the panel it controls.
    const panel = screen.getByRole("tabpanel")
    expect(tab("Discover")).toHaveAttribute("aria-controls", panel.id)
    expect(panel).toHaveAttribute("aria-labelledby", tab("Discover").id)
  })

  it("mounts the section on show, and only that one", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(tab("MCP"))
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()
    expect(selectedTab()).toEqual(["MCP"])
    // Only the current section is mounted.
    expect(screen.queryByTestId("discover-section")).toBeNull()

    await user.click(tab("Skills"))
    expect(await screen.findByTestId("skills-section")).toBeTruthy()
    expect(screen.queryByTestId("mcp-section")).toBeNull()

    await user.click(tab("Skill Packs"))
    expect(await screen.findByTestId("packs-section")).toBeTruthy()
    expect(screen.queryByTestId("skills-section")).toBeNull()
  })

  it("names the host being changed on those three, and not on Discover", async () => {
    const user = userEvent.setup()
    const { container } = renderPage()
    const host = () => container.querySelector("[data-harness-host]")

    expect(host()).toBeNull()
    for (const name of ["MCP", "Skills", "Skill Packs"]) {
      await user.click(tab(name))
      expect(host()).toHaveAttribute("data-harness-host", "local")
      expect(host()?.textContent).toContain("This computer")
    }
  })

  it("holds no section at a width floor: each is built for narrow panes", async () => {
    const user = userEvent.setup()
    const { container } = renderPage()
    for (const [name, testId] of [
      ["MCP", "mcp-section"],
      ["Skills", "skills-section"],
      ["Skill Packs", "packs-section"],
    ] as const) {
      await user.click(tab(name))
      await screen.findByTestId(testId)
      // The stopgap frame that held the Settings window's screens at 48rem,
      // scrolling sideways below it, is gone.
      expect(
        container.querySelector("[data-settings-section-floor]")
      ).toBeNull()
    }
  })

  it("remembers the section across a restart", async () => {
    const user = userEvent.setup()
    const first = renderPage()
    await user.click(tab("Skills"))
    expect(localStorage.getItem(SECTION_KEY)).toBe("skills")
    first.unmount()

    renderPage()
    expect(selectedTab()).toEqual(["Skills"])
    expect(await screen.findByTestId("skills-section")).toBeTruthy()
  })

  it("has no Discover, and opens on MCP, with the catalog switched off", async () => {
    renderPage({ discoverEnabled: false })

    expect(tabNames()).toEqual(["MCP", "Skills", "Skill Packs"])
    expect(selectedTab()).toEqual(["MCP"])
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()
    // The description must not point at a section that is not there.
    expect(
      screen.getByText(
        "Manage your agents' MCP servers, skills and skill packs."
      )
    ).toBeTruthy()
    expect(screen.queryByText(/under Discover/)).toBeNull()
  })

  it("shows MCP for a remembered Discover that is switched off", async () => {
    localStorage.setItem(SECTION_KEY, "discover")
    renderPage({ discoverEnabled: false })

    expect(selectedTab()).toEqual(["MCP"])
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()
  })
})

describe("HarnessPage — the column's keyboard", () => {
  it("walks the sections with the vertical arrows, Home and End", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowDown}")
    expect(tab("MCP")).toHaveFocus()
    expect(selectedTab()).toEqual(["MCP"])

    await user.keyboard("{End}")
    expect(tab("Skill Packs")).toHaveFocus()
    expect(selectedTab()).toEqual(["Skill Packs"])

    await user.keyboard("{Home}")
    expect(tab("Discover")).toHaveFocus()
    expect(selectedTab()).toEqual(["Discover"])

    await user.keyboard("{ArrowUp}")
    // Wraps, like every other tab list in the app.
    expect(tab("Skill Packs")).toHaveFocus()
  })

  it("does not scroll anything about: the column never overflows", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView")
    try {
      localStorage.setItem(SECTION_KEY, "packs")
      renderPage()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("leaves the sideways arrows alone in the column", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowRight}")

    expect(tab("Discover")).toHaveFocus()
    expect(selectedTab()).toEqual(["Discover"])
  })
})

describe("HarnessPage — the segmented switch", () => {
  beforeEach(() => {
    mocks.mobile = true
  })

  it("replaces the column on a narrow screen, with the same tabs", () => {
    renderPage()

    const list = screen.getByRole("tablist", { name: "Harness sections" })
    expect(list).toHaveAttribute("aria-orientation", "horizontal")
    expect(tabNames()).toEqual(["Discover", "MCP", "Skills", "Skill Packs"])
    expect(selectedTab()).toEqual(["Discover"])
  })

  it("is one stop in the tab order, on the selected segment", async () => {
    const user = userEvent.setup()
    localStorage.setItem(SECTION_KEY, "skills")
    renderPage()

    // Roving focus: Tab lands on the selected segment, not the first one…
    await user.tab()
    expect(tab("Skills")).toHaveFocus()

    // …and the next Tab leaves the switch for the section, instead of
    // stepping through the remaining segments.
    await user.tab()
    expect(screen.getByRole("tabpanel", { name: "Skills" })).toHaveFocus()
  })

  it("switches with the sideways arrows, Home and End", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowRight}")
    expect(tab("MCP")).toHaveFocus()
    expect(selectedTab()).toEqual(["MCP"])
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()

    await user.keyboard("{ArrowRight}")
    expect(selectedTab()).toEqual(["Skills"])

    await user.keyboard("{ArrowLeft}")
    expect(tab("MCP")).toHaveFocus()
    expect(selectedTab()).toEqual(["MCP"])

    await user.keyboard("{End}")
    expect(tab("Skill Packs")).toHaveFocus()
    expect(selectedTab()).toEqual(["Skill Packs"])

    await user.keyboard("{Home}")
    expect(tab("Discover")).toHaveFocus()
    expect(selectedTab()).toEqual(["Discover"])
    // The selected segment is the one stop in the tab order again.
    expect(tab("Discover")).toHaveAttribute("tabindex", "0")
    expect(tab("Skill Packs")).toHaveAttribute("tabindex", "-1")
  })

  it("wraps at both ends", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowLeft}")
    expect(selectedTab()).toEqual(["Skill Packs"])

    await user.keyboard("{ArrowRight}")
    expect(selectedTab()).toEqual(["Discover"])
  })

  it("leaves the vertical arrows to the page", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowDown}")

    expect(tab("Discover")).toHaveFocus()
    expect(selectedTab()).toEqual(["Discover"])
  })

  it("remembers a section picked with the keyboard", async () => {
    const user = userEvent.setup()
    renderPage()
    act(() => tab("Discover").focus())

    await user.keyboard("{ArrowRight}{ArrowRight}")

    expect(localStorage.getItem(SECTION_KEY)).toBe("skills")
  })

  it("skips Discover when the catalog is switched off", async () => {
    const user = userEvent.setup()
    renderPage({ discoverEnabled: false })
    act(() => tab("MCP").focus())

    await user.keyboard("{ArrowLeft}")

    // Three segments, so left of the first is the last — not a hidden fourth.
    expect(selectedTab()).toEqual(["Skill Packs"])
  })

  it("mirrors the arrows in a right-to-left language", async () => {
    const user = userEvent.setup()
    render(
      <Intl>
        <Direction.DirectionProvider dir="rtl">
          <HarnessViewProvider>
            <HarnessPage />
          </HarnessViewProvider>
        </Direction.DirectionProvider>
      </Intl>
    )
    act(() => tab("Discover").focus())

    // The next segment is drawn to the LEFT of this one.
    await user.keyboard("{ArrowLeft}")
    expect(selectedTab()).toEqual(["MCP"])

    await user.keyboard("{ArrowRight}")
    expect(selectedTab()).toEqual(["Discover"])
  })

  it("brings the selected segment into view when the track has to scroll", async () => {
    // Four long labels on a phone overflow the track; it scrolls with no
    // scrollbar, so a selected segment out of view would look like none.
    const scrolled: string[] = []
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this.textContent ?? "")
      })
    try {
      const user = userEvent.setup()
      localStorage.setItem(SECTION_KEY, "packs")
      renderPage()
      // Opening on the remembered section — the last segment.
      expect(scrolled).toEqual(["Skill Packs"])

      act(() => tab("Skill Packs").focus())
      await user.keyboard("{Home}")
      expect(scrolled[scrolled.length - 1]).toBe("Discover")
    } finally {
      spy.mockRestore()
    }
  })

  it("switches on a tap", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(tab("Skill Packs"))

    expect(selectedTab()).toEqual(["Skill Packs"])
    expect(await screen.findByTestId("packs-section")).toBeTruthy()
  })
})

describe("HarnessPage — the top of the page on a phone", () => {
  const DESCRIPTION =
    "Manage your agents' MCP servers, skills and skill packs, and find more from SRN Harness under Discover."

  /** jsdom lays nothing out: say how wide the description's one line is,
   *  and how wide the sentence would need it to be. */
  function stubLine(needed: number, has: number): () => void {
    const originals = (["scrollWidth", "clientWidth"] as const).map(
      (key) =>
        [
          key,
          Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
        ] as const
    )
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => needed,
    })
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => has,
    })
    return () => {
      for (const [key, original] of originals) {
        if (original)
          Object.defineProperty(HTMLElement.prototype, key, original)
        else
          delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
            key
          ]
      }
    }
  }

  it("holds the description to one line, with More to show the rest", async () => {
    mocks.mobile = true
    const restore = stubLine(900, 300)
    try {
      const user = userEvent.setup()
      renderPage()
      // The whole sentence is in the page all along: a screen reader reads it
      // through, folded or not.
      const description = screen.getByText(DESCRIPTION)
      expect(description).toHaveClass("truncate")
      const more = screen.getByRole("button", { name: "More" })
      expect(more).toHaveAttribute("aria-expanded", "false")
      expect(more).toHaveAttribute("aria-controls", description.id)

      await user.click(more)
      expect(description).not.toHaveClass("truncate")
      const less = screen.getByRole("button", { name: "Less" })
      expect(less).toHaveAttribute("aria-expanded", "true")

      await user.click(less)
      expect(description).toHaveClass("truncate")
      expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it("offers no More where the one line holds it all", () => {
    mocks.mobile = true
    const restore = stubLine(300, 300)
    try {
      renderPage()
      expect(screen.getByText(DESCRIPTION)).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "More" })).toBeNull()
    } finally {
      restore()
    }
  })

  it("leaves the description whole beside the column", () => {
    const restore = stubLine(1800, 1200)
    try {
      renderPage()
      expect(screen.getByText(DESCRIPTION)).not.toHaveClass("truncate")
      expect(screen.queryByRole("button", { name: "More" })).toBeNull()
    } finally {
      restore()
    }
  })

  it("keeps the host's sentence beside the chip on a wide page", async () => {
    const user = userEvent.setup()
    const { container } = renderPage()

    await user.click(tab("Skills"))
    const host = container.querySelector("[data-harness-host]") as HTMLElement
    expect(
      within(host).getByText("Changes here are saved on this computer.")
    ).not.toHaveClass("sr-only")
    expect(
      within(host).getByText("This computer").closest("[title]")
    ).toBeNull()
  })
})

describe("HarnessPage — which shape the switcher takes", () => {
  const orientation = () =>
    screen.getByRole("tablist").getAttribute("aria-orientation")

  it("goes by the page's own width, not the viewport's", () => {
    // A wide screen with a wide sidebar: the viewport is desktop-sized, the
    // page beside the sidebar is not.
    const restore = stubPageWidth(700)
    try {
      renderPage()
      expect(orientation()).toBe("horizontal")
    } finally {
      restore()
    }
  })

  it("keeps the column in a 1280-wide window with the sidebar open", () => {
    // What a 1280 window leaves the page beside the sidebar at its default
    // width: the section column, and a section that still fits its list and
    // its detail side by side.
    const restore = stubPageWidth(959)
    try {
      renderPage()
      expect(orientation()).toBe("vertical")
    } finally {
      restore()
    }
  })

  it("gives way to the switch just below the column and a side-by-side section", () => {
    const restore = stubPageWidth(927)
    try {
      renderPage()
      expect(orientation()).toBe("horizontal")
    } finally {
      restore()
    }
  })

  it("keeps the column once the page is wide enough for it", () => {
    const restore = stubPageWidth(1200)
    try {
      renderPage()
      expect(orientation()).toBe("vertical")
    } finally {
      restore()
    }
  })

  it("asks for more room when the app is zoomed in", () => {
    // At 150% a rem is 24px: the column and what sits beside it are half
    // again as wide, so the same 1200px no longer holds both.
    const restore = stubPageWidth(1200)
    try {
      render(
        <Intl>
          <AppearanceContext.Provider value={{ zoomLevel: 150 } as never}>
            <HarnessViewProvider>
              <HarnessPage />
            </HarnessViewProvider>
          </AppearanceContext.Provider>
        </Intl>
      )
      expect(orientation()).toBe("horizontal")
    } finally {
      restore()
    }
  })

  it("keeps the section mounted when a resize flips the switcher", async () => {
    const user = userEvent.setup()
    const { rerender } = renderPage()
    await user.click(tab("MCP"))
    const before = await screen.findByTestId("mcp-section")

    mocks.mobile = true
    rerender(
      <Intl>
        <HarnessViewProvider>
          <HarnessPage />
        </HarnessViewProvider>
      </Intl>
    )

    expect(orientation()).toBe("horizontal")
    // The same node: an editor's unsaved text must not go with a window drag.
    expect(screen.getByTestId("mcp-section")).toBe(before)
  })
})

/** The workbench in miniature: the provider stays mounted, the page comes and
 *  goes with the route — which is what the real layout does. */
function Workbench({ request }: { request?: HarnessOpenRequest }) {
  return (
    <Intl>
      <HarnessViewProvider>
        <WorkbenchRouteProvider>
          <WorkbenchControls request={request} />
          <WorkbenchPage />
        </WorkbenchRouteProvider>
      </HarnessViewProvider>
    </Intl>
  )
}

function WorkbenchControls({ request }: { request?: HarnessOpenRequest }) {
  const { openConversations } = useWorkbenchRoute()
  const { openHarness } = useOpenHarness()
  const { pendingTarget } = useHarnessView()
  return (
    <div>
      <button type="button" onClick={openConversations}>
        go to conversation
      </button>
      <button type="button" onClick={() => openHarness(request)}>
        open harness
      </button>
      <span data-testid="parked">{pendingTarget ? "parked" : "clear"}</span>
    </div>
  )
}

function WorkbenchPage() {
  const { routeId } = useWorkbenchRoute()
  return routeId === "harness" ? <HarnessPage /> : <div>conversation</div>
}

describe("HarnessPage — state that outlives the page", () => {
  it("comes back on the section and the pack it was left on", async () => {
    const user = userEvent.setup()
    render(<Workbench />)
    await user.click(screen.getByText("open harness"))
    await user.click(tab("Skill Packs"))
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "experts"
    )
    await user.click(screen.getByText("pick science"))
    expect(screen.getByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "science"
    )

    // To a conversation: the page is unmounted, not hidden.
    await user.click(screen.getByText("go to conversation"))
    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.getByText("conversation")).toBeTruthy()

    // …and back.
    await user.click(screen.getByText("open harness"))
    expect(selectedTab()).toEqual(["Skill Packs"])
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "science"
    )
  })

  it("opens straight on a requested pack, never on the remembered one first", async () => {
    const user = userEvent.setup()
    render(<Workbench request={{ section: "packs", tab: "office" }} />)

    await user.click(screen.getByText("open harness"))

    expect(selectedTab()).toEqual(["Skill Packs"])
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "office"
    )
    // A first frame on "experts" would mount that pack, start its fetch and
    // throw both away.
    expect(new Set(mocks.packTabs)).toEqual(new Set(["office"]))
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })

  it("keeps a requested pack as the remembered one", async () => {
    const user = userEvent.setup()
    render(<Workbench request={{ section: "packs", tab: "ui" }} />)
    await user.click(screen.getByText("open harness"))
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "ui"
    )

    // Leaving and coming back by hand — no request this time.
    await user.click(screen.getByText("go to conversation"))
    await user.click(screen.getByText("open harness"))

    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "ui"
    )
  })

  it("re-targets a page that is already open", async () => {
    const user = userEvent.setup()
    function Retarget() {
      const [request, setRequest] = useState<HarnessOpenRequest>({
        section: "packs",
        tab: "office",
      })
      return (
        <>
          <button
            type="button"
            onClick={() => setRequest({ section: "packs", tab: "ui" })}
          >
            aim at ui
          </button>
          <Workbench request={request} />
        </>
      )
    }
    render(<Retarget />)
    await user.click(screen.getByText("open harness"))
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "office"
    )

    await user.click(screen.getByText("aim at ui"))
    await user.click(screen.getByText("open harness"))

    expect(screen.getByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "ui"
    )
  })

  it("hands a requested skill to Skills", async () => {
    const user = userEvent.setup()
    render(<Workbench request={{ section: "skills", skillId: "pdf" }} />)

    await user.click(screen.getByText("open harness"))

    expect(selectedTab()).toEqual(["Skills"])
    expect(await screen.findByTestId("skills-section")).toHaveAttribute(
      "data-skill",
      "pdf"
    )
    // Taken, not left parked to go off on a later visit.
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })

  it("opens Experts for a request for the Custom tab, which is gone", async () => {
    const user = userEvent.setup()
    render(
      <Workbench
        request={
          { section: "packs", tab: "custom" } as unknown as HarnessOpenRequest
        }
      />
    )
    await user.click(screen.getByText("open harness"))
    expect(await screen.findByTestId("packs-section")).toHaveAttribute(
      "data-tab",
      "experts"
    )
  })

  it("hands a requested server to MCP", async () => {
    const user = userEvent.setup()
    render(<Workbench request={{ section: "mcp", serverKey: "github" }} />)

    await user.click(screen.getByText("open harness"))

    expect(selectedTab()).toEqual(["MCP"])
    expect(screen.getByTestId("mcp-section")).toHaveAttribute(
      "data-server",
      "github"
    )
    // Taken, not left parked to go off on a later visit.
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })

  it("hands a requested item to Discover", async () => {
    const user = userEvent.setup()
    render(
      <Workbench request={{ section: "discover", itemRef: "acme/pdf-tools" }} />
    )

    await user.click(screen.getByText("open harness"))

    expect(selectedTab()).toEqual(["Discover"])
    expect(screen.getByTestId("discover-section")).toHaveAttribute(
      "data-item",
      "acme/pdf-tools"
    )
    // Taken, not left parked to go off on a later visit.
    expect(screen.getByTestId("parked").textContent).toBe("clear")
  })
})

describe("HarnessPageTitle", () => {
  it("is the shared breadcrumb, named Harness", () => {
    render(
      <Intl>
        <WorkbenchRouteProvider>
          <HarnessPageTitle />
        </WorkbenchRouteProvider>
      </Intl>
    )

    expect(screen.getByRole("heading", { name: "Harness" })).toBeTruthy()
    // The way back out of a full-page route.
    expect(
      screen.getByRole("button", { name: "Back to Conversations" })
    ).toBeTruthy()
  })

  it("leads back to the conversation", () => {
    function Route() {
      return <span data-testid="route">{useWorkbenchRoute().routeId}</span>
    }
    function Enter() {
      const { setRoute } = useWorkbenchRoute()
      return (
        <button type="button" onClick={() => setRoute("harness")}>
          enter
        </button>
      )
    }
    render(
      <Intl>
        <WorkbenchRouteProvider>
          <Enter />
          <Route />
          <HarnessPageTitle />
        </WorkbenchRouteProvider>
      </Intl>
    )
    fireEvent.click(screen.getByText("enter"))
    expect(screen.getByTestId("route").textContent).toBe("harness")

    fireEvent.click(
      screen.getByRole("button", { name: "Back to Conversations" })
    )

    expect(screen.getByTestId("route").textContent).toBe("conversations")
  })
})

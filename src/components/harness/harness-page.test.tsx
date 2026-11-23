import { useState, type ReactNode } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { Direction } from "radix-ui"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  mobile: false,
  /** What the tabs count (the real hook reads the MCP and skill stores). */
  counts: {} as Record<string, number>,
  /** Every tab the (stubbed) Skill-packs section was drawn on, in order. */
  packTabs: [] as string[],
}))

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }))
vi.mock("./harness-section-counts", () => ({
  useHarnessSectionCounts: () => mocks.counts,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

// Skills and Skill packs have tests of their own (skills/skills-section.test,
// packs/packs-section.test), and a backend the page's tests have no business
// with. Their stubs keep what the page relies on: the target a request
// carried, and the tab kept in the provider.
vi.mock("./skills/skills-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  return {
    SkillsSection: () => {
      const [skillId, setSkillId] = useState("none")
      useConsumeHarnessTarget("skills", (target) => setSkillId(target.skillId))
      return <div data-testid="skills-section" data-skill={skillId} />
    },
  }
})
vi.mock("./packs/packs-section", async () => {
  const { useConsumeHarnessTarget, useHarnessSlot } =
    await import("@/contexts/harness-view-context")
  const { PACKS_TAB } = await import("@/lib/harness/packs-state")
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
          <button type="button" onClick={() => setTab("science")}>
            pick science
          </button>
        </div>
      )
    },
  }
})

// Plugins reads the host's installed listing; its stub keeps the plugin a
// request asked for.
vi.mock("./plugins/plugins-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  return {
    PluginsSection: () => {
      const [itemId, setItemId] = useState("none")
      useConsumeHarnessTarget("plugins", (target) => setItemId(target.itemId))
      return <div data-testid="plugins-section" data-item={itemId} />
    },
  }
})

// MCP has tests of its own (mcp/mcp-section.test.tsx), and a backend the
// page's tests have no business with. Its stub keeps what the page relies on:
// the server a request asked for.
vi.mock("./mcp/mcp-section", async () => {
  const { useConsumeHarnessTarget } =
    await import("@/contexts/harness-view-context")
  return {
    McpSection: () => {
      const [serverKey, setServerKey] = useState("none")
      useConsumeHarnessTarget("mcp", (target) => setServerKey(target.serverKey))
      return <div data-testid="mcp-section" data-server={serverKey} />
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

/** The page as the workspace draws it: its title (with the section tabs) in
 *  the window-chrome strip, the page under it. */
function renderPage(options: { discoverEnabled?: boolean } = {}) {
  return render(
    <Intl>
      <HarnessViewProvider discoverEnabled={options.discoverEnabled}>
        <WorkbenchRouteProvider>
          <HarnessPageTitle />
          <HarnessPage />
        </WorkbenchRouteProvider>
      </HarnessViewProvider>
    </Intl>
  )
}

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}( \\d+)?$`) })
/** A tab's label, without its count. */
const label = (el: Element) => el.firstChild?.textContent ?? ""
const tabNames = () => screen.getAllByRole("tab").map(label)
const selectedTab = () =>
  screen
    .getAllByRole("tab")
    .filter((el) => el.getAttribute("aria-selected") === "true")
    .map(label)

beforeEach(() => {
  localStorage.clear()
  mocks.mobile = false
  mocks.counts = {}
  mocks.packTabs.length = 0
})

describe("HarnessPage — sections", () => {
  it("opens on Discover the first time", () => {
    renderPage()

    expect(tabNames()).toEqual([
      "Discover",
      "MCP",
      "Skills",
      "Plugins",
      "Skill Packs",
    ])
    expect(selectedTab()).toEqual(["Discover"])
    const panel = screen.getByRole("tabpanel", { name: "Discover" })
    expect(within(panel).getByTestId("discover-section")).toBeTruthy()
  })

  it("is a labelled row of tabs after the page's title", () => {
    renderPage()

    const list = screen.getByRole("tablist", {
      name: "Harness Engineering sections",
    })
    expect(list).toHaveAttribute("aria-orientation", "horizontal")
    // Each tab names the panel it controls.
    const panel = screen.getByRole("tabpanel")
    expect(tab("Discover")).toHaveAttribute("aria-controls", panel.id)
    expect(panel).toHaveAttribute("aria-labelledby", tab("Discover").id)
  })

  it("counts what each local section holds, and nothing for Discover", () => {
    mocks.counts = { mcp: 4, skills: 12, plugins: 1, packs: 2 }
    renderPage()

    expect(screen.getByRole("tab", { name: "MCP 4" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Skills 12" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Plugins 1" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Skill Packs 2" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Discover" })).toBeTruthy()
  })

  it("says no count before a section's store has been read", () => {
    mocks.counts = { mcp: 0 }
    renderPage()

    expect(screen.getByRole("tab", { name: "MCP 0" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Skills" })).toBeTruthy()
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

    expect(tabNames()).toEqual(["MCP", "Skills", "Plugins", "Skill Packs"])
    expect(selectedTab()).toEqual(["MCP"])
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()
  })

  it("shows MCP for a remembered Discover that is switched off", async () => {
    localStorage.setItem(SECTION_KEY, "discover")
    renderPage({ discoverEnabled: false })

    expect(selectedTab()).toEqual(["MCP"])
    expect(await screen.findByTestId("mcp-section")).toBeTruthy()
  })
})

describe("HarnessPage — the tabs' keyboard", () => {
  it("is one stop in the tab order, on the selected tab", async () => {
    const user = userEvent.setup()
    localStorage.setItem(SECTION_KEY, "skills")
    renderPage()

    // The way back to the conversations comes first in the strip.
    await user.tab()
    expect(
      screen.getByRole("button", { name: "Back to Conversations" })
    ).toHaveFocus()
    // Roving focus: Tab lands on the selected tab, not the first one…
    await user.tab()
    expect(tab("Skills")).toHaveFocus()
    // …and the next Tab leaves the tabs instead of stepping through them.
    await user.tab()
    expect(document.activeElement?.getAttribute("role")).not.toBe("tab")
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
    // The selected tab is the one stop in the tab order again.
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

    // Three tabs, so left of the first is the last — not a hidden fourth.
    expect(selectedTab()).toEqual(["Skill Packs"])
  })

  it("mirrors the arrows in a right-to-left language", async () => {
    const user = userEvent.setup()
    render(
      <Intl>
        <Direction.DirectionProvider dir="rtl">
          <HarnessViewProvider>
            <WorkbenchRouteProvider>
              <HarnessPageTitle />
              <HarnessPage />
            </WorkbenchRouteProvider>
          </HarnessViewProvider>
        </Direction.DirectionProvider>
      </Intl>
    )
    act(() => tab("Discover").focus())

    // The next tab is drawn to the LEFT of this one.
    await user.keyboard("{ArrowLeft}")
    expect(selectedTab()).toEqual(["MCP"])

    await user.keyboard("{ArrowRight}")
    expect(selectedTab()).toEqual(["Discover"])
  })

  it("brings the selected tab into view when the strip has to scroll", async () => {
    // In a narrow window the tabs overflow the strip; it scrolls with no
    // scrollbar, so a selected tab out of view would look like none.
    const scrolled: string[] = []
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(label(this))
      })
    try {
      const user = userEvent.setup()
      localStorage.setItem(SECTION_KEY, "packs")
      renderPage()
      // Opening on the remembered section — the last tab.
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
    mocks.mobile = true
    renderPage()

    await user.click(tab("Skill Packs"))

    expect(selectedTab()).toEqual(["Skill Packs"])
    expect(await screen.findByTestId("packs-section")).toBeTruthy()
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
  return routeId === "harness" ? (
    <>
      <HarnessPageTitle />
      <HarnessPage />
    </>
  ) : (
    <div>conversation</div>
  )
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

  it("hands a requested plugin to Plugins", async () => {
    const user = userEvent.setup()
    render(
      <Workbench request={{ section: "plugins", itemId: "itm_superpowers" }} />
    )

    await user.click(screen.getByText("open harness"))

    expect(selectedTab()).toEqual(["Plugins"])
    expect(await screen.findByTestId("plugins-section")).toHaveAttribute(
      "data-item",
      "itm_superpowers"
    )
    expect(screen.getByTestId("parked").textContent).toBe("clear")
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
  it("is the shared breadcrumb, named Harness Engineering", () => {
    render(
      <Intl>
        <HarnessViewProvider>
          <WorkbenchRouteProvider>
            <HarnessPageTitle />
          </WorkbenchRouteProvider>
        </HarnessViewProvider>
      </Intl>
    )

    expect(
      screen.getByRole("heading", { name: "Harness Engineering" })
    ).toBeTruthy()
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
        <HarnessViewProvider>
          <WorkbenchRouteProvider>
            <Enter />
            <Route />
            <HarnessPageTitle />
          </WorkbenchRouteProvider>
        </HarnessViewProvider>
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

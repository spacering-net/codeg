import { useEffect, useLayoutEffect } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import jaMessages from "@/i18n/messages/ja.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import zhTWMessages from "@/i18n/messages/zh-TW.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  openUrl: vi.fn(() => Promise.resolve()),
  mobile: false,
  desktop: true,
  remote: null as null | { connection: { name: string; base_url: string } },
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => (mocks.remote ? 7 : null),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => mocks.desktop,
  openUrl: mocks.openUrl,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => mocks.remote,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { DISCOVER_KIND_TOTALS } from "@/lib/harness/discover-state"
import { __resetHarnessStatusForTests } from "@/lib/harness/status"
import {
  backendError,
  rawAssistantDetail,
  rawConfig,
  rawDetail,
  rawList,
  rawPromptDetail,
  rawSummaries,
  rawSummary,
  rawVersions,
} from "@/lib/harness/test-fixtures"
import { __resetSrnAssetCacheForTests } from "@/lib/harness/use-srn-asset"
import { DiscoverSection } from "./discover-section"
import { SEARCH_DEBOUNCE_MS } from "./discover-toolbar"

// ─── A stand-in backend ───────────────────────────────────────────────

type Args = Record<string, string> | undefined
type Handler = (args: Args) => unknown

const backend: Record<string, Handler> = {}

function resetBackend() {
  for (const key of Object.keys(backend)) delete backend[key]
  Object.assign(backend, {
    harness_status: () => ({ enabled: true, origin: "https://spacering.net" }),
    harness_config: () => rawConfig(),
    harness_list: () => rawList(rawSummaries(3), null, 3),
    harness_item: (args: Args) => {
      const ref = args?.itemRef ?? ""
      return rawDetail({ ref, name: ref.split("/")[1] })
    },
    harness_versions: () => rawVersions(),
    harness_readme: () => "<p>About this item.</p>",
    harness_prompt: () => "Write a haiku about the sea.",
    srn_asset: () => ({ mime: "image/png", dataBase64: "AAAA" }),
  } satisfies Record<string, Handler>)
}

/** Every call of one command, as its arguments. */
const callsOf = (command: string) =>
  mocks.call.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Args)

const lastCallOf = (command: string) => {
  const calls = callsOf(command)
  return calls[calls.length - 1]
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─── Rendering ────────────────────────────────────────────────────────

const MESSAGES = {
  en: enMessages,
  ja: jaMessages,
  "zh-CN": zhCNMessages,
  "zh-TW": zhTWMessages,
} as const

type View = ReturnType<typeof useHarnessView>
let view: View

function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

/**
 * The kind totals as already read. They are asked for with the very request
 * the list's first page is (`harness_list` with the default filters), so a
 * test that counts the list's requests would count them too: they are taken
 * as known unless a test is about them.
 */
function SeedTotals() {
  const { slots } = useHarnessView()
  useLayoutEffect(() => {
    if (slots.get(DISCOVER_KIND_TOTALS).phase === "idle") {
      slots.set(DISCOVER_KIND_TOTALS, {
        phase: "ready",
        value: {},
        error: null,
        request: 0,
      })
    }
  }, [slots])
  return null
}

function Harness({
  show = true,
  locale = "en",
  totals = false,
}: {
  show?: boolean
  locale?: keyof typeof MESSAGES
  /** Let the section ask for the kind totals itself. */
  totals?: boolean
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES[locale] as unknown as typeof enMessages}
    >
      <HarnessViewProvider>
        <Capture />
        {!totals && <SeedTotals />}
        {show && <DiscoverSection />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

const cardTitles = () =>
  within(screen.getByRole("list", { name: "Results" }))
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent)

const searchBox = () =>
  screen.getByRole("textbox", { name: "Search SRN Harness" })

/** The pane that scrolls: the one that holds the list, or the detail. */
/** The element that scrolls: the viewport inside a `HarnessScroller`. */
const scroller = (inside: HTMLElement) =>
  inside.closest<HTMLElement>("[data-harness-scroller] > *")!

/**
 * A link's name matcher for an address. In a browser the name is the address
 * as shown; jsdom gives no element a `display`, so the name computed there is
 * split at each of the empty marks the address may break at (`MachineText`)
 * — by spaces an address never has, which are left out of the comparison.
 */
const addressNamed = (address: string) => (name: string) =>
  name.replace(/\s+/g, "") === address

// ─── The end of the list coming into view ─────────────────────────────

/**
 * An observer that reports the end of the list coming into view the way a
 * real one does: once. While the end stays in view it has nothing further to
 * say — only an observer created afterwards reports again.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  private targets = new Set<Element>()
  private reported = false
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    FakeIntersectionObserver.instances =
      FakeIntersectionObserver.instances.filter((entry) => entry !== this)
  }
  takeRecords() {
    return []
  }
  reach() {
    if (this.reported) return
    this.reported = true
    this.callback(
      [...this.targets].map(
        (target) =>
          ({ isIntersecting: true, target }) as IntersectionObserverEntry
      ),
      this as unknown as IntersectionObserver
    )
  }
}

/** Scroll the end of the list into view. */
function reachEnd() {
  act(() => {
    for (const observer of [...FakeIntersectionObserver.instances]) {
      observer.reach()
    }
  })
}

beforeEach(() => {
  localStorage.clear()
  mocks.mobile = false
  mocks.desktop = true
  mocks.remote = null
  mocks.openUrl.mockClear()
  resetBackend()
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
  __resetHarnessStatusForTests()
  __resetSrnAssetCacheForTests()
  FakeIntersectionObserver.instances = []
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  Object.assign(URL, {
    createObjectURL: () => "blob:test/avatar",
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ─── The list ─────────────────────────────────────────────────────────

describe("Discover — the list", () => {
  it("asks for the catalog on opening, every kind, most popular first", async () => {
    render(<Harness />)

    expect(await screen.findByText("Item 1")).toBeInTheDocument()
    expect(cardTitles()).toEqual(["Item 1", "Item 2", "Item 3"])
    expect(callsOf("harness_list")).toEqual([{ sort: "popular" }])
    expect(callsOf("harness_config")).toHaveLength(1)
    // Three items, and the count is said out loud as well as shown.
    expect(screen.getByRole("status")).toHaveTextContent("3 items")
  })

  it("shows what a card is for: publisher, stars, kind, runtime and marks", async () => {
    backend.harness_list = () =>
      rawList([
        rawSummary({ risk: "medium", status: "listed", repoStars: 194676 }),
      ])
    render(<Harness />)

    const card = (await screen.findByText("PDF Tools")).closest("li")!
    expect(within(card).getByText("Acme")).toBeInTheDocument()
    expect(
      within(card).getByText("Fill and sign PDF forms.")
    ).toBeInTheDocument()
    expect(within(card).getByText("Skill")).toBeInTheDocument()
    expect(within(card).getByText("Python")).toBeInTheDocument()
    expect(within(card).getByText("194.7K")).toBeInTheDocument()
    expect(within(card).getByText("GitHub stars")).toBeInTheDocument()
    expect(within(card).getByText("Medium risk")).toBeInTheDocument()
    expect(within(card).getByText("Listed only")).toBeInTheDocument()
  })

  it.each([
    ["skill", "none", "No code"],
    ["mcp", "remote", "Remote"],
    ["mcp", "bundle", "MCP bundle"],
    ["skill", "node", "Node.js"],
  ])("says where a %s with runtime %s runs", async (kind, runtime, label) => {
    backend.harness_list = () => rawList([rawSummary({ kind, runtime })])
    render(<Harness />)
    const card = (await screen.findByText("PDF Tools")).closest("li")!
    expect(within(card).getByText(label)).toBeInTheDocument()
  })

  it.each(["prompt", "assistant"])(
    "does not say a %s runs on anything",
    async (kind) => {
      backend.harness_list = () =>
        rawList([rawSummary({ kind, runtime: "none" })])
      render(<Harness />)
      const card = (await screen.findByText("PDF Tools")).closest("li")!
      expect(within(card).queryByText("No code")).toBeNull()
    }
  )

  it("marks only a risk worth marking, and never guesses at 'installed'", async () => {
    render(<Harness />)
    await screen.findByText("Item 1")

    expect(screen.queryByText("Low risk")).toBeNull()
    expect(screen.queryByText("Medium risk")).toBeNull()
    expect(screen.queryByText("Installed")).toBeNull()
    expect(screen.queryByText("Update available")).toBeNull()
    // And nothing to install with.
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull()
  })

  it("loads the publisher's picture through the backend, never from the site", async () => {
    const user = userEvent.setup()
    backend.harness_list = () => rawList([rawSummary()])
    const { container } = render(<Harness />)
    // The cards show the kind's glyph; the publisher's picture is the
    // detail's.
    await user.click(await screen.findByRole("button", { name: "PDF Tools" }))

    await waitFor(() =>
      expect(callsOf("srn_asset")).toEqual([
        { path: "/api/avatars/0199b5e2/4f1c2a9e.png" },
      ])
    )
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "blob:test/avatar"
      )
    )
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("src")).toMatch(/^blob:/)
    }
  })

  it("says so when nothing matches, which is not an error", async () => {
    backend.harness_list = () => rawList([], null, 0)
    render(<Harness />)

    // Shown, and said (the status line carries it too).
    expect(await screen.findAllByText("Nothing matches.")).toHaveLength(2)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches.")
  })

  it("shows the catalog's text as text, whatever it contains", async () => {
    const title = '<img src="x"> <b>Bold</b> &amp; <a href="#">link</a>'
    backend.harness_list = () =>
      rawList([
        rawSummary({
          title: { en: title },
          summary: { en: "<script>1</script><i>plain</i>" },
          publisher: { handle: "acme", name: "<u>Acme</u>", avatar: null },
        }),
      ])
    render(<Harness />)

    const heading = await screen.findByRole("heading", { level: 3 })
    expect(heading.textContent).toBe(title)
    const card = heading.closest("li")!
    expect(within(card).getByText("<u>Acme</u>")).toBeInTheDocument()
    expect(
      within(card).getByText("<script>1</script><i>plain</i>")
    ).toBeInTheDocument()
    expect(card.querySelector("img, b, a, script, i, u")).toBeNull()
  })
})

describe("Discover — titles follow the interface language", () => {
  const items = () =>
    rawList([
      rawSummary({ id: "1", ref: "acme/both" }),
      rawSummary({
        id: "2",
        ref: "acme/en-only",
        title: { en: "English only" },
      }),
      rawSummary({ id: "3", ref: "acme/zh-only", title: { zh: "只有中文" } }),
      rawSummary({
        id: "4",
        ref: "acme/untitled",
        name: "untitled",
        title: {},
      }),
    ])

  it.each([
    ["en", ["PDF Tools", "English only", "只有中文", "untitled"]],
    ["ja", ["PDF Tools", "English only", "只有中文", "untitled"]],
    ["zh-CN", ["PDF 工具", "English only", "只有中文", "untitled"]],
    ["zh-TW", ["PDF 工具", "English only", "只有中文", "untitled"]],
  ] as const)("%s", async (locale, expected) => {
    backend.harness_list = items
    render(<Harness locale={locale} />)
    await screen.findByText("untitled")
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    ).toEqual(expected)
  })
})

describe("Discover — unknown values from a newer catalog", () => {
  it("shows a kind and a risk it has never heard of as unknown", async () => {
    backend.harness_list = () =>
      rawList([
        rawSummary({
          kind: "widget",
          risk: "extreme",
          status: "embargoed",
          runtime: "wasm",
          source: "carrier-pigeon",
        }),
      ])
    render(<Harness />)

    const card = (await screen.findByText("PDF Tools")).closest("li")!
    expect(within(card).getByText("Unknown kind")).toBeInTheDocument()
    expect(within(card).getByText("Risk unknown")).toBeInTheDocument()
    // A runtime with no name here is shown as the catalog spells it.
    expect(within(card).getByText("wasm")).toBeInTheDocument()
  })

  it("opens such an item with the parts that hold for anything", async () => {
    const user = userEvent.setup()
    backend.harness_list = () => rawList([rawSummary({ kind: "widget" })])
    backend.harness_item = () =>
      rawDetail({
        kind: "widget",
        status: "embargoed",
        risk: "extreme",
        source: "carrier-pigeon",
        listedReasons: ["made_up_reason"],
        checks: {
          findings: [
            { check: "brand_new_check", severity: "catastrophic" },
            { check: "rule", severity: "medium", category: "network" },
          ],
          review: "telepathic",
          secrets: 0,
          dropped: [],
        },
      })
    backend.harness_versions = () => [
      { revision: 3, version: "1.2.0", status: "frozen", risk: "extreme" },
    ]
    render(<Harness />)

    await user.click(await screen.findByRole("button", { name: "PDF Tools" }))
    const detail = await screen.findByRole("article")

    expect(
      within(
        within(detail).getByRole("navigation", { name: "Breadcrumb" })
      ).getByText("Unknown kind")
    ).toBeInTheDocument()
    expect(within(detail).getAllByText("Unknown status").length).toBe(2)
    expect(within(detail).getAllByText("Risk unknown").length).toBeGreaterThan(
      0
    )
    expect(within(detail).getByText("brand_new_check")).toBeInTheDocument()
    expect(within(detail).getByText("Rule · network")).toBeInTheDocument()
    // The source it does not know is called unknown, not left blank.
    expect(within(detail).getByText("Unknown")).toBeInTheDocument()
    expect(
      await within(detail).findByText("About this item.")
    ).toBeInTheDocument()
  })
})

// ─── Search and filters ───────────────────────────────────────────────

describe("Discover — search as you type", () => {
  async function renderWithFakeTimers() {
    vi.useFakeTimers()
    render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(callsOf("harness_list")).toHaveLength(1)
  }

  const type = (value: string) =>
    fireEvent.change(searchBox(), { target: { value } })

  it("waits for a pause in typing, then asks once for the last text", async () => {
    await renderWithFakeTimers()

    type("p")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 100)
    })
    type("pd")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 100)
    })
    type("pdf")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    })
    expect(callsOf("harness_list")).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(callsOf("harness_list")).toEqual([{ sort: "popular" }, { q: "pdf" }])
  })

  it("does not query while an input method is composing", async () => {
    await renderWithFakeTimers()
    const input = searchBox()

    fireEvent.compositionStart(input)
    type("j")
    type("ji")
    type("jineng")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 4)
    })
    expect(callsOf("harness_list")).toHaveLength(1)

    type("技能")
    fireEvent.compositionEnd(input)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    })
    expect(callsOf("harness_list")).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(callsOf("harness_list")[1]).toEqual({ q: "技能" })
    expect(callsOf("harness_list")).toHaveLength(2)
  })

  it("holds back text typed just before a composition began", async () => {
    await renderWithFakeTimers()
    const input = searchBox()

    type("pdf")
    fireEvent.compositionStart(input)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    })
    expect(callsOf("harness_list")).toHaveLength(1)

    type("pdf 表单")
    fireEvent.compositionEnd(input)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    expect(callsOf("harness_list")[1]).toEqual({ q: "pdf 表单" })
  })

  it("leaves the Enter that confirms a composition to the input method", async () => {
    await renderWithFakeTimers()
    const input = searchBox()

    fireEvent.compositionStart(input)
    type("jineng")
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(callsOf("harness_list")).toHaveLength(1)
  })

  it("applies at once on Enter, and on clearing", async () => {
    await renderWithFakeTimers()

    type("pdf")
    fireEvent.keyDown(searchBox(), { key: "Enter" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(callsOf("harness_list")[1]).toEqual({ q: "pdf" })
    // The pause that was running does not ask a second time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    })
    expect(callsOf("harness_list")).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(searchBox()).toHaveValue("")
    expect(callsOf("harness_list")[2]).toEqual({ sort: "popular" })
  })

  it("shows the answer to the last text even when an earlier one arrives after it", async () => {
    await renderWithFakeTimers()
    const first = deferred()
    const second = deferred()
    backend.harness_list = (args) =>
      args?.q === "p" ? first.promise : second.promise

    type("p")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })
    type("pdf")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })

    await act(async () => {
      second.resolve(rawList([rawSummary({ title: { en: "For pdf" } })]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cardTitles()).toEqual(["For pdf"])

    await act(async () => {
      first.resolve(rawList([rawSummary({ title: { en: "For p" } })]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cardTitles()).toEqual(["For pdf"])
  })
})

describe("Discover — kinds, filters and sort", () => {
  it("offers the five kinds and 'All', and narrows the list at once", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 1")

    const kinds = screen.getByRole("radiogroup", { name: "Kind" })
    expect(
      within(kinds)
        .getAllByRole("radio")
        .map((radio) => radio.textContent)
    ).toEqual(["All", "Skills", "MCP", "Prompts", "Assistants", "Plugins"])
    expect(within(kinds).getByRole("radio", { name: "All" })).toBeChecked()

    await user.click(within(kinds).getByRole("radio", { name: "MCP" }))
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({
        kind: "mcp",
        sort: "popular",
      })
    )
    expect(within(kinds).getByRole("radio", { name: "MCP" })).toBeChecked()

    // Pressing the chosen kind again does not leave the list without one.
    await user.click(within(kinds).getByRole("radio", { name: "MCP" }))
    expect(within(kinds).getByRole("radio", { name: "MCP" })).toBeChecked()
    expect(callsOf("harness_list")).toHaveLength(2)

    for (const [name, kind] of [
      ["Skills", "skill"],
      ["Prompts", "prompt"],
      ["Assistants", "assistant"],
      ["Plugins", "plugin"],
    ] as const) {
      await user.click(within(kinds).getByRole("radio", { name }))
      await waitFor(() =>
        expect(lastCallOf("harness_list")).toEqual({
          kind,
          sort: "popular",
        })
      )
    }
  })

  it("takes its tags and runtimes from the catalog's configuration", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 1")

    await user.click(await screen.findByRole("combobox", { name: "Tag" }))
    const tags = await screen.findByRole("listbox")
    expect(
      within(tags)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["All tags", "Databases", "Files"])
    await user.click(within(tags).getByRole("option", { name: "Files" }))
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({
        tag: "files",
        sort: "popular",
      })
    )

    await user.click(screen.getByRole("combobox", { name: "Runs on" }))
    const runtimes = await screen.findByRole("listbox")
    expect(
      within(runtimes)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Any runtime", "Node.js", "Python", "Remote"])
    await user.click(within(runtimes).getByRole("option", { name: "Node.js" }))
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({
        tag: "files",
        runtime: "node",
        sort: "popular",
      })
    )
  })

  it("sorts by popular, new or recently updated", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 1")

    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    const sorts = await screen.findByRole("listbox")
    expect(
      within(sorts)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Popular", "New", "Recently updated"])
    await user.click(
      within(sorts).getByRole("option", { name: "Recently updated" })
    )
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({ sort: "updated" })
    )
  })

  it("has no filters to offer until the configuration has loaded", async () => {
    backend.harness_config = () => {
      throw backendError("network")
    }
    render(<Harness />)
    await screen.findByText("Item 1")

    expect(screen.queryByRole("combobox", { name: "Tag" })).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Runs on" })).toBeNull()
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeInTheDocument()
  })

  it("says the filters could not be loaded, and asks again on Retry", async () => {
    const user = userEvent.setup()
    backend.harness_config = () => {
      throw backendError("network")
    }
    render(<Harness />)
    await screen.findByText("Item 1")
    const failed = await screen.findByText("The filters could not be loaded.")
    expect(failed).toBeInTheDocument()
    // The rest of Discover works without them.
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeEnabled()
    expect(callsOf("harness_config")).toHaveLength(1)

    backend.harness_config = () => rawConfig()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      await screen.findByRole("combobox", { name: "Tag" })
    ).toBeInTheDocument()
    expect(callsOf("harness_config")).toHaveLength(2)
    expect(screen.queryByText("The filters could not be loaded.")).toBeNull()
    // The list was not asked for again.
    expect(callsOf("harness_list")).toHaveLength(1)
  })

  it("orders matches best first, and says so, while there is search text", async () => {
    vi.useFakeTimers()
    render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.change(searchBox(), { target: { value: "pdf" } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    })

    const sort = screen.getByRole("combobox", { name: "Sort" })
    expect(sort).toBeDisabled()
    expect(sort).toHaveTextContent("Best match")
  })
})

// ─── Paging ───────────────────────────────────────────────────────────

describe("Discover — the heading, the counts and the layout", () => {
  const TOTALS: Record<string, number> = {
    skill: 1360,
    mcp: 26392,
    prompt: 475,
    assistant: 631,
    plugin: 61,
  }

  it("asks how much there is of each kind, once, and says so", async () => {
    backend.harness_list = (args) =>
      rawList(rawSummaries(3), null, args?.kind ? TOTALS[args.kind] : 28858)
    render(<Harness totals />)
    await screen.findByText("Item 1")

    const kinds = screen.getByRole("radiogroup", { name: "Kind" })
    await waitFor(() =>
      expect(
        within(kinds)
          .getAllByRole("radio")
          .map((radio) => radio.textContent)
      ).toEqual([
        "All28,858",
        "Skills1,360",
        "MCP26,392",
        "Prompts475",
        "Assistants631",
        "Plugins61",
      ])
    )
    // As the list asks for a kind's first page — so the backend's cache
    // answers the list when that kind is picked.
    expect(callsOf("harness_list")).toEqual(
      expect.arrayContaining([
        { sort: "popular" },
        { kind: "skill", sort: "popular" },
        { kind: "mcp", sort: "popular" },
        { kind: "prompt", sort: "popular" },
        { kind: "assistant", sort: "popular" },
        { kind: "plugin", sort: "popular" },
      ])
    )
    expect(
      screen.getByText(/^28,858 community skills, plugins, MCP servers/)
    ).toBeInTheDocument()
  })

  it("leaves the counts out while a search narrows the list", async () => {
    const user = userEvent.setup()
    backend.harness_list = (args) =>
      rawList(rawSummaries(3), null, args?.kind ? TOTALS[args.kind] : 28858)
    render(<Harness totals />)
    const kinds = screen.getByRole("radiogroup", { name: "Kind" })
    await within(kinds).findByText("1,360")

    await user.type(searchBox(), "pdf")

    expect(within(kinds).queryByText("1,360")).toBeNull()
    expect(
      within(kinds)
        .getAllByRole("radio")
        .map((radio) => radio.textContent)
    ).toEqual(["All", "Skills", "MCP", "Prompts", "Assistants", "Plugins"])
  })

  it("says nothing of the size when the counts cannot be had", async () => {
    backend.harness_list = (args) => {
      if (args?.kind) throw backendError("network")
      return rawList(rawSummaries(3), null, null)
    }
    render(<Harness totals />)
    await screen.findByText("Item 1")

    expect(
      screen.getByText(/^Community skills, plugins, MCP servers/)
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("lays the results out as a grid or a list, and remembers which", async () => {
    const user = userEvent.setup()
    const first = render(<Harness />)
    await screen.findByText("Item 1")
    const layout = screen.getByRole("radiogroup", { name: "Layout" })
    expect(within(layout).getByRole("radio", { name: "Grid" })).toBeChecked()

    await user.click(within(layout).getByRole("radio", { name: "List" }))

    expect(within(layout).getByRole("radio", { name: "List" })).toBeChecked()
    expect(cardTitles()).toEqual(["Item 1", "Item 2", "Item 3"])
    expect(localStorage.getItem("workspace:harness-discover-layout")).toBe(
      "list"
    )
    first.unmount()

    render(<Harness />)
    await screen.findByText("Item 1")
    expect(screen.getByRole("radio", { name: "List" })).toBeChecked()
  })

  it("takes the focus to the search box on /", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 1")

    await user.keyboard("/")

    expect(searchBox()).toHaveFocus()
    // Typed into the box, a slash is only a slash.
    await user.keyboard("/")
    expect(searchBox()).toHaveValue("/")
  })

  it("counts the results it shows", async () => {
    backend.harness_list = () => rawList(rawSummaries(3), "next", 1234)
    render(<Harness />)
    await screen.findByText("Item 1")

    expect(screen.getByText("1,234").closest("p")).toHaveTextContent(
      "1,234 items"
    )
  })
})

describe("Discover — the next page", () => {
  beforeEach(() => {
    backend.harness_list = (args) => {
      if (!args?.cursor) return rawList(rawSummaries(2), "page-2", 5)
      if (args.cursor === "page-2") {
        return rawList(rawSummaries(2, 3), "page-3", 5)
      }
      return rawList(rawSummaries(1, 5), null, 5)
    }
  })

  it("loads when the end of the list comes into view, until there is no more", async () => {
    render(<Harness />)
    await screen.findByText("Item 2")
    expect(cardTitles()).toHaveLength(2)

    reachEnd()
    await screen.findByText("Item 4")
    expect(lastCallOf("harness_list")).toEqual({
      sort: "popular",
      cursor: "page-2",
    })
    expect(screen.getByRole("status")).toHaveTextContent("2 more loaded")

    reachEnd()
    await screen.findByText("Item 5")
    expect(cardTitles()).toEqual([
      "Item 1",
      "Item 2",
      "Item 3",
      "Item 4",
      "Item 5",
    ])
    expect(screen.getByText("That is everything.")).toBeInTheDocument()

    // Nothing is watching for a page that does not exist.
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
    expect(callsOf("harness_list")).toHaveLength(3)
  })

  it("asks once per page, however often the end is reached meanwhile", async () => {
    const page = deferred()
    backend.harness_list = (args) =>
      args?.cursor ? page.promise : rawList(rawSummaries(2), "page-2", 5)
    render(<Harness />)
    await screen.findByText("Item 2")

    reachEnd()
    reachEnd()
    reachEnd()
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Loading more…")
    )
    expect(callsOf("harness_list")).toHaveLength(2)

    await act(async () => {
      page.resolve(rawList(rawSummaries(2, 3), null, 4))
    })
    await screen.findByText("Item 4")
    expect(callsOf("harness_list")).toHaveLength(2)
  })

  it("carries on past a page that has nothing to show", async () => {
    backend.harness_list = (args) => {
      if (!args?.cursor) return rawList(rawSummaries(2), "page-2", 5)
      if (args.cursor === "page-2") {
        // Connectors only: none of them becomes a card.
        return rawList(
          [rawSummary({ id: "c1", ref: "acme/conn", kind: "connector" })],
          "page-3",
          5
        )
      }
      return rawList(rawSummaries(2, 3), null, 5)
    }
    render(<Harness />)
    await screen.findByText("Item 2")

    reachEnd()
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({
        sort: "popular",
        cursor: "page-2",
      })
    )
    // The end is still in view, and something is still watching it.
    await waitFor(() =>
      expect(FakeIntersectionObserver.instances).toHaveLength(1)
    )
    reachEnd()
    await screen.findByText("Item 4")
    expect(cardTitles()).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"])
  })

  it("offers a button for the next page as well", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 2")

    await user.click(screen.getByRole("button", { name: "Load more" }))
    await screen.findByText("Item 4")
  })

  it("keeps the list when a page fails, with a way to ask again", async () => {
    const user = userEvent.setup()
    let failing = true
    backend.harness_list = (args) => {
      if (!args?.cursor) return rawList(rawSummaries(2), "page-2", 4)
      if (failing) throw backendError("network")
      return rawList(rawSummaries(2, 3), null, 4)
    }
    render(<Harness />)
    await screen.findByText("Item 2")

    reachEnd()
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("SRN Harness could not be reached.")
    expect(cardTitles()).toEqual(["Item 1", "Item 2"])

    failing = false
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    await screen.findByText("Item 4")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

// ─── Failures ─────────────────────────────────────────────────────────

describe("Discover — when the catalog cannot be shown", () => {
  it("shows the failure and a Retry that asks again", async () => {
    const user = userEvent.setup()
    let online = false
    backend.harness_list = () => {
      if (!online) throw backendError("network")
      return rawList(rawSummaries(2))
    }
    render(<Harness />)

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      "SRN Harness could not be reached. Check the connection and try again."
    )
    expect(screen.queryByRole("list", { name: "Results" })).toBeNull()

    online = true
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    await screen.findByText("Item 1")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it.each([
    [
      "a rate limit, with how long to wait",
      backendError("rateLimited", { seconds: "42" }),
      "Too many requests. Try again in 42 seconds.",
      true,
    ],
    [
      "a rate limit of one second",
      backendError("rateLimited", { seconds: "1" }),
      "Too many requests. Try again in 1 second.",
      true,
    ],
    [
      "a server error, with its status",
      backendError("server", { status: "503" }),
      "SRN Harness answered with an error (503). Try again in a moment.",
      true,
    ],
    [
      "an answer that is too large",
      backendError("tooLarge"),
      "The answer from SRN Harness is larger than Codeg accepts.",
      true,
    ],
    [
      "an answer that cannot be read",
      backendError("invalidResponse"),
      "SRN Harness sent an answer this Codeg cannot read. Updating Codeg may help.",
      true,
    ],
    [
      "the catalog switched off",
      backendError("disabled"),
      "Discover is switched off on this Codeg.",
      false,
    ],
    [
      "an address the catalog does not have",
      backendError("notFound"),
      "SRN Harness has no item at this address. It may have been renamed or removed.",
      false,
    ],
    [
      "a malformed address",
      backendError("invalidRef"),
      "That is not a SRN Harness address. An address looks like publisher/name.",
      false,
    ],
  ] as const)("says %s", async (_what, error, message, retryable) => {
    backend.harness_list = () => {
      throw error
    }
    render(<Harness />)

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(message)
    expect(
      within(alert).queryByRole("button", { name: "Retry" }) !== null
    ).toBe(retryable)
  })

  it("shows a failure it has no words for with the text it came with", async () => {
    backend.harness_list = () => {
      throw new Error("Request timed out")
    }
    render(<Harness />)

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("SRN Harness could not be loaded.")
    expect(alert).toHaveTextContent("Request timed out")
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled()
  })

  it("reads an answer that is not a list as one it cannot read", async () => {
    backend.harness_list = () => "<html>not json</html>"
    render(<Harness />)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SRN Harness sent an answer this Codeg cannot read."
    )
  })
})

describe("Discover — a backend too old to have the commands", () => {
  const tooOld = () => {
    throw {
      code: "not_implemented",
      message: "API endpoint is not available in web mode",
    }
  }

  beforeEach(() => {
    for (const command of Object.keys(backend)) backend[command] = tooOld
  })

  it("says this Codeg needs updating, in the local window", async () => {
    render(<Harness />)
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      "This Codeg is too old for SRN Harness. Update it to browse the catalog."
    )
    // Asking again cannot help, and nothing else is drawn around it.
    expect(within(alert).queryByRole("button")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("says the remote Codeg needs updating, in a remote workspace window", async () => {
    mocks.remote = {
      connection: { name: "build box", base_url: "https://10.0.0.5:3080" },
    }
    backend.harness_status = () => {
      throw {
        code: "network_error",
        message: "Remote returned HTTP 501 Not Implemented",
      }
    }
    render(<Harness />)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Codeg on the remote host is too old for SRN Harness. Update it there to browse the catalog."
    )
  })

  it("says the server needs updating, in a browser", async () => {
    mocks.desktop = false
    render(<Harness />)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Codeg server is too old for SRN Harness. Update the server to browse the catalog."
    )
  })
})

// ─── The detail ───────────────────────────────────────────────────────

describe("Discover — an item's detail", () => {
  async function openFirst(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "PDF Tools" }))
    return screen.findByRole("article")
  }

  beforeEach(() => {
    backend.harness_list = () => rawList([rawSummary()])
  })

  it("opens in the list's place, with the focus on its heading", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const detail = await openFirst(user)

    expect(screen.queryByRole("list", { name: "Results" })).toBeNull()
    expect(
      screen.queryByRole("textbox", { name: "Search SRN Harness" })
    ).toBeNull()
    const heading = within(detail).getByRole("heading", { level: 2 })
    expect(heading).toHaveTextContent("PDF Tools")
    expect(heading).toHaveFocus()
    expect(callsOf("harness_item")).toEqual([{ itemRef: "acme/pdf-tools" }])
  })

  it("shows the heading from what the list knew while the item loads", async () => {
    const user = userEvent.setup()
    const item = deferred()
    backend.harness_item = () => item.promise
    render(<Harness />)
    const detail = await openFirst(user)

    expect(detail).toHaveAttribute("aria-busy", "true")
    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent(
      "PDF Tools"
    )
    expect(
      within(detail).getByText("Fill and sign PDF forms.")
    ).toBeInTheDocument()
    expect(within(detail).getByText("Acme")).toBeInTheDocument()

    // The facts card holds its place until the facts are in, with as many
    // rows as it will have; the actions hold theirs, as many as will come.
    const facts = within(detail).getByTestId("discover-facts-loading")
    const placeholderRows = facts.querySelectorAll(".divide-y > div").length
    expect(
      within(detail).getAllByTestId("discover-action-loading")
    ).toHaveLength(1)

    await act(async () => {
      item.resolve(rawDetail())
    })
    await within(detail).findByText("Apache-2.0")
    expect(detail).toHaveAttribute("aria-busy", "false")
    expect(within(detail).queryByTestId("discover-facts-loading")).toBeNull()
    expect(within(detail).queryByTestId("discover-action-loading")).toBeNull()
    // All but the website's row, which the list's card does not tell.
    expect(detail.querySelectorAll("dl > div")).toHaveLength(
      placeholderRows + 1
    )
  })

  it("shows a skill in full", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawDetail({
        risk: "medium",
        reviewed: true,
        checks: {
          findings: [
            {
              check: "executable_binary",
              severity: "medium",
              path: "bin/tool",
              line: 3,
            },
            { check: "long_line", severity: "low", path: "SKILL.md" },
            { check: "blank_lines", severity: "low" },
          ],
          review: "off",
          secrets: 2,
          dropped: [{ path: "node_modules/big.bin", reason: "size" }],
        },
      })
    render(<Harness />)
    const detail = await openFirst(user)

    // Breadcrumb: the kind. Heading: risk, publisher, stars, date.
    expect(
      within(
        within(detail).getByRole("navigation", { name: "Breadcrumb" })
      ).getByText("Skill")
    ).toBeInTheDocument()
    expect(within(detail).getAllByText("Medium risk").length).toBeGreaterThan(0)
    expect(within(detail).getByText("1.2K")).toBeInTheDocument()

    // Particulars.
    const facts = within(detail).getByRole("region", { name: "Details" })
    expect(within(facts).getByText("1.2.0")).toBeInTheDocument()
    expect(within(facts).getByText("#3")).toBeInTheDocument()
    expect(within(facts).getByText("Apache-2.0")).toBeInTheDocument()
    expect(within(facts).getByText("Python")).toBeInTheDocument()
    expect(within(facts).getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/skills/tree/abc123/pdf-tools"
    )
    expect(
      within(facts).getByRole("link", {
        name: addressNamed("github.com/acme/skills"),
      })
    ).toHaveAttribute("href", "https://github.com/acme/skills")
    expect(
      within(facts).getByRole("link", { name: addressNamed("acme.example") })
    ).toHaveAttribute("href", "https://acme.example/")

    // Description, through the allowlist.
    const description = within(detail).getByRole("region", {
      name: "Description",
    })
    expect(
      await within(description).findByText("About this item.")
    ).toBeInTheDocument()

    // Permissions: declared beside detected, the undeclared one marked.
    const permissions = within(detail).getByRole("table", {
      name: "Permissions",
    })
    expect(
      within(permissions)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual(["Permissions", "Declared", "Detected"])
    const network = within(permissions)
      .getByRole("rowheader", { name: "Network" })
      .closest('[role="row"]') as HTMLElement
    const [declared, detected] = within(network).getAllByRole("cell")
    expect(declared).toHaveTextContent("api.acme.example")
    expect(detected).toHaveTextContent("api.acme.example")
    expect(detected).toHaveTextContent("telemetry.acme.example (not declared)")
    const runsCode = within(permissions)
      .getByRole("rowheader", { name: "Runs code" })
      .closest('[role="row"]') as HTMLElement
    // A row the publisher said nothing about is not the same as "none".
    expect(within(runsCode).getAllByRole("cell")[0]).toHaveTextContent(
      "Not stated"
    )
    expect(within(runsCode).getAllByRole("cell")[1]).toHaveTextContent("python")
    const paths = within(permissions)
      .getByRole("rowheader", { name: "Outside the workspace" })
      .closest('[role="row"]') as HTMLElement
    expect(within(paths).getAllByRole("cell")[1]).toHaveTextContent("None")

    // Checks, in short.
    const checks = within(detail).getByRole("region", { name: "Checks" })
    expect(checks).toHaveTextContent(
      "Some things deserve a look before you install it."
    )
    expect(checks).toHaveTextContent("Reviewed by a person")
    expect(checks).toHaveTextContent(
      "Checked by rules; the model review is not switched on yet."
    )
    expect(within(checks).getByText("Executable file")).toBeInTheDocument()
    expect(within(checks).getByText("bin/tool:3")).toBeInTheDocument()
    expect(checks).toHaveTextContent("2 minor marks")
    expect(checks).toHaveTextContent("2 credentials found in the source")
    expect(within(checks).getByText("node_modules/big.bin")).toBeInTheDocument()

    // Files and versions.
    const files = within(detail).getByRole("region", { name: "Files" })
    expect(files).toHaveTextContent("2 files · 7.1 KB")
    expect(within(files).getByText("SKILL.md")).toBeInTheDocument()
    expect(within(files).getByText("scripts/fill.py")).toBeInTheDocument()
    expect(within(files).getByText("executable")).toBeInTheDocument()
    const versions = within(detail).getByRole("region", { name: "Versions" })
    expect(await within(versions).findByText("latest")).toBeInTheDocument()
    expect(within(versions).getByText("Yanked")).toBeInTheDocument()
    expect(within(versions).getAllByRole("listitem")).toHaveLength(2)

    // Installing opens a dialog that asks first; nothing claims it is
    // installed while the host has not said so.
    expect(
      within(detail).getByRole("button", { name: "Install" })
    ).toBeInTheDocument()
    expect(within(detail).queryByText("Installed")).toBeNull()
  })

  it("shows an MCP server's packages and endpoints", async () => {
    const user = userEvent.setup()
    backend.harness_list = () => rawList([rawSummary({ kind: "mcp" })])
    backend.harness_item = () => {
      const base = rawDetail({ kind: "mcp", readme: null })
      return {
        ...base,
        install: {
          ...(base.install as object),
          files: [],
          server: {
            name: "com.acme/pdf-tools",
            remotes: [
              { type: "streamable-http", url: "https://api.acme.example/mcp" },
              { type: "sse" },
              "not a remote",
            ],
          },
          packages: [
            {
              registryType: "npm",
              identifier: "@acme/pdf-mcp",
              version: "1.2.3",
              verified: "ok",
              hasInstallScript: true,
            },
            {
              registryType: "pypi",
              identifier: "acme-pdf",
              version: null,
              verified: "missing",
            },
            { registryType: "oci", identifier: "acme/pdf", verified: "later" },
          ],
        },
      }
    }
    render(<Harness />)
    const detail = await openFirst(user)

    const server = await within(detail).findByRole("region", { name: "Server" })
    expect(within(server).getByText("@acme/pdf-mcp@1.2.3")).toBeInTheDocument()
    expect(within(server).getByText("Version verified")).toBeInTheDocument()
    expect(
      within(server).getByText("Runs an install script")
    ).toBeInTheDocument()
    expect(within(server).getByText("acme-pdf")).toBeInTheDocument()
    expect(within(server).getByText("Version not found")).toBeInTheDocument()
    expect(within(server).getByText("Check unknown")).toBeInTheDocument()
    // An endpoint is text, not a page to open.
    expect(
      within(server).getByText("https://api.acme.example/mcp")
    ).toBeInTheDocument()
    expect(within(server).queryByRole("link")).toBeNull()
    // No description to fetch, and no file list to show.
    expect(callsOf("harness_readme")).toHaveLength(0)
    expect(within(detail).queryByRole("region", { name: "Files" })).toBeNull()
    expect(
      within(detail).getByRole("table", { name: "Permissions" })
    ).toBeInTheDocument()
  })

  it.each(["prompt", "assistant"] as const)(
    "shows a %s's common parts",
    async (kind) => {
      const user = userEvent.setup()
      backend.harness_list = () => rawList([rawSummary({ kind })])
      backend.harness_item = () => rawDetail({ kind })
      render(<Harness />)
      const detail = await openFirst(user)

      expect(
        within(detail).getByRole("heading", { level: 2 })
      ).toHaveTextContent("PDF Tools")
      expect(within(detail).getByText("Acme")).toBeInTheDocument()
      expect(
        await within(detail).findByRole("region", { name: "Details" })
      ).toBeInTheDocument()
      expect(
        within(detail).getByRole("region", { name: "Versions" })
      ).toBeInTheDocument()
      expect(
        within(detail).getByRole("link", {
          name: addressNamed("github.com/acme/skills"),
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("link", { name: "View on the website" })
      ).toBeInTheDocument()
      // A skill's files are not borrowed: a prompt's package is one
      // PROMPT.md, an assistant's its one definition. A prompt runs nothing,
      // so it has no permissions either; an assistant's are its tools.
      expect(within(detail).queryByRole("region", { name: "Files" })).toBeNull()
      expect(
        within(detail).queryByRole("table", { name: "Permissions" })
      ).toEqual(kind === "assistant" ? expect.anything() : null)
      // Text and definitions run on nothing: no "runs on" to state.
      expect(within(detail).queryByText("Runs on")).toBeNull()
    }
  )

  it("says why a listed-only item is not browsed", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawDetail({
        status: "listed",
        listedReasons: ["no_repository", "package_missing"],
      })
    render(<Harness />)
    const detail = await openFirst(user)

    expect(
      await within(detail).findByText(
        "Reachable by its address and exact name, but not browsed, ranked or recommended:"
      )
    ).toBeInTheDocument()
    expect(within(detail).getByText("no source repository")).toBeInTheDocument()
    expect(
      within(detail).getByText("its package version does not exist")
    ).toBeInTheDocument()
  })

  it("links to the item's page on the website, in the reader's language", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFirst(user)

    const link = screen.getByRole("link", { name: "View on the website" })
    expect(link).toHaveAttribute(
      "href",
      "https://spacering.net/harness/acme/pdf-tools"
    )
    await user.click(link)
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://spacering.net/harness/acme/pdf-tools"
    )
  })

  it("uses the Chinese page for a Chinese interface", async () => {
    const user = userEvent.setup()
    render(<Harness locale="zh-TW" />)
    await user.click(await screen.findByRole("button", { name: "PDF 工具" }))
    await screen.findByRole("article")

    expect(screen.getByRole("link", { name: "在網站上檢視" })).toHaveAttribute(
      "href",
      "https://spacering.net/zh/harness/acme/pdf-tools"
    )
  })

  it("links nothing whose address is not https", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawDetail({
        repositoryUrl: "http://github.com/acme/skills",
        websiteUrl: "javascript:void(0)",
        sourceUrl: "ftp://files.acme.example/pdf-tools",
      })
    render(<Harness />)
    const detail = await openFirst(user)

    const facts = await within(detail).findByRole("region", { name: "Details" })
    expect(within(facts).queryByRole("link")).toBeNull()
    // Still said, as text.
    expect(within(facts).getByText("GitHub")).toBeInTheDocument()
    expect(
      within(facts).getByText("http://github.com/acme/skills")
    ).toBeInTheDocument()
  })

  it("breaks an address only after a slash, and a value between its parts", async () => {
    const user = userEvent.setup()
    backend.harness_item = () =>
      rawDetail({
        repositoryUrl: "https://github.com/browser-use/browser-use",
        permissions: {
          declared: {},
          detected: {
            runsCode: [],
            installs: ["pypi:browser-use@0.13.11"],
            installScripts: [],
            network: [],
            secrets: ["X-Browser-Use-API-Key"],
            paths: [],
            tools: [],
          },
        },
      })
    render(<Harness />)
    const detail = await openFirst(user)

    // Where a line may break ("|"), and where it may not by itself ("~").
    const cuts = (element: Element) =>
      Array.from(element.childNodes)
        .map((node) =>
          node.nodeType === Node.TEXT_NODE
            ? node.textContent
            : (node as Element).classList.contains("wrap-point")
              ? "|"
              : (node as Element).classList.contains("wrap-hold")
                ? "~"
                : "?"
        )
        .join("")

    const facts = await within(detail).findByRole("region", { name: "Details" })
    const repository = within(facts).getByRole("link", {
      name: addressNamed("github.com/browser-use/browser-use"),
    })
    const address = within(repository).getByText(
      "github.com/browser-use/browser-use"
    )
    // Never at the hyphen inside a name, which the browser would break at.
    expect(cuts(address)).toBe("github.~com/|browser-~use/|browser-~use")
    // A name longer than the panel still breaks rather than spill out of it.
    expect(address).toHaveClass("[overflow-wrap:anywhere]")
    expect(repository).toHaveClass("max-w-full")
    expect(repository.textContent).toBe("github.com/browser-use/browser-use")

    const permissions = within(detail).getByRole("table", {
      name: "Permissions",
    })
    const installs = within(permissions).getByText("pypi:browser-use@0.13.11")
    expect(cuts(installs)).toBe("pypi:|browser-|use@|0.13.11")
    // Broken where it has to be only when a part is longer than the line —
    // not at any character, which is what `break-all` did.
    expect(installs).toHaveClass("[overflow-wrap:anywhere]")
    expect(installs).not.toHaveClass("break-all")
    expect(cuts(within(permissions).getByText("X-Browser-Use-API-Key"))).toBe(
      "X-|Browser-|Use-|API-|Key"
    )
  })

  it("renders the description through the allowlist", async () => {
    const user = userEvent.setup()
    backend.harness_readme = () =>
      '<h1>PDF Tools</h1><p onclick="run()" style="color:red">Fills forms.</p>' +
      '<script>run()</script><img src="https://example.com/p.png">' +
      '<a href="https://example.com/docs">Docs</a> <a href="http://example.com">Old</a>'
    render(<Harness />)
    const detail = await openFirst(user)

    const description = within(detail).getByRole("region", {
      name: "Description",
    })
    const paragraph = await within(description).findByText("Fills forms.")
    expect(paragraph.getAttributeNames()).toEqual(["class"])
    expect(
      description.querySelector("script, img, [style], [onclick]")
    ).toBeNull()
    expect(
      within(description)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual(["https://example.com/docs"])
    // The opening heading repeats the page's own, and is left out.
    expect(within(description).queryByText("PDF Tools")).toBeNull()
  })

  it("lets the description or the versions fail without taking the item with them", async () => {
    const user = userEvent.setup()
    let failing = true
    backend.harness_readme = () => {
      if (failing) throw backendError("network")
      return "<p>Back again.</p>"
    }
    backend.harness_versions = () => {
      throw backendError("server", { status: "500" })
    }
    render(<Harness />)
    const detail = await openFirst(user)

    const description = within(detail).getByRole("region", {
      name: "Description",
    })
    const alert = await within(description).findByRole("alert")
    expect(alert).toHaveTextContent("SRN Harness could not be reached.")
    expect(
      await within(
        within(detail).getByRole("region", { name: "Versions" })
      ).findByRole("alert")
    ).toHaveTextContent("answered with an error (500)")
    expect(within(detail).getByText("Apache-2.0")).toBeInTheDocument()

    failing = false
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(
      await within(description).findByText("Back again.")
    ).toBeInTheDocument()
  })

  it("points at the source for a description Harness may not keep", async () => {
    const user = userEvent.setup()
    backend.harness_item = () => {
      const base = rawDetail({ readme: null })
      return {
        ...base,
        install: {
          ...(base.install as object),
          archive: null,
          source: {
            repository: "acme/skills",
            commit: "683bc88e",
            path: "pdf-tools",
          },
        },
      }
    }
    render(<Harness />)
    const detail = await openFirst(user)

    const description = await within(detail).findByRole("region", {
      name: "Description",
    })
    expect(description).toHaveTextContent(
      "Its license does not let SRN Harness keep a copy"
    )
    expect(
      within(description).getByRole("link", { name: "Open the source" })
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/skills/tree/683bc88e/pdf-tools"
    )
    expect(callsOf("harness_readme")).toHaveLength(0)
  })
})

describe("Discover — long parts of a detail", () => {
  /** jsdom lays nothing out; say how tall a description came out. */
  function stubDescriptionHeight(height: number): () => void {
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollHeight"
    )
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get: () => height,
    })
    return () => {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollHeight", original)
      }
    }
  }

  async function openItem(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Item 1" }))
    const detail = await screen.findByRole("article")
    await within(detail).findByText("About this item.")
    return detail
  }

  it("shows a short description whole, with nothing to unfold", async () => {
    const user = userEvent.setup()
    const restore = stubDescriptionHeight(200)
    try {
      render(<Harness />)
      const detail = await openItem(user)
      expect(
        within(detail).queryByRole("button", { name: "Show all" })
      ).toBeNull()
    } finally {
      restore()
    }
  })

  it("folds a long description, and unfolds it on request", async () => {
    const user = userEvent.setup()
    const restore = stubDescriptionHeight(4000)
    try {
      render(<Harness />)
      const detail = await openItem(user)

      const toggle = within(detail).getByRole("button", { name: "Show all" })
      expect(toggle).toHaveAttribute("aria-expanded", "false")
      const content = document.getElementById(
        toggle.getAttribute("aria-controls")!
      )!
      expect(content).toContainElement(
        within(detail).getByText("About this item.")
      )
      expect(content.style.maxHeight).toBe("26rem")

      await user.click(toggle)
      expect(
        within(detail).getByRole("button", { name: "Show less" })
      ).toHaveAttribute("aria-expanded", "true")
      expect(content.style.maxHeight).toBe("")

      await user.click(
        within(detail).getByRole("button", { name: "Show less" })
      )
      expect(content.style.maxHeight).toBe("26rem")
    } finally {
      restore()
    }
  })

  it("unfolds when the focus moves into the part that is cut off", async () => {
    const user = userEvent.setup()
    const restore = stubDescriptionHeight(4000)
    backend.harness_readme = () =>
      '<p>About this item.</p><p><a href="https://example.com/docs">Docs</a></p>'
    try {
      render(<Harness />)
      const detail = await openItem(user)
      expect(
        within(detail).getByRole("button", { name: "Show all" })
      ).toBeInTheDocument()

      act(() => within(detail).getByRole("link", { name: "Docs" }).focus())
      expect(
        within(detail).getByRole("button", { name: "Show less" })
      ).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it("keeps what was unfolded across a trip away, and folds again for another item", async () => {
    const user = userEvent.setup()
    const restore = stubDescriptionHeight(4000)
    try {
      const page = render(<Harness />)
      const detail = await openItem(user)
      await user.click(within(detail).getByRole("button", { name: "Show all" }))

      page.rerender(<Harness show={false} />)
      page.rerender(<Harness />)
      expect(
        screen.getByRole("button", { name: "Show less" })
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Back to the list" }))
      await user.click(screen.getByRole("button", { name: "Item 2" }))
      await within(await screen.findByRole("article")).findByText(
        "About this item."
      )
      expect(
        screen.getByRole("button", { name: "Show all" })
      ).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it("shows the first files and versions, and the rest on request", async () => {
    const user = userEvent.setup()
    backend.harness_item = () => {
      const base = rawDetail({ ref: "acme/item-1", name: "item-1" })
      return {
        ...base,
        install: {
          ...(base.install as object),
          files: Array.from({ length: 75 }, (_, index) => ({
            path: `docs/page-${index}.md`,
            sha256: "aa",
            size: 100,
            executable: false,
          })),
        },
      }
    }
    backend.harness_versions = () =>
      Array.from({ length: 12 }, (_, index) => ({
        revision: 12 - index,
        version: `1.0.${12 - index}`,
        status: "ok",
        risk: "low",
        publishedAt: "2026-10-20T08:00:00.000Z",
      }))
    render(<Harness />)
    const detail = await openItem(user)

    const files = within(detail).getByRole("region", { name: "Files" })
    expect(within(files).getAllByRole("listitem")).toHaveLength(60)
    await user.click(within(files).getByRole("button", { name: "Show all 75" }))
    expect(within(files).getAllByRole("listitem")).toHaveLength(75)

    const versions = within(detail).getByRole("region", { name: "Versions" })
    expect(within(versions).getAllByRole("listitem")).toHaveLength(8)
    await user.click(
      within(versions).getByRole("button", { name: "Show all 12" })
    )
    expect(within(versions).getAllByRole("listitem")).toHaveLength(12)
  })
})

describe("Discover — back to the list", () => {
  it("restores the results, the offset and the focus, without asking again", async () => {
    const user = userEvent.setup()
    backend.harness_list = () => rawList(rawSummaries(12), "page-2", 40)
    render(<Harness />)
    await screen.findByText("Item 12")

    const listPane = scroller(screen.getByRole("list", { name: "Results" }))
    fireEvent.scroll(listPane, { target: { scrollTop: 640 } })

    await user.click(screen.getByRole("button", { name: "Item 7" }))
    await screen.findByRole("article")
    await user.click(screen.getByRole("button", { name: "Back to the list" }))

    expect(cardTitles()).toHaveLength(12)
    expect(
      scroller(screen.getByRole("list", { name: "Results" })).scrollTop
    ).toBe(640)
    expect(screen.getByRole("button", { name: "Item 7" })).toHaveFocus()
    expect(callsOf("harness_list")).toHaveLength(1)
  })

  it("goes back on the browser's back as well", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(await screen.findByRole("button", { name: "Item 2" }))
    await screen.findByRole("article")

    await act(async () => {
      window.history.back()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull())
    expect(screen.getByRole("button", { name: "Item 2" })).toHaveFocus()
  })
})

// ─── State that outlives the page ─────────────────────────────────────

describe("Discover — the breadcrumb", () => {
  it("goes back to the list from the detail", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(await screen.findByRole("button", { name: "Item 2" }))
    const detail = await screen.findByRole("article")
    const crumbs = within(detail).getByRole("navigation", {
      name: "Breadcrumb",
    })

    await user.click(
      within(crumbs).getByRole("button", { name: "Back to the list" })
    )

    expect(screen.queryByRole("article")).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Item 2" })).toHaveFocus()
    )
  })
})

describe("Discover — leaving the page and coming back", () => {
  it("is where it was left: text, filters, results and offset", async () => {
    const user = userEvent.setup()
    backend.harness_list = (args) =>
      args?.cursor
        ? rawList(rawSummaries(2, 3), null, 4)
        : rawList(rawSummaries(2), "page-2", 4)
    const page = render(<Harness />)
    await screen.findByText("Item 2")

    await user.click(screen.getByRole("radio", { name: "Skills" }))
    await waitFor(() => expect(callsOf("harness_list")).toHaveLength(2))
    fireEvent.change(searchBox(), { target: { value: "pdf" } })
    fireEvent.keyDown(searchBox(), { key: "Enter" })
    await waitFor(() =>
      expect(lastCallOf("harness_list")).toEqual({
        q: "pdf",
        kind: "skill",
      })
    )
    reachEnd()
    await screen.findByText("Item 4")
    fireEvent.scroll(scroller(screen.getByRole("list", { name: "Results" })), {
      target: { scrollTop: 480 },
    })
    const listCalls = callsOf("harness_list").length
    const configCalls = callsOf("harness_config").length

    // Off to a conversation: the page unmounts, the provider stays.
    page.rerender(<Harness show={false} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    page.rerender(<Harness />)

    expect(searchBox()).toHaveValue("pdf")
    expect(screen.getByRole("radio", { name: "Skills" })).toBeChecked()
    expect(cardTitles()).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"])
    expect(
      scroller(screen.getByRole("list", { name: "Results" })).scrollTop
    ).toBe(480)
    // Nothing was fetched to get here, and nothing took the focus.
    expect(callsOf("harness_list")).toHaveLength(listCalls)
    expect(callsOf("harness_config")).toHaveLength(configCalls)
    expect(document.body).toHaveFocus()
  })

  it("is on the same open item, without loading it again", async () => {
    const user = userEvent.setup()
    const page = render(<Harness />)
    await user.click(await screen.findByRole("button", { name: "Item 2" }))
    const detail = await screen.findByRole("article")
    await within(detail).findByText("About this item.")
    fireEvent.scroll(scroller(detail), { target: { scrollTop: 300 } })

    page.rerender(<Harness show={false} />)
    page.rerender(<Harness />)

    const again = screen.getByRole("article")
    expect(within(again).getByText("Apache-2.0")).toBeInTheDocument()
    expect(within(again).getByText("About this item.")).toBeInTheDocument()
    expect(scroller(again).scrollTop).toBe(300)
    expect(callsOf("harness_item")).toHaveLength(1)
    expect(callsOf("harness_readme")).toHaveLength(1)
  })

  it("applies a search that was typed just before leaving", async () => {
    vi.useFakeTimers()
    const page = render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    fireEvent.change(searchBox(), { target: { value: "pdf" } })
    page.rerender(<Harness show={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    })
    // The pause died with the page; the text did not.
    expect(callsOf("harness_list")).toHaveLength(1)

    page.rerender(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(searchBox()).toHaveValue("pdf")
    expect(lastCallOf("harness_list")).toEqual({ q: "pdf" })
  })

  it("lands an answer that arrives while the page is away", async () => {
    const answer = deferred()
    backend.harness_list = () => answer.promise
    const page = render(<Harness />)
    await waitFor(() => expect(callsOf("harness_list")).toHaveLength(1))

    page.rerender(<Harness show={false} />)
    await act(async () => {
      answer.resolve(rawList(rawSummaries(2)))
    })
    page.rerender(<Harness />)

    expect(cardTitles()).toEqual(["Item 1", "Item 2"])
    expect(callsOf("harness_list")).toHaveLength(1)
  })

  it("asks again, on the way back, for a list that had failed", async () => {
    let online = false
    backend.harness_list = () => {
      if (!online) throw backendError("network")
      return rawList(rawSummaries(1))
    }
    const page = render(<Harness />)
    await screen.findByRole("alert")

    page.rerender(<Harness show={false} />)
    online = true
    page.rerender(<Harness />)
    expect(await screen.findByText("Item 1")).toBeInTheDocument()
  })
})

// ─── Opened from outside ──────────────────────────────────────────────

describe("Discover — openHarness({ section: 'discover', itemRef })", () => {
  it("opens that item's detail, on the first frame", async () => {
    // The request is made while the page is elsewhere, as a link in a chat
    // would make it; the route switch then mounts the section.
    const page = render(<Harness show={false} />)
    act(() => {
      view.open({ section: "discover", itemRef: "acme/pdf-tools" })
    })
    page.rerender(<Harness />)

    // Already the detail, on the item asked for — not the list first.
    const detail = screen.getByRole("article")
    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent(
      "acme/pdf-tools"
    )
    expect(
      screen.queryByRole("textbox", { name: "Search SRN Harness" })
    ).toBeNull()

    expect(
      await within(detail).findByRole("heading", { name: "PDF Tools" })
    ).toBeInTheDocument()
    expect(callsOf("harness_item")).toEqual([{ itemRef: "acme/pdf-tools" }])
    // The list was never drawn, so it was never asked for.
    expect(callsOf("harness_list")).toHaveLength(0)
  })

  it("opens a listed-only item, which no list would have shown", async () => {
    backend.harness_item = () =>
      rawDetail({
        ref: "acme/unlisted",
        name: "unlisted",
        title: { en: "Unlisted Thing" },
        status: "listed",
        listedReasons: ["bulk_publisher"],
      })
    render(<Harness />)
    await screen.findByText("Item 1")
    act(() => {
      view.open({ section: "discover", itemRef: "acme/unlisted" })
    })

    const detail = await screen.findByRole("article")
    expect(
      await within(detail).findByRole("heading", { name: "Unlisted Thing" })
    ).toBeInTheDocument()
    expect(within(detail).getAllByText("Listed only").length).toBeGreaterThan(0)
    expect(
      within(detail).getByText("its publisher lists in bulk")
    ).toBeInTheDocument()
  })

  it("forgives the case and the space around an address", async () => {
    render(<Harness />)
    await screen.findByText("Item 1")
    act(() => {
      view.open({ section: "discover", itemRef: "  Acme/PDF-Tools " })
    })
    await screen.findByRole("article")
    expect(callsOf("harness_item")).toEqual([{ itemRef: "acme/pdf-tools" }])
  })

  it.each([
    "not an address",
    "acme",
    "acme/pdf tools",
    "https://example.com/a/b",
  ])(
    "answers the malformed address %j with words, not a request",
    async (itemRef) => {
      const user = userEvent.setup()
      render(<Harness />)
      await screen.findByText("Item 1")
      act(() => {
        view.open({ section: "discover", itemRef })
      })

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(
        "That is not a SRN Harness address. An address looks like publisher/name."
      )
      expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull()
      expect(callsOf("harness_item")).toHaveLength(0)
      // What was asked for is shown as text, and there is no page to link to.
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        itemRef
      )
      expect(
        screen.queryByRole("link", { name: "View on the website" })
      ).toBeNull()

      await user.click(screen.getByRole("button", { name: "Back to the list" }))
      expect(cardTitles()).toHaveLength(3)
    }
  )

  it("says so when the catalog has no such item", async () => {
    backend.harness_item = () => {
      throw backendError("notFound")
    }
    render(<Harness />)
    await screen.findByText("Item 1")
    act(() => {
      view.open({ section: "discover", itemRef: "acme/gone" })
    })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      "SRN Harness has no item at this address. It may have been renamed or removed."
    )
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "acme/gone"
    )
    expect(
      screen.queryByRole("link", { name: "View on the website" })
    ).toBeNull()
  })

  it("offers Retry when the item could not be fetched", async () => {
    const user = userEvent.setup()
    let online = false
    backend.harness_item = (args) => {
      if (!online) throw backendError("network")
      return rawDetail({ ref: args?.itemRef, name: "pdf-tools" })
    }
    render(<Harness />)
    await screen.findByText("Item 1")
    act(() => {
      view.open({ section: "discover", itemRef: "acme/pdf-tools" })
    })

    const alert = await screen.findByRole("alert")
    online = true
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Apache-2.0")).toBeInTheDocument()
  })

  it("opens the same item again when asked twice", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText("Item 1")
    act(() => {
      view.open({ section: "discover", itemRef: "acme/pdf-tools" })
    })
    await screen.findByRole("article")
    await user.click(screen.getByRole("button", { name: "Back to the list" }))
    expect(screen.queryByRole("article")).toBeNull()

    act(() => {
      view.open({ section: "discover", itemRef: "acme/pdf-tools" })
    })
    expect(await screen.findByRole("article")).toBeInTheDocument()
  })

  // "Open in Codeg" asks with `intent: "install"`. Discover takes the intent
  // with the target and opens the detail; an MCP server's or a skill's
  // install dialog only plans. Whatever the kind, the only commands are the
  // ones that read.
  it.each([
    [
      "a skill",
      () => rawDetail({ ref: "acme/pdf-tools", name: "pdf-tools" }),
      "PDF Tools",
    ],
    [
      "an MCP server",
      () =>
        rawDetail({
          ref: "acme/files-mcp",
          name: "files-mcp",
          kind: "mcp",
          title: { en: "Files MCP" },
          readme: null,
        }),
      "Files MCP",
    ],
    [
      "a prompt",
      () => rawPromptDetail(),
      "Ask me for: the product name and a one-line promise.",
    ],
    ["an assistant", () => rawAssistantDetail(), "Silent failure hunter"],
    [
      "a listed-only item",
      () =>
        rawDetail({
          ref: "acme/unlisted",
          name: "unlisted",
          title: { en: "Unlisted Thing" },
          status: "listed",
          listedReasons: ["bulk_publisher"],
        }),
      "Unlisted Thing",
    ],
  ])(
    "opens %s from a link on its detail, and only reads",
    async (kind, detail, title) => {
      backend.harness_item = () => detail()
      const itemRef = String(detail().ref)
      const page = render(<Harness show={false} />)
      act(() => {
        view.open({ section: "discover", itemRef, intent: "install" })
      })
      expect(view.pendingTarget).toEqual({
        section: "discover",
        itemRef,
        intent: "install",
      })
      page.rerender(<Harness />)

      const article = await screen.findByRole("article")
      expect(
        await within(article).findByRole("heading", { name: title })
      ).toBeInTheDocument()
      expect(callsOf("harness_item")).toEqual([{ itemRef }])
      expect(view.pendingTarget).toBeNull()
      // An MCP server and a skill offer to install, and the link opens
      // their install dialog, which only plans; nothing else has anything
      // to install.
      if (kind === "a prompt" || kind === "an assistant") {
        expect(
          within(article).queryByRole("button", { name: /install/i })
        ).toBeNull()
      }
      const reads = new Set([
        "harness_status",
        "harness_item",
        "harness_versions",
        "harness_readme",
        "harness_prompt",
        "srn_asset",
        "harness_installed",
        "harness_mcp_plan",
        "harness_skill_plan",
      ])
      const commands = mocks.call.mock.calls.map(([name]) => String(name))
      expect(commands.filter((name) => !reads.has(name))).toEqual([])
    }
  )
})

// ─── Layout ───────────────────────────────────────────────────────────

describe("Discover — on a phone", () => {
  it("scrolls the controls away with the list", async () => {
    mocks.mobile = true
    render(<Harness />)
    await screen.findByText("Item 1")

    const pane = scroller(screen.getByRole("list", { name: "Results" }))
    expect(pane).toContainElement(searchBox())
  })

  it("scrolls the heading and the controls away with a wide list too", async () => {
    render(<Harness />)
    await screen.findByText("Item 1")

    const pane = scroller(screen.getByRole("list", { name: "Results" }))
    expect(pane).toContainElement(searchBox())
  })
})

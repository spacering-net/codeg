import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  getActiveRemoteConnectionId: () => null,
}))

import { createHarnessSlotStore } from "@/lib/harness-slots"
import {
  applyDiscoverFilters,
  closeDiscoverItem,
  DEFAULT_DISCOVER_FILTERS,
  DISCOVER_CONFIG,
  DISCOVER_DETAIL,
  DISCOVER_DETAIL_EXPANDED,
  DISCOVER_DETAIL_SCROLL,
  DISCOVER_DETAIL_TRAIL,
  DISCOVER_FILTERS,
  DISCOVER_KIND_TOTALS,
  DISCOVER_LIST,
  DISCOVER_LIST_SCROLL,
  DISCOVER_QUICK_MESSAGE,
  DISCOVER_RETURN_FOCUS,
  discoverQueryOf,
  ensureDiscoverConfig,
  ensureDiscoverList,
  loadDiscoverList,
  loadMoreDiscover,
  openDiscoverItem,
  refreshDiscover,
  reloadDiscoverList,
  retryDiscoverItem,
  retryDiscoverPart,
  sameDiscoverQuery,
  setDiscoverText,
} from "./discover-state"
import { __resetHarnessStatusForTests, getHarnessStatus } from "./status"
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
} from "./test-fixtures"

/** A promise the test settles by hand, to decide the order answers arrive. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every settled promise run its continuations. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const query = (patch: Partial<typeof DEFAULT_DISCOVER_FILTERS> = {}) =>
  discoverQueryOf({ ...DEFAULT_DISCOVER_FILTERS, ...patch })

const refs = (store: ReturnType<typeof createHarnessSlotStore>) =>
  store.get(DISCOVER_LIST).items.map((item) => item.ref)

beforeEach(() => {
  call.mockReset()
  localStorage.clear()
  __resetHarnessStatusForTests()
})

describe("the list — queries", () => {
  it("asks for every kind, most popular first, by default", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(rawList(rawSummaries(2), "c2", 40))

    await loadDiscoverList(slots, query())

    expect(call).toHaveBeenCalledWith("harness_list", { sort: "popular" })
    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "ready",
      next: "c2",
      approxTotal: 40,
      error: null,
    })
    expect(refs(slots)).toEqual(["acme/item-1", "acme/item-2"])
  })

  it("sends the filters, and leaves the sort out while searching", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValue(rawList([]))

    await loadDiscoverList(
      slots,
      query({ kind: "mcp", tag: "files", runtime: "node", sort: "new" })
    )
    expect(call).toHaveBeenLastCalledWith("harness_list", {
      kind: "mcp",
      tag: "files",
      runtime: "node",
      sort: "new",
    })

    await loadDiscoverList(slots, query({ text: "  pdf forms ", sort: "new" }))
    expect(call).toHaveBeenLastCalledWith("harness_list", { q: "pdf forms" })
  })

  it("never shows connectors, which this version does not offer", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(
      rawList([
        rawSummary({ id: "1", ref: "acme/one" }),
        rawSummary({ id: "2", ref: "acme/two", kind: "connector" }),
        rawSummary({ id: "3", ref: "acme/three", kind: "widget" }),
      ])
    )
    await loadDiscoverList(slots, query())
    // The connector is left out; a kind nobody has heard of is kept.
    expect(refs(slots)).toEqual(["acme/one", "acme/three"])
  })

  it("treats the sort as part of the question only when browsing", () => {
    expect(sameDiscoverQuery(query(), query({ sort: "new" }))).toBe(false)
    expect(
      sameDiscoverQuery(
        query({ text: "pdf" }),
        query({ text: "pdf", sort: "new" })
      )
    ).toBe(true)
    expect(
      sameDiscoverQuery(query({ text: "pdf" }), query({ text: "pdf " }))
    ).toBe(true)
    expect(sameDiscoverQuery(query(), query({ kind: "skill" }))).toBe(false)
  })
})

describe("the list — a late answer to an earlier question is dropped", () => {
  it("keeps the newer answer when the older one arrives last", async () => {
    const slots = createHarnessSlotStore()
    const first = deferred()
    const second = deferred()
    call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const older = loadDiscoverList(slots, query({ text: "p" }))
    const newer = loadDiscoverList(slots, query({ text: "pdf" }))

    second.resolve(rawList([rawSummary({ id: "new", ref: "acme/newer" })]))
    await newer
    expect(refs(slots)).toEqual(["acme/newer"])

    first.resolve(rawList([rawSummary({ id: "old", ref: "acme/older" })]))
    await older
    expect(refs(slots)).toEqual(["acme/newer"])
    expect(slots.get(DISCOVER_LIST).query?.q).toBe("pdf")
  })

  it("ignores an earlier question's failure as well", async () => {
    const slots = createHarnessSlotStore()
    const first = deferred()
    call
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(rawList(rawSummaries(1)))

    const older = loadDiscoverList(slots, query({ text: "p" }))
    await loadDiscoverList(slots, query({ text: "pdf" }))
    first.reject(backendError("network"))
    await older

    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "ready",
      error: null,
    })
    expect(refs(slots)).toEqual(["acme/item-1"])
  })

  it("keeps the previous results on show while the next ones load", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
    await loadDiscoverList(slots, query())

    const pending = deferred()
    call.mockReturnValueOnce(pending.promise)
    const load = loadDiscoverList(slots, query({ text: "pdf" }))

    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "loading",
      next: null,
    })
    expect(refs(slots)).toEqual(["acme/item-1", "acme/item-2"])

    pending.resolve(rawList([]))
    await load
    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "ready",
      items: [],
    })
  })

  it("drops an answer that arrives after the section was reset", async () => {
    const slots = createHarnessSlotStore()
    const pending = deferred()
    call.mockReturnValueOnce(pending.promise)
    const load = loadDiscoverList(slots, query())

    slots.reset("discover")
    // A fresh load after the reset must not share a number with the old one.
    call.mockResolvedValueOnce(
      rawList([rawSummary({ id: "b", ref: "acme/after" })])
    )
    await loadDiscoverList(slots, query())

    pending.resolve(rawList([rawSummary({ id: "a", ref: "acme/before" })]))
    await load
    expect(refs(slots)).toEqual(["acme/after"])
  })
})

describe("the list — paging", () => {
  it("appends the next page and moves the cursor on", async () => {
    const slots = createHarnessSlotStore()
    call
      .mockResolvedValueOnce(rawList(rawSummaries(2), "c2", 5))
      .mockResolvedValueOnce(rawList(rawSummaries(2, 3), "c3", 5))
      .mockResolvedValueOnce(rawList(rawSummaries(1, 5), null, 5))

    await loadDiscoverList(slots, query({ kind: "skill" }))
    await loadMoreDiscover(slots)
    expect(call).toHaveBeenLastCalledWith("harness_list", {
      kind: "skill",
      sort: "popular",
      cursor: "c2",
    })
    expect(slots.get(DISCOVER_LIST)).toMatchObject({ next: "c3", lastAdded: 2 })

    await loadMoreDiscover(slots)
    expect(call).toHaveBeenLastCalledWith("harness_list", {
      kind: "skill",
      sort: "popular",
      cursor: "c3",
    })
    expect(refs(slots)).toEqual([
      "acme/item-1",
      "acme/item-2",
      "acme/item-3",
      "acme/item-4",
      "acme/item-5",
    ])
    expect(slots.get(DISCOVER_LIST)).toMatchObject({ next: null, lastAdded: 1 })

    // The last page has been reached: nothing further is asked for.
    await loadMoreDiscover(slots)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("asks for a page only once however often the end is reached", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
    await loadDiscoverList(slots, query())

    const page = deferred()
    call.mockReturnValueOnce(page.promise)
    const first = loadMoreDiscover(slots)
    const second = loadMoreDiscover(slots)
    const third = loadMoreDiscover(slots)
    expect(slots.get(DISCOVER_LIST).more.phase).toBe("loading")

    page.resolve(rawList(rawSummaries(2, 3), null))
    await Promise.all([first, second, third])
    expect(call).toHaveBeenCalledTimes(2)
    expect(refs(slots)).toHaveLength(4)
  })

  it("does not repeat an item two pages both carry", async () => {
    const slots = createHarnessSlotStore()
    call
      .mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
      .mockResolvedValueOnce(rawList(rawSummaries(2, 2), null))
    await loadDiscoverList(slots, query())
    await loadMoreDiscover(slots)
    expect(refs(slots)).toEqual(["acme/item-1", "acme/item-2", "acme/item-3"])
    expect(slots.get(DISCOVER_LIST).lastAdded).toBe(1)
  })

  it("stops at a cursor that leads back to itself", async () => {
    const slots = createHarnessSlotStore()
    call
      .mockResolvedValueOnce(rawList(rawSummaries(1), "c2"))
      .mockResolvedValueOnce(rawList(rawSummaries(1, 2), "c2"))
    await loadDiscoverList(slots, query())
    await loadMoreDiscover(slots)
    expect(slots.get(DISCOVER_LIST).next).toBeNull()
  })

  it("drops a page that arrives after a new question was asked", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
    await loadDiscoverList(slots, query())

    const page = deferred()
    call.mockReturnValueOnce(page.promise)
    const more = loadMoreDiscover(slots)

    call.mockResolvedValueOnce(
      rawList([rawSummary({ id: "x", ref: "acme/searched" })], "s2")
    )
    await loadDiscoverList(slots, query({ text: "pdf" }))

    page.resolve(rawList(rawSummaries(2, 3), "c3"))
    await more
    expect(refs(slots)).toEqual(["acme/searched"])
    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      next: "s2",
      more: { phase: "idle" },
    })
  })

  it("keeps the list when the next page fails, and can ask again", async () => {
    const slots = createHarnessSlotStore()
    call
      .mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
      .mockRejectedValueOnce(backendError("rateLimited", { seconds: "30" }))
    await loadDiscoverList(slots, query())
    await loadMoreDiscover(slots)

    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "ready",
      next: "c2",
      more: { phase: "error", error: { kind: "rateLimited", seconds: 30 } },
    })
    expect(refs(slots)).toHaveLength(2)

    call.mockResolvedValueOnce(rawList(rawSummaries(1, 3), null))
    await loadMoreDiscover(slots)
    expect(refs(slots)).toHaveLength(3)
    expect(slots.get(DISCOVER_LIST).more).toEqual({
      phase: "idle",
      error: null,
    })
  })
})

describe("the list — failures", () => {
  it("replaces the results with the failure", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValueOnce(rawList(rawSummaries(2), "c2"))
    await loadDiscoverList(slots, query())

    call.mockRejectedValueOnce(backendError("network"))
    await loadDiscoverList(slots, query({ text: "pdf" }))
    expect(slots.get(DISCOVER_LIST)).toMatchObject({
      phase: "error",
      items: [],
      next: null,
      error: { kind: "network" },
    })
  })

  it("asks the status again when the catalog turns out to be switched off", async () => {
    const slots = createHarnessSlotStore()
    expect(getHarnessStatus().enabled).toBe(true)
    call.mockImplementation(async (command: string) => {
      if (command === "harness_status") {
        return { enabled: false, origin: "https://spacering.net" }
      }
      throw backendError("disabled")
    })

    await loadDiscoverList(slots, query())
    await flush()

    expect(slots.get(DISCOVER_LIST).error?.kind).toBe("disabled")
    expect(call).toHaveBeenCalledWith("harness_status")
    expect(getHarnessStatus()).toMatchObject({ enabled: false })
  })
})

describe("the list — following the filters", () => {
  it("loads when nothing is loaded, and not again for the same question", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValue(rawList(rawSummaries(1)))

    ensureDiscoverList(slots)
    ensureDiscoverList(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)

    ensureDiscoverList(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("applies a filter at once, and the search text only when asked", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValue(rawList([]))
    ensureDiscoverList(slots)
    await flush()

    setDiscoverText(slots, "pdf")
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    expect(slots.get(DISCOVER_FILTERS).text).toBe("pdf")

    applyDiscoverFilters(slots, { kind: "mcp" })
    await flush()
    // The pending text goes with it.
    expect(call).toHaveBeenLastCalledWith("harness_list", {
      q: "pdf",
      kind: "mcp",
    })

    ensureDiscoverList(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("asks again for a failed list only when told to retry", async () => {
    const slots = createHarnessSlotStore()
    call.mockRejectedValueOnce(backendError("network"))
    ensureDiscoverList(slots)
    await flush()
    expect(slots.get(DISCOVER_LIST).phase).toBe("error")

    ensureDiscoverList(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)

    call.mockResolvedValueOnce(rawList(rawSummaries(1)))
    ensureDiscoverList(slots, { retry: true })
    await flush()
    expect(slots.get(DISCOVER_LIST).phase).toBe("ready")

    call.mockResolvedValueOnce(rawList(rawSummaries(2)))
    reloadDiscoverList(slots)
    await flush()
    expect(refs(slots)).toHaveLength(2)
  })

  it("starts a new first page from the top", async () => {
    const slots = createHarnessSlotStore()
    call.mockResolvedValue(rawList(rawSummaries(1)))
    slots.set(DISCOVER_LIST_SCROLL, 640)
    await loadDiscoverList(slots, query())
    expect(slots.get(DISCOVER_LIST_SCROLL)).toBe(0)
  })
})

describe("the open item", () => {
  function answer(overrides: Record<string, unknown> = {}) {
    call.mockImplementation(async (command: string) => {
      if (command === "harness_item") return rawDetail(overrides)
      if (command === "harness_versions") return rawVersions()
      if (command === "harness_readme") return "<p>About it.</p>"
      throw new Error(`unexpected ${command}`)
    })
  }

  it("loads the item, then its versions and description", async () => {
    const slots = createHarnessSlotStore()
    answer()
    slots.set(DISCOVER_DETAIL_SCROLL, 300)

    await openDiscoverItem(slots, "acme/pdf-tools")
    await flush()

    const detail = slots.get(DISCOVER_DETAIL)
    expect(detail).toMatchObject({
      ref: "acme/pdf-tools",
      phase: "ready",
      error: null,
      versions: { phase: "ready" },
      readme: { phase: "ready", value: "<p>About it.</p>" },
    })
    expect(detail?.item?.license).toBe("Apache-2.0")
    expect(detail?.versions.value).toHaveLength(2)
    expect(slots.get(DISCOVER_DETAIL_SCROLL)).toBe(0)
    expect(call).toHaveBeenCalledWith("harness_item", {
      itemRef: "acme/pdf-tools",
    })
  })

  it("does not ask for a description the item says it lacks", async () => {
    const slots = createHarnessSlotStore()
    answer({ readme: null })
    await openDiscoverItem(slots, "acme/pdf-tools")
    await flush()
    expect(call).not.toHaveBeenCalledWith("harness_readme", expect.anything())
    expect(slots.get(DISCOVER_DETAIL)?.readme.phase).toBe("idle")
  })

  it("tidies an address before asking, and shows what the list knew meanwhile", async () => {
    const slots = createHarnessSlotStore()
    const pending = deferred()
    call.mockReturnValueOnce(pending.promise)
    const preview = { ref: "acme/pdf-tools", name: "pdf-tools" } as never

    const open = openDiscoverItem(slots, "  Acme/PDF-Tools ", preview)
    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
      ref: "acme/pdf-tools",
      phase: "loading",
      preview,
      item: null,
    })
    expect(call).toHaveBeenCalledWith("harness_item", {
      itemRef: "acme/pdf-tools",
    })
    pending.resolve(rawDetail({ readme: null }))
    await open
  })

  it.each([
    "not an address",
    "acme",
    "acme/pdf tools",
    "",
    "https://example.com/x",
  ])(
    "opens on a message, without a request, for the malformed address %j",
    async (input) => {
      const slots = createHarnessSlotStore()
      await openDiscoverItem(slots, input)
      expect(call).not.toHaveBeenCalled()
      expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
        phase: "error",
        error: { kind: "invalidRef" },
        item: null,
      })
    }
  )

  it("reports an address the catalog does not have", async () => {
    const slots = createHarnessSlotStore()
    call.mockRejectedValueOnce(backendError("notFound"))
    await openDiscoverItem(slots, "acme/gone")
    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
      ref: "acme/gone",
      phase: "error",
      error: { kind: "notFound" },
    })
  })

  it("drops the answer for an item that is no longer the open one", async () => {
    const slots = createHarnessSlotStore()
    const first = deferred()
    call.mockImplementation(
      async (command: string, args?: { itemRef?: string }) => {
        if (command === "harness_item" && args?.itemRef === "acme/first") {
          return first.promise
        }
        if (command === "harness_item") {
          return rawDetail({ ref: "acme/second", name: "second", readme: null })
        }
        return []
      }
    )

    const older = openDiscoverItem(slots, "acme/first")
    await openDiscoverItem(slots, "acme/second")
    first.resolve(rawDetail({ ref: "acme/first", name: "first", readme: null }))
    await older
    await flush()

    expect(slots.get(DISCOVER_DETAIL)?.item?.ref).toBe("acme/second")
  })

  it("lets the versions or the description fail on their own, and retries them", async () => {
    const slots = createHarnessSlotStore()
    call.mockImplementation(async (command: string) => {
      if (command === "harness_item") return rawDetail()
      throw backendError("network")
    })
    await openDiscoverItem(slots, "acme/pdf-tools")
    await flush()

    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
      phase: "ready",
      versions: { phase: "error", error: { kind: "network" } },
      readme: { phase: "error", error: { kind: "network" } },
    })

    answer()
    retryDiscoverPart(slots, "versions")
    retryDiscoverPart(slots, "readme")
    await flush()
    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
      versions: { phase: "ready" },
      readme: { phase: "ready", value: "<p>About it.</p>" },
    })
  })

  it("asks again for an item that failed to load", async () => {
    const slots = createHarnessSlotStore()
    call.mockRejectedValueOnce(backendError("server", { status: "503" }))
    await openDiscoverItem(slots, "acme/pdf-tools")
    expect(slots.get(DISCOVER_DETAIL)?.error).toMatchObject({
      kind: "server",
      status: "503",
    })

    answer()
    retryDiscoverItem(slots)
    await flush()
    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({
      phase: "ready",
      error: null,
    })
  })

  it("closes back to the list, remembering which card to return to", async () => {
    const slots = createHarnessSlotStore()
    answer({ readme: null })
    await openDiscoverItem(slots, "acme/pdf-tools")

    closeDiscoverItem(slots)
    expect(slots.get(DISCOVER_DETAIL)).toBeNull()
    expect(slots.get(DISCOVER_RETURN_FOCUS)).toBe("acme/pdf-tools")

    // Closing with nothing open changes nothing.
    slots.set(DISCOVER_RETURN_FOCUS, null)
    closeDiscoverItem(slots)
    expect(slots.get(DISCOVER_RETURN_FOCUS)).toBeNull()
  })
})

describe("the configuration", () => {
  it("is loaded once, and again only after it failed", async () => {
    const slots = createHarnessSlotStore()
    call.mockRejectedValueOnce(backendError("network"))
    ensureDiscoverConfig(slots)
    ensureDiscoverConfig(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    expect(slots.get(DISCOVER_CONFIG)).toMatchObject({
      phase: "error",
      error: { kind: "network" },
    })

    call.mockResolvedValueOnce(rawConfig())
    ensureDiscoverConfig(slots)
    await flush()
    expect(slots.get(DISCOVER_CONFIG).value?.tags.map((tag) => tag.id)).toEqual(
      ["database", "files"]
    )

    ensureDiscoverConfig(slots)
    await flush()
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe("a prompt's text", () => {
  it("comes with the item, and is not asked for again", async () => {
    const slots = createHarnessSlotStore()
    call.mockImplementation(async (command: string) => {
      if (command === "harness_item") return rawPromptDetail()
      if (command === "harness_versions") return rawVersions()
      throw new Error(`unexpected ${command}`)
    })
    await openDiscoverItem(slots, "yihui-dev/twoclipping-402193")
    await flush()
    expect(call).not.toHaveBeenCalledWith("harness_prompt", expect.anything())
    expect(slots.get(DISCOVER_DETAIL)?.prompt.phase).toBe("idle")
  })

  it("is asked for on its own from a catalog that left it out, and again after a failure", async () => {
    const slots = createHarnessSlotStore()
    const bare = rawPromptDetail()
    delete (bare.install as Record<string, unknown>).prompt
    let online = false
    call.mockImplementation(async (command: string) => {
      if (command === "harness_item") return bare
      if (command === "harness_versions") return rawVersions()
      if (command === "harness_prompt") {
        if (!online) throw backendError("network")
        return "Write a haiku."
      }
      throw new Error(`unexpected ${command}`)
    })
    await openDiscoverItem(slots, "yihui-dev/twoclipping-402193")
    await flush()
    expect(call).toHaveBeenCalledWith("harness_prompt", {
      itemRef: "yihui-dev/twoclipping-402193",
    })
    expect(slots.get(DISCOVER_DETAIL)?.prompt).toMatchObject({
      phase: "error",
      error: { kind: "network" },
    })

    online = true
    retryDiscoverPart(slots, "prompt")
    await flush()
    expect(slots.get(DISCOVER_DETAIL)?.prompt).toMatchObject({
      phase: "ready",
      value: "Write a haiku.",
    })
  })
})

describe("the way back from an item opened from another", () => {
  function answer() {
    call.mockImplementation(
      async (command: string, args?: { itemRef?: string }) => {
        if (command === "harness_item") {
          return args?.itemRef === "anthropics/pdf"
            ? rawDetail({ ref: "anthropics/pdf", name: "pdf", readme: null })
            : rawAssistantDetail()
        }
        if (command === "harness_versions") return rawVersions()
        if (command === "harness_readme") return "<p>Instructions.</p>"
        throw new Error(`unexpected ${command}`)
      }
    )
  }

  it("returns to the detail it was opened from, as it was left", async () => {
    const slots = createHarnessSlotStore()
    answer()
    await openDiscoverItem(slots, "anthropics/silent-failure-hunter")
    await flush()
    slots.set(DISCOVER_DETAIL_SCROLL, 420)
    slots.set(DISCOVER_DETAIL_EXPANDED, ["readme"])
    const assistant = slots.get(DISCOVER_DETAIL)

    await openDiscoverItem(slots, "anthropics/pdf", null, { trail: "push" })
    await flush()
    expect(slots.get(DISCOVER_DETAIL)?.item?.ref).toBe("anthropics/pdf")
    expect(slots.get(DISCOVER_DETAIL_SCROLL)).toBe(0)
    expect(slots.get(DISCOVER_DETAIL_EXPANDED)).toEqual([])
    expect(slots.get(DISCOVER_DETAIL_TRAIL)).toHaveLength(1)

    const asked = call.mock.calls.length
    closeDiscoverItem(slots)
    expect(slots.get(DISCOVER_DETAIL)).toBe(assistant)
    expect(slots.get(DISCOVER_DETAIL_SCROLL)).toBe(420)
    expect(slots.get(DISCOVER_DETAIL_EXPANDED)).toEqual(["readme"])
    expect(slots.get(DISCOVER_DETAIL_TRAIL)).toEqual([])
    // The link it was opened from takes the focus again.
    expect(slots.get(DISCOVER_RETURN_FOCUS)).toBe("anthropics/pdf")
    // Nothing is asked for again: it is all still there.
    await flush()
    expect(call.mock.calls.length).toBe(asked)

    // And from there, back to the list.
    closeDiscoverItem(slots)
    expect(slots.get(DISCOVER_DETAIL)).toBeNull()
    expect(slots.get(DISCOVER_RETURN_FOCUS)).toBe(
      "anthropics/silent-failure-hunter"
    )
  })

  it("asks again for what was still loading when it was left", async () => {
    const slots = createHarnessSlotStore()
    const readme = deferred()
    answer()
    const base = call.getMockImplementation()!
    call.mockImplementation(async (command: string, args?: unknown) =>
      command === "harness_readme" ? readme.promise : base(command, args)
    )
    await openDiscoverItem(slots, "anthropics/silent-failure-hunter")
    await flush()
    expect(slots.get(DISCOVER_DETAIL)?.readme.phase).toBe("loading")

    await openDiscoverItem(slots, "anthropics/pdf", null, { trail: "push" })
    await flush()
    // Arrives while the skill is open: dropped.
    readme.resolve("<p>Late.</p>")
    await flush()

    answer()
    closeDiscoverItem(slots)
    await flush()
    expect(slots.get(DISCOVER_DETAIL)?.readme).toMatchObject({
      phase: "ready",
      value: "<p>Instructions.</p>",
    })
  })

  it("starts afresh when an item is opened from the list or from outside", async () => {
    const slots = createHarnessSlotStore()
    answer()
    await openDiscoverItem(slots, "anthropics/silent-failure-hunter")
    await openDiscoverItem(slots, "anthropics/pdf", null, { trail: "push" })
    expect(slots.get(DISCOVER_DETAIL_TRAIL)).toHaveLength(1)

    // Asking for the same item again (Retry) keeps the way back…
    await openDiscoverItem(slots, "anthropics/pdf", null, { trail: "keep" })
    expect(slots.get(DISCOVER_DETAIL_TRAIL)).toHaveLength(1)
    // …a card or a link from outside does not.
    await openDiscoverItem(slots, "acme/pdf-tools")
    expect(slots.get(DISCOVER_DETAIL_TRAIL)).toEqual([])
    closeDiscoverItem(slots)
    expect(slots.get(DISCOVER_DETAIL)).toBeNull()
  })

  it("forgets the last quick message's outcome when another item opens", async () => {
    const slots = createHarnessSlotStore()
    answer()
    slots.set(DISCOVER_QUICK_MESSAGE, {
      ref: "yihui-dev/a",
      op: 1,
      phase: "saved",
      detail: "",
    })
    await openDiscoverItem(slots, "anthropics/silent-failure-hunter")
    expect(slots.get(DISCOVER_QUICK_MESSAGE)).toBeNull()
  })
})

describe("Refresh, from the page's chrome", () => {
  const commands = () => call.mock.calls.map(([command]) => command as string)
  function answer() {
    call.mockImplementation(async (command: string) => {
      if (command === "harness_item") return rawDetail({ readme: null })
      if (command === "harness_versions") return rawVersions()
      throw new Error(`unexpected ${command}`)
    })
  }

  it("asks for the list and the counts again, the configuration once loaded staying", async () => {
    const slots = createHarnessSlotStore()
    slots.set(DISCOVER_CONFIG, {
      phase: "ready",
      value: null,
      error: null,
      request: 1,
    })
    slots.set(DISCOVER_KIND_TOTALS, {
      phase: "ready",
      value: { all: 3 },
      error: null,
      request: 1,
    })
    call.mockResolvedValue(rawList(rawSummaries(2), null, 7))

    refreshDiscover(slots)
    await flush()
    // The list once, and once per kind for the counts — even though they
    // had been read.
    expect(commands().every((command) => command === "harness_list")).toBe(true)
    expect(commands().length).toBeGreaterThan(1)
    expect(slots.get(DISCOVER_LIST).phase).toBe("ready")
    expect(slots.get(DISCOVER_KIND_TOTALS).value?.all).toBe(7)
  })

  it("asks for the open item again, and leaves the list alone", async () => {
    const slots = createHarnessSlotStore()
    slots.set(DISCOVER_CONFIG, {
      phase: "ready",
      value: null,
      error: null,
      request: 1,
    })
    answer()
    await openDiscoverItem(slots, "acme/pdf-tools")
    await flush()
    call.mockClear()

    refreshDiscover(slots)
    await flush()
    expect(commands()).toContain("harness_item")
    expect(commands()).not.toContain("harness_list")
    expect(slots.get(DISCOVER_DETAIL)).toMatchObject({ phase: "ready" })
  })
})

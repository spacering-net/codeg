import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The script the server-mode proxy injects into officecli's watch page
 * (src-tauri/src/web/handlers/office_watch_shim.js), run against a stand-in
 * page: its own `window`, `fetch`, `EventSource` and `XMLHttpRequest`, so
 * every test gets a fresh one.
 */
const SHIM = readFileSync(
  join(process.cwd(), "src-tauri/src/web/handlers/office_watch_shim.js"),
  "utf8"
)
  .replace("__PFX__", "/api/office-watch-proxy/26315")
  .replace("__CAP__", "cap1")

const STATUS_URL = "/api/office-watch-proxy/26315/api/status?cap=cap1"

/** officecli's event stream, as the page's `EventSource` makes it. */
class FakeStream extends EventTarget {
  readyState = 0
  closed = false
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit
  ) {
    super()
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  send(type: string, msg: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(msg) }))
  }
}

class FakeXhr {
  opened: unknown[] = []
  open(...args: unknown[]) {
    this.opened = args
  }
}

type Page = ReturnType<typeof loadPage>

/**
 * Load the shim into a fresh page whose document is at `version`, as the
 * proxy serves it: told the version it read before fetching the page
 * (`loadedAt`, "-1" when it could not tell).
 */
function loadPage(version: number, loadedAt: string = String(version)) {
  const document = { version, statusFails: false }
  const streams: FakeStream[] = []
  const toApp: unknown[] = []
  const onMessage: ((event: { data: unknown; source: unknown }) => void)[] = []
  const app = { postMessage: (msg: unknown) => toApp.push(msg) }
  const fetch = vi.fn(async (url: string) => {
    if (url === STATUS_URL && document.statusFails) throw new Error("down")
    return {
      json: async () =>
        url === STATUS_URL ? { fmt: "docx", version: document.version } : {},
    }
  })
  const window: Record<string, unknown> = {
    fetch,
    EventSource: class extends FakeStream {
      constructor(url: string, init?: EventSourceInit) {
        super(url, init)
        streams.push(this)
      }
    },
    parent: app,
    addEventListener: (type: string, listener: (typeof onMessage)[0]) => {
      if (type === "message") onMessage.push(listener)
    },
  }
  new Function("window", "XMLHttpRequest", SHIM.replace("__VER__", loadedAt))(
    window,
    FakeXhr
  )

  return {
    document,
    streams,
    toApp,
    fetch,
    window,
    /** The app telling the page whether it is shown. */
    say(visibility: "shown" | "hidden", source: unknown = app) {
      for (const listener of onMessage) {
        listener({ data: { codegOfficePreview: visibility }, source })
      }
    },
    /** What officecli does as its page loads: open the stream, listen. */
    openStream() {
      const EventSource = window.EventSource as new (url: string) => EventTarget
      const es = new EventSource("/events")
      const updates: unknown[] = []
      es.addEventListener("update", (event) =>
        updates.push(JSON.parse((event as MessageEvent).data))
      )
      return { es, updates }
    },
    statusAsks: () =>
      fetch.mock.calls.filter(([url]) => url === STATUS_URL).length,
  }
}

/** Let the page's pending fetches answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let page: Page
beforeEach(async () => {
  page = loadPage(3)
  await settle()
})

describe("office watch shim", () => {
  it("routes the page's root-absolute requests through the proxy, with the capability", async () => {
    const pageFetch = page.window.fetch as (url: string) => Promise<unknown>
    await pageFetch("/api/selection")
    expect(page.fetch).toHaveBeenLastCalledWith(
      "/api/office-watch-proxy/26315/api/selection?cap=cap1",
      undefined
    )
    // Already routed: not routed twice.
    await pageFetch("/api/office-watch-proxy/26315/?x=1")
    expect(page.fetch).toHaveBeenLastCalledWith(
      "/api/office-watch-proxy/26315/?x=1",
      undefined
    )
    const xhr = new FakeXhr()
    xhr.open("POST", "/api/edit")
    expect(xhr.opened[1]).toBe(
      "/api/office-watch-proxy/26315/api/edit?cap=cap1"
    )

    page.openStream()
    expect(page.streams[0].url).toBe(
      "/api/office-watch-proxy/26315/events?cap=cap1"
    )
  })

  it("asks the app as it loads whether it is shown, and until told keeps its stream", () => {
    expect(page.toApp).toEqual([{ codegOfficePreview: "ready" }])
    page.openStream()
    expect(page.streams).toHaveLength(1)
    expect(page.streams[0].closed).toBe(false)
  })

  it("lets go of the stream while hidden and takes it up again when shown", () => {
    const { es, updates } = page.openStream()
    page.streams[0].open()

    page.say("hidden")
    expect(page.streams[0].closed).toBe(true)
    // Let go of, not closed: it will connect again.
    expect((es as unknown as { readyState: number }).readyState).toBe(0)

    page.say("shown")
    expect(page.streams).toHaveLength(2)
    expect(page.streams[1].url).toBe(page.streams[0].url)
    // officecli goes on listening on the object it holds.
    page.streams[1].send("update", { action: "word-patch", version: 4 })
    expect(updates).toEqual([{ action: "word-patch", version: 4 }])
  })

  it("catches up on what changed while it was hidden", async () => {
    const { updates } = page.openStream()
    page.streams[0].open()
    page.streams[0].send("update", { action: "word-patch", version: 4 })
    page.say("hidden")
    page.document.version = 6

    page.say("shown")
    await settle()
    // Asked only once the stream is open, so no edit falls in between.
    expect(page.statusAsks()).toBe(0)
    page.streams[1].open()
    await settle()

    expect(page.statusAsks()).toBe(1)
    expect(updates).toEqual([
      { action: "word-patch", version: 4 },
      { action: "full", version: 6 },
    ])
  })

  it("leaves a document nothing changed in alone when shown again", async () => {
    const { updates } = page.openStream()
    page.streams[0].open()
    page.streams[0].send("update", { action: "word-patch", version: 4 })
    page.document.version = 4
    page.say("hidden")
    page.say("shown")
    page.streams[1].open()
    await settle()

    expect(updates).toEqual([{ action: "word-patch", version: 4 }])
  })

  it("goes by the version the proxy read before the page until an update says more", async () => {
    // Nothing is asked as the page loads: an answer arriving after an edit
    // could claim a version the page does not show.
    expect(page.statusAsks()).toBe(0)
    // Loaded at 3, and no update since: back at 3 is up to date…
    const { updates } = page.openStream()
    page.streams[0].open()
    page.say("hidden")
    page.say("shown")
    page.streams[1].open()
    await settle()
    expect(updates).toEqual([])

    // …and at 5, not.
    page.say("hidden")
    page.document.version = 5
    page.say("shown")
    page.streams[2].open()
    await settle()
    expect(updates).toEqual([{ action: "full", version: 5 }])
  })

  it("does not take the marks' version for the document's", async () => {
    const { updates } = page.openStream()
    page.streams[0].open()
    page.streams[0].send("update", {
      action: "mark-update",
      version: 9,
      marks: [],
    })
    page.say("hidden")
    page.document.version = 7
    page.say("shown")
    page.streams[1].open()
    await settle()

    expect(updates[updates.length - 1]).toEqual({ action: "full", version: 7 })
  })

  it("opens no stream for a page hidden before officecli opened one", async () => {
    page.say("hidden")
    const { updates } = page.openStream()
    expect(page.streams).toHaveLength(0)

    page.document.version = 4
    page.say("shown")
    expect(page.streams).toHaveLength(1)
    page.streams[0].open()
    await settle()
    expect(updates).toEqual([{ action: "full", version: 4 }])
  })

  it("catches up the first time it is shown again when the version it loaded at is unknown", async () => {
    page = loadPage(3, "-1")
    const { updates } = page.openStream()
    page.streams[0].open()
    page.say("hidden")
    page.say("shown")
    page.streams[1].open()
    await settle()
    expect(updates).toEqual([{ action: "full", version: 3 }])

    // From then on it knows.
    page.say("hidden")
    page.say("shown")
    page.streams[2].open()
    await settle()
    expect(updates).toHaveLength(1)
  })

  it("catches up anyway when the watch will not tell its version", async () => {
    const { updates } = page.openStream()
    page.streams[0].open()
    page.say("hidden")
    page.document.statusFails = true
    page.say("shown")
    page.streams[1].open()
    await settle()
    expect(updates).toEqual([{ action: "full" }])
  })

  it("heeds only the app", () => {
    page.openStream()
    page.say("hidden", { postMessage: () => {} })
    page.say("hidden", null)
    expect(page.streams[0].closed).toBe(false)
  })

  it("stays closed once officecli closes it", () => {
    const { es } = page.openStream()
    ;(es as unknown as { close: () => void }).close()
    expect(page.streams[0].closed).toBe(true)
    page.say("hidden")
    page.say("shown")
    expect(page.streams).toHaveLength(1)
    expect((es as unknown as { readyState: number }).readyState).toBe(2)
  })
})

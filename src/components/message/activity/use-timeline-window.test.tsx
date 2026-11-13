import { useRef } from "react"
import { act, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useTimelineWindow, type WindowRow } from "./use-timeline-window"

const ROW_PX = 50
const GAP_PX = 8 // the hook's default gap: jsdom lays out no margins

function rowsOf(prefix: string, count: number): WindowRow[] {
  return Array.from({ length: count }, (_, i) => ({ key: `${prefix}${i}` }))
}

function List({
  testId,
  scope,
  rows,
  follow = false,
}: {
  testId: string
  scope: string
  rows: WindowRow[]
  follow?: boolean
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const { span } = useTimelineWindow({
    listRef,
    scope,
    rows,
    estimate: () => ROW_PX,
    follow,
  })
  const start = span?.start ?? 0
  const end = span?.end ?? rows.length
  return (
    <ul ref={listRef} data-testid={testId}>
      {span && span.before > 0 ? (
        <li
          data-marker="spacer"
          data-side="before"
          style={{ height: span.before }}
        />
      ) : null}
      {rows.slice(start, end).map((row) => (
        <li key={row.key} data-step-key={row.key}>
          {row.key}
        </li>
      ))}
      {span && span.after > 0 ? (
        <li data-marker="spacer" data-side="after" />
      ) : null}
    </ul>
  )
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 600,
    bottom: top + height,
    width: 600,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useTimelineWindow", () => {
  it("follows the scroll of a plain overflowing box it sits in", async () => {
    // The sub-agent drawer: a transcript outside the virtual list, scrolling
    // in a box of its own whose scrolling never reaches the page.
    const rows = rowsOf("drawer-", 300)
    let scrollTop = 0
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "port") return rect(0, 500)
        if (this.dataset.testid === "list") {
          return rect(-scrollTop, 300 * ROW_PX)
        }
        return rect(0, 0)
      }
    )
    const view = render(
      <div data-testid="port" style={{ overflowY: "auto" }}>
        <List testId="list" scope="item" rows={rows} />
      </div>
    )
    const port = view.getByTestId("port")
    // Placed once it has mounted, at the top.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(view.getByText("drawer-0")).toBeTruthy()
    expect(view.queryByText("drawer-200")).toBeNull()

    scrollTop = 200 * (ROW_PX + GAP_PX)
    port.scrollTop = scrollTop
    act(() => {
      port.dispatchEvent(new Event("scroll"))
    })
    await waitFor(() => expect(view.getByText("drawer-200")).toBeTruthy())
    expect(view.queryByText("drawer-0")).toBeNull()
  })

  it("keeps a group's height apart from its first member's, which shares its key", () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    // A timeline whose first row is a tall group, keyed by its first member.
    const timelineRows = [{ key: "shared" }, ...rowsOf("timeline-", 149)]
    const timeline = render(
      <List testId="timeline" scope="item" rows={timelineRows} />
    )
    const timelineList = timeline.getByTestId("timeline")
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this === timelineList) return rect(0, 10_000)
        if (this.dataset.stepKey === "shared") return rect(0, 2000)
        if (this.dataset.stepKey !== undefined) return rect(0, ROW_PX)
        return rect(0, 0)
      })
    act(() => {
      for (const callback of callbacks) {
        callback([], {} as ResizeObserver)
      }
    })
    measure.mockRestore()
    timeline.unmount()

    // The group's members, live: drawn at their end, the first a spacer away
    // at a member's height — not the whole group's.
    const memberRows = [{ key: "shared" }, ...rowsOf("member-", 149)]
    const members = render(
      <List testId="members" scope="member" rows={memberRows} follow />
    )
    const before = members.container.querySelector<HTMLElement>(
      'li[data-side="before"]'
    )
    // Live, a list mounts on its last rows: the 110 before stand at their
    // estimate, the shared first one included.
    const above = memberRows.length - 40
    expect(Number.parseFloat(before!.style.height)).toBe(
      above * ROW_PX + (above - 1) * GAP_PX
    )
  })

  it("keeps the view still when a row above it grows down across its top", () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    let rowHeight = 28
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "port") return rect(0, 500)
        if (this.dataset.testid === "list") return rect(-700, 150 * ROW_PX)
        // Wholly above the view (bottom at -46), until it grows past its top.
        if (this.dataset.stepKey === "grow-5") {
          const port = document.querySelector<HTMLElement>(
            '[data-testid="port"]'
          )!
          return rect(-74 - (port.scrollTop - 700), rowHeight)
        }
        if (this.dataset.stepKey !== undefined) return rect(0, ROW_PX)
        return rect(0, 0)
      }
    )
    const view = render(
      <div data-testid="port" style={{ overflowY: "auto" }}>
        <List testId="list" scope="item" rows={rowsOf("grow-", 150)} />
      </div>
    )
    const port = view.getByTestId("port")
    // Read mid-way: not resting at the bottom.
    Object.defineProperty(port, "scrollHeight", { value: 10_000 })
    Object.defineProperty(port, "clientHeight", { value: 500 })
    port.scrollTop = 700
    const row = view.getByText("grow-5")
    const report = () => {
      act(() => {
        for (const callback of callbacks) {
          callback(
            [{ target: row } as unknown as ResizeObserverEntry],
            {} as ResizeObserver
          )
        }
      })
    }
    report() // first sight: a size, nothing moved
    expect(port.scrollTop).toBe(700)
    rowHeight = 228
    report()
    expect(port.scrollTop).toBe(900)
    rowHeight = 28
    report()
    expect(port.scrollTop).toBe(700)
  })

  it("does not move for a row straddling the view's top that a row above pulled up", () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    // Row 3 wholly above the view; row 5 across its top (-20 to +8).
    let above = 228
    let across = 28
    const scrolled = () =>
      document.querySelector<HTMLElement>('[data-testid="port"]')!.scrollTop -
      700
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "port") return rect(0, 500)
        // Drawn from its head, rows 3 and 5 among them; only their own
        // rects matter to what moves.
        if (this.dataset.testid === "list") return rect(0, 150 * ROW_PX)
        if (this.dataset.stepKey === "mix-3") {
          return rect(-400 - scrolled(), above)
        }
        if (this.dataset.stepKey === "mix-5") {
          return rect(-20 - scrolled() + (above - 228), across)
        }
        if (this.dataset.stepKey !== undefined) return rect(0, ROW_PX)
        return rect(0, 0)
      }
    )
    const view = render(
      <div data-testid="port" style={{ overflowY: "auto" }}>
        <List testId="list" scope="item" rows={rowsOf("mix-", 150)} />
      </div>
    )
    const port = view.getByTestId("port")
    Object.defineProperty(port, "scrollHeight", { value: 10_000 })
    Object.defineProperty(port, "clientHeight", { value: 500 })
    port.scrollTop = 700
    const rows = [view.getByText("mix-5"), view.getByText("mix-3")]
    const report = () => {
      act(() => {
        for (const callback of callbacks) {
          callback(
            rows.map(
              (target) => ({ target }) as unknown as ResizeObserverEntry
            ),
            {} as ResizeObserver
          )
        }
      })
    }
    report()
    expect(port.scrollTop).toBe(700)
    // One batch: the row above shrinks by 200, the one across the top grows
    // by 200. Only the shrink above the view moves what is in view.
    above = 28
    across = 228
    report()
    expect(port.scrollTop).toBe(500)
  })
})

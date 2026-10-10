import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"

import { stableTabViewOrder } from "./tab-view-order"

type Tab = { id: string }
const tabs = (...ids: string[]): Tab[] => ids.map((id) => ({ id }))

describe("stableTabViewOrder", () => {
  it("emits the same order for every permutation of the same tabs", () => {
    const a = stableTabViewOrder(tabs("conv-2", "draft-9", "conv-1"))
    const b = stableTabViewOrder(tabs("conv-1", "conv-2", "draft-9"))
    expect(a.map((v) => v.tab.id)).toEqual(["conv-1", "conv-2", "draft-9"])
    expect(b.map((v) => v.tab.id)).toEqual(a.map((v) => v.tab.id))
  })

  it("carries each tab's strip position as its visual index", () => {
    const views = stableTabViewOrder(tabs("conv-2", "draft-9", "conv-1"))
    expect(
      Object.fromEntries(views.map((v) => [v.tab.id, v.visualIndex]))
    ).toEqual({ "conv-2": 0, "draft-9": 1, "conv-1": 2 })
  })

  it("returns an empty list for an empty group", () => {
    expect(stableTabViewOrder([])).toEqual([])
  })
})

/**
 * The behaviour the order exists for. A keyed list rendered in strip order is
 * reconciled by MOVING DOM nodes on a reorder, and a moved node loses its
 * scroll offset (Chromium and WebKit both reset scrollTop to 0 on reinsertion
 * and fire no scroll event, which strands the virtualized transcript on rows
 * the viewport no longer shows). jsdom keeps scrollTop, so the test watches for
 * the move itself: a reorder must not remove any existing view node from the
 * tree.
 */
function Views({ order, tiled }: { order: string[]; tiled: boolean }) {
  return (
    <div data-testid="row">
      {stableTabViewOrder(tabs(...order)).map(({ tab, visualIndex }) => (
        <div
          key={tab.id}
          data-view={tab.id}
          style={tiled ? { order: visualIndex } : undefined}
        />
      ))}
    </div>
  )
}

function removedNodesDuring(row: HTMLElement, change: () => void): Node[] {
  const observer = new MutationObserver(() => {})
  observer.observe(row, { childList: true })
  change()
  const removed = observer
    .takeRecords()
    .flatMap((record) => Array.from(record.removedNodes))
  observer.disconnect()
  return removed
}

function StripOrderViews({ order }: { order: string[] }) {
  return (
    <div data-testid="row">
      {order.map((id) => (
        <div key={id} data-view={id} />
      ))}
    </div>
  )
}

describe("conversation views across a strip reorder", () => {
  it("control: views rendered in strip order are moved by a reorder", () => {
    const { getByTestId, rerender } = render(
      <StripOrderViews order={["a", "b", "c", "d"]} />
    )
    const row = getByTestId("row")
    const removed = removedNodesDuring(row, () =>
      rerender(<StripOrderViews order={["d", "a", "c", "b"]} />)
    )
    expect(removed.length).toBeGreaterThan(0)
  })

  it("moves no view node when the strip order changes", () => {
    const { getByTestId, rerender } = render(
      <Views order={["a", "b", "c", "d"]} tiled={false} />
    )
    const row = getByTestId("row")
    const before = Array.from(row.children)
    const removed = removedNodesDuring(row, () =>
      rerender(<Views order={["d", "a", "c", "b"]} tiled={false} />)
    )
    expect(removed).toEqual([])
    expect(Array.from(row.children)).toEqual(before)
  })

  it("lays a tiled row out in strip order through CSS order", () => {
    const { getByTestId, rerender } = render(
      <Views order={["a", "b", "c"]} tiled />
    )
    const row = getByTestId("row")
    const removed = removedNodesDuring(row, () =>
      rerender(<Views order={["c", "a", "b"]} tiled />)
    )
    expect(removed).toEqual([])
    const orderOf = (id: string) =>
      (row.querySelector(`[data-view="${id}"]`) as HTMLElement).style.order
    expect([orderOf("c"), orderOf("a"), orderOf("b")]).toEqual(["0", "1", "2"])
  })

  it("only inserts the new node when a tab opens", () => {
    const { getByTestId, rerender } = render(
      <Views order={["b", "d"]} tiled={false} />
    )
    const row = getByTestId("row")
    const removed = removedNodesDuring(row, () =>
      rerender(<Views order={["b", "d", "a"]} tiled={false} />)
    )
    expect(removed).toEqual([])
  })

  it("is what the conversation panel renders its group views through", () => {
    const panel = readFileSync(
      resolve(
        process.cwd(),
        "src/components/conversations/conversation-detail-panel.tsx"
      ),
      "utf8"
    )
    // The wrapper's index is the tab's STRIP position: it becomes the tile's
    // CSS `order` and decides which tile goes without a left border, so the
    // view's position in the id-sorted list must never reach it.
    expect(panel).toMatch(
      /stableTabViewOrder\(groupTabs\)\.map\(\(\{ tab, visualIndex \}\) =>\s*renderTabWrapper\(tab, visualIndex, groupId, canTileG\)/
    )
    expect(panel).toMatch(/style=\{canTileG \? \{ order: indexInGroup \}/)
  })
})

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  dismissAllBrowserDownloads,
  dismissBrowserDownload,
  getBrowserDownloads,
  hydrateBrowserDownloads,
  resetBrowserDownloadsForTests,
  setBrowserDownload,
  useBrowserTabDownloads,
} from "./browser-downloads-store"
import type { BrowserDownload } from "./types"

function download(over: Partial<BrowserDownload> = {}): BrowserDownload {
  return {
    id: "dl-1",
    tabId: "abc",
    url: "https://example.com/a.bin",
    fileName: "a.bin",
    path: "/Users/dev/Downloads/a.bin",
    state: "started",
    ...over,
  }
}

describe("browser downloads store", () => {
  beforeEach(() => resetBrowserDownloadsForTests())
  afterEach(() => resetBrowserDownloadsForTests())

  it("keeps records newest first and updates one in place", () => {
    setBrowserDownload(download())
    setBrowserDownload(download({ id: "dl-2", fileName: "b.bin" }))
    expect(getBrowserDownloads().map((d) => d.id)).toEqual(["dl-2", "dl-1"])

    setBrowserDownload(download({ state: "completed" }))
    expect(getBrowserDownloads().map((d) => d.id)).toEqual(["dl-2", "dl-1"])
    expect(getBrowserDownloads()[1].state).toBe("completed")
  })

  it("hydrates from the backend list, whose order is oldest first", () => {
    hydrateBrowserDownloads([download({ id: "old" }), download({ id: "new" })])
    expect(getBrowserDownloads().map((d) => d.id)).toEqual(["new", "old"])
  })

  // `useSyncExternalStore` compares snapshots by identity: a fresh array per
  // read would re-render forever.
  it("returns a stable list per tab until something changes", () => {
    setBrowserDownload(download())
    setBrowserDownload(download({ id: "dl-2", tabId: "other" }))
    const { result, rerender } = renderHook(() =>
      useBrowserTabDownloads("browser:abc")
    )
    const first = result.current
    expect(first.map((d) => d.id)).toEqual(["dl-1"])
    rerender()
    expect(result.current).toBe(first)

    act(() => setBrowserDownload(download({ state: "completed" })))
    expect(result.current).not.toBe(first)
    expect(result.current[0].state).toBe("completed")
  })

  it("hides dismissed records without touching the list", () => {
    setBrowserDownload(download())
    setBrowserDownload(download({ id: "dl-2" }))
    const { result } = renderHook(() => useBrowserTabDownloads("browser:abc"))
    expect(result.current).toHaveLength(2)

    act(() => dismissBrowserDownload("dl-2"))
    expect(result.current.map((d) => d.id)).toEqual(["dl-1"])
    // The record itself is still there; only the bar forgets it.
    expect(getBrowserDownloads()).toHaveLength(2)

    act(() => dismissAllBrowserDownloads())
    expect(result.current).toHaveLength(0)

    // A new download after a "dismiss all" shows up again.
    act(() => setBrowserDownload(download({ id: "dl-3" })))
    expect(result.current.map((d) => d.id)).toEqual(["dl-3"])
  })

  it("shows a download only in the tab that started it", () => {
    setBrowserDownload(download({ tabId: "abc" }))
    setBrowserDownload(download({ id: "dl-2", tabId: "xyz" }))
    const { result } = renderHook(() => useBrowserTabDownloads("browser:xyz"))
    expect(result.current.map((d) => d.id)).toEqual(["dl-2"])
  })
})

import { beforeEach, describe, expect, it } from "vitest"

import {
  browserWorkspaceTabId,
  getDocGuestState,
  removeBrowserTabState,
  resetBrowserTabStoreForTests,
  setDocGuestState,
  subscribeBrowserTabs,
} from "./browser-tab-store"
import type { DocGuestState } from "./types"

function doc(overrides: Partial<DocGuestState> = {}): DocGuestState {
  return {
    tabId: "doc-1",
    mode: "safe",
    root: "/tmp/site",
    entry: "/tmp/site/index.html",
    url: "codeg-doc://doc/index.html",
    reset: null,
    ...overrides,
  }
}

describe("document guest state in the tab store", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
  })

  it("is keyed like the tab state and notifies only on a change", () => {
    let notified = 0
    const unsubscribe = subscribeBrowserTabs(() => {
      notified += 1
    })
    setDocGuestState(doc())
    expect(getDocGuestState(browserWorkspaceTabId("doc-1"))?.mode).toBe("safe")
    expect(notified).toBe(1)
    // The same payload again is not a change.
    setDocGuestState(doc())
    expect(notified).toBe(1)
    setDocGuestState(doc({ mode: "dynamic" }))
    expect(getDocGuestState("browser:doc-1")?.mode).toBe("dynamic")
    expect(notified).toBe(2)
    unsubscribe()
  })

  it("goes away with the tab's state", () => {
    setDocGuestState(doc({ reset: { path: "app.js", reason: "newer" } }))
    removeBrowserTabState("browser:doc-1")
    expect(getDocGuestState("browser:doc-1")).toBeNull()
  })
})

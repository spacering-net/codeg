import { afterEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_SHORTCUTS, matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import {
  closeShortcutOrigin,
  MENU_CLOSE_CHORD,
  tabShortcutTarget,
  workspacePaneOf,
} from "@/lib/menu-close-shortcut"

function mount(html: string): void {
  document.body.innerHTML = html
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} is not in the document`)
  return element
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("closeShortcutOrigin", () => {
  it("stands a focused surface for the placeholder it is fitted to", () => {
    mount(
      `<div data-browser-surface="other"></div>
       <div id="slot" data-browser-surface="tab-1"></div>`
    )
    expect(closeShortcutOrigin("tab-1")).toEqual({
      kind: "element",
      element: byId("slot"),
    })
  })

  it("takes the visible placeholder of a tab shown in two places", () => {
    mount(
      `<div id="column" data-browser-surface="tab-1"></div>
       <div id="panel" data-browser-surface="tab-1"></div>`
    )
    // The file column, CSS-hidden under a full-page route; the side panel
    // over it is where the page is.
    byId("column").checkVisibility = () => false
    byId("panel").checkVisibility = () => true
    expect(closeShortcutOrigin("tab-1")).toEqual({
      kind: "element",
      element: byId("panel"),
    })
  })

  it("cannot place a surface this document does not show", () => {
    mount(`<div id="slot" data-browser-surface="tab-1"></div>`)
    expect(closeShortcutOrigin("tab-2")).toEqual({ kind: "unknown" })
    byId("slot").checkVisibility = () => false
    expect(closeShortcutOrigin("tab-1")).toEqual({ kind: "unknown" })
  })

  it("names the focused iframe when the keystroke was inside one", () => {
    mount(`<iframe id="frame"></iframe>`)
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    vi.spyOn(document, "activeElement", "get").mockReturnValue(byId("frame"))
    expect(closeShortcutOrigin(null)).toEqual({
      kind: "element",
      element: byId("frame"),
    })
  })

  it("reports the page itself when focus was in this document", () => {
    mount(`<button id="button">x</button>`)
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    byId("button").focus()
    expect(closeShortcutOrigin(null)).toEqual({ kind: "page" })
  })

  it("reports the window when no view had keyboard focus", () => {
    mount(`<iframe id="frame"></iframe>`)
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    vi.spyOn(document, "activeElement", "get").mockReturnValue(byId("frame"))
    expect(closeShortcutOrigin(null)).toEqual({ kind: "window" })
  })
})

describe("workspacePaneOf", () => {
  it("finds the pane an element sits in", () => {
    mount(
      `<div data-workspace-pane="files"><div><iframe id="frame"></iframe></div></div>
       <div data-workspace-pane="conversation"><div id="slot"></div></div>`
    )
    expect(workspacePaneOf(byId("frame"))).toBe("files")
    expect(workspacePaneOf(byId("slot"))).toBe("conversation")
  })

  it("is null outside both panes", () => {
    mount(
      `<div id="panel"></div><div data-workspace-pane="nope"><div id="odd"></div></div>`
    )
    expect(workspacePaneOf(byId("panel"))).toBeNull()
    expect(workspacePaneOf(byId("odd"))).toBeNull()
  })
})

describe("tabShortcutTarget", () => {
  it("acts on the conversation strip when there is no file column", () => {
    expect(tabShortcutTarget("conversation", "files", false)).toEqual({
      conversation: true,
      files: false,
    })
  })

  it("follows the pane in a split", () => {
    expect(tabShortcutTarget("fusion", "conversation", false)).toEqual({
      conversation: true,
      files: false,
    })
    expect(tabShortcutTarget("fusion", "files", false)).toEqual({
      conversation: false,
      files: true,
    })
  })

  it("acts on the files strip while it is maximized, whatever the pane", () => {
    expect(tabShortcutTarget("fusion", "conversation", true)).toEqual({
      conversation: false,
      files: true,
    })
  })
})

describe("MENU_CLOSE_CHORD", () => {
  it("is the default close-tab shortcut and nothing near it", () => {
    expect(
      matchShortcutEvent(MENU_CLOSE_CHORD, DEFAULT_SHORTCUTS.close_current_tab)
    ).toBe(true)
    expect(
      matchShortcutEvent(
        MENU_CLOSE_CHORD,
        DEFAULT_SHORTCUTS.close_all_file_tabs
      )
    ).toBe(false)
  })
})

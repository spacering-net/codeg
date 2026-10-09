import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { createRef, type RefObject } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SuggestionPopup } from "./suggestion-popup"
import type {
  ReferenceSearch,
  SuggestionGroup,
  SuggestionPopupHandle,
} from "./types"

// Distinct, non-colliding text: a row's label must differ from its detail and
// from the agent icon's <title> ("Codex") so findByText is unambiguous.
const fileRef = {
  refType: "file" as const,
  id: "alpha.md",
  label: "alpha.md",
  uri: "file:///docs/alpha.md",
  meta: null,
}
const agentRef = {
  refType: "agent" as const,
  id: "codex",
  label: "Codex Helper",
  uri: "codeg://agent/codex",
  meta: { agentType: "codex" as const },
}
const agentRef2 = {
  refType: "agent" as const,
  id: "claude_code",
  // Label must differ from the AgentIcon's <title> ("Claude Code") so a plain
  // text query is unambiguous (the title text is in the DOM even when decorative).
  label: "Claude Helper",
  uri: "codeg://agent/claude_code",
  meta: { agentType: "claude_code" as const },
}

// The provider keeps file-first order; the panel reorders to agent-first tabs.
const groups: SuggestionGroup[] = [
  {
    kind: "file",
    label: "Files",
    items: [{ reference: fileRef, detail: "docs/alpha.md" }],
  },
  {
    kind: "agent",
    label: "Agents",
    items: [{ reference: agentRef }, { reference: agentRef2 }],
  },
]

const search: ReferenceSearch = () => groups
const emptySearch: ReferenceSearch = () => []

const state = {
  query: "a",
  range: { from: 1, to: 3 },
  getClientRect: () => null,
}

function mountPopup(
  overrides: Partial<Parameters<typeof SuggestionPopup>[0]> = {}
) {
  const ref = createRef<SuggestionPopupHandle>()
  const onSelect = vi.fn()
  const onClose = vi.fn()
  render(
    <SuggestionPopup
      ref={ref}
      state={state}
      search={search}
      onSelect={onSelect}
      onClose={onClose}
      {...overrides}
    />
  )
  return { ref, onSelect, onClose }
}

function key(name: string, shiftKey = false): KeyboardEvent {
  return { key: name, shiftKey } as KeyboardEvent
}

const spawnedHosts: HTMLElement[] = []

/**
 * An anchor nested one level down, so a test can hide the *ancestor* — which is
 * how the app hides a kept-mounted conversation — rather than the anchor itself.
 * Returns the wrapper (to hide) and a ref to hand the panel.
 */
function mountAnchor() {
  const host = document.createElement("div")
  const anchor = document.createElement("div")
  host.appendChild(anchor)
  document.body.appendChild(host)
  spawnedHosts.push(host)
  const anchorRef: RefObject<HTMLElement | null> = { current: anchor }
  return { host, anchor, anchorRef }
}

/** The portal's positioning layer (the panel's parent). */
function popupLayer() {
  const panel = screen.getByTestId("mention-popup")
  const layer = panel.parentElement
  if (!layer) throw new Error("popup layer missing")
  return layer
}

describe("SuggestionPopup", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Only the anchors this file appended — Testing Library owns (and removes)
    // its own container, and racing it there throws on cleanup.
    for (const host of spawnedHosts.splice(0)) host.remove()
  })

  it("goes invisible with a host that was hidden but not unmounted", async () => {
    const { host, anchorRef } = mountAnchor()
    mountPopup({ anchorRef })
    await screen.findByText("Codex Helper")
    expect(popupLayer().style.visibility).toBe("visible")

    // What the workbench does when a route (Automations, Tasks, …) covers the
    // still-mounted conversation, and when the inactive conversation tab steps
    // aside: flip a class on an ancestor. `visibility` inherits down to the
    // anchor — but the panel portals to `body`, outside that subtree, so it
    // used to keep painting over whatever replaced its host.
    act(() => {
      host.style.visibility = "hidden"
    })
    await waitFor(() => expect(popupLayer().style.visibility).toBe("hidden"))
    expect(popupLayer().style.pointerEvents).toBe("none")

    // Hidden, not closed: coming back restores it, exactly like the in-tree `/`
    // menu, which never had to do anything to get this.
    act(() => {
      host.style.visibility = ""
    })
    await waitFor(() => expect(popupLayer().style.visibility).toBe("visible"))
    expect(popupLayer().style.pointerEvents).toBe("auto")
  })

  it("re-adopts the anchor's width when the composer box is resized", async () => {
    // Sidebar collapse, a resizable panel drag, the composer growing a line:
    // the box changes with no `resize` and no `scroll` event anywhere, so a
    // ResizeObserver on the anchor is the only thing that notices.
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
    // Pin the per-frame move watcher shut, so only the ResizeObserver path can
    // move the panel here — otherwise this test would still pass with that
    // wiring deleted.
    vi.stubGlobal("requestAnimationFrame", () => 0)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const { anchor, anchorRef } = mountAnchor()
    let width = 600
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: 0,
          top: 0,
          right: width,
          bottom: 40,
          width,
          height: 40,
        }) as DOMRect
    )
    mountPopup({ anchorRef })
    await screen.findByText("Codex Helper")
    await waitFor(() =>
      expect(screen.getByTestId("mention-popup").style.width).toBe("600px")
    )

    width = 900
    act(() => {
      for (const callback of callbacks) {
        callback([], {} as ResizeObserver)
      }
    })
    await waitFor(() =>
      expect(screen.getByTestId("mention-popup").style.width).toBe("900px")
    )
  })

  it("follows an anchor that moves without resizing", async () => {
    // The sidebar animating open slides the centred (max-w-3xl) composer
    // sideways at a constant width: no `resize`, no `scroll`, nothing for a
    // ResizeObserver to see, and no event marking the end of the animation.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal("cancelAnimationFrame", () => {})
    // Deaf observer: only the per-frame watcher can drive this one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    const { anchor, anchorRef } = mountAnchor()
    let left = 100
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left,
          top: 500,
          right: left + 600,
          bottom: 540,
          width: 600,
          height: 40,
        }) as DOMRect
    )
    mountPopup({ anchorRef })
    await screen.findByText("Codex Helper")
    await waitFor(() => expect(popupLayer().style.left).toBe("100px"))

    left = 300
    act(() => {
      for (const frame of frames.splice(0)) frame(0)
    })
    await waitFor(() => expect(popupLayer().style.left).toBe("300px"))
  })

  it("renders the active (agent-first) tab's options plus a four-tab strip", async () => {
    mountPopup()
    // Agent is the first non-empty tab, so its options show by default.
    expect(await screen.findByText("Codex Helper")).toBeInTheDocument()
    expect(screen.getByText("Claude Helper")).toBeInTheDocument()
    // The file tab's option is hidden until that tab is active.
    expect(screen.queryByText("alpha.md")).toBeNull()
    // Four fixed tabs (no skill tab), agent selected.
    expect(screen.getAllByRole("tab")).toHaveLength(4)
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Agents/
    )
  })

  it("drops a hidden kind's tab and never offers its rows", async () => {
    // The provider still returns the agent group; the panel must not show it.
    const { ref, onSelect } = mountPopup({ hiddenKinds: ["agent"] })
    expect(await screen.findByText("alpha.md")).toBeInTheDocument()
    expect(screen.queryByText("Codex Helper")).toBeNull()
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(3)
    expect(tabs.map((tab) => tab.textContent)).not.toContain("Agents")
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Files/
    )
    // Tab cycling skips the hidden kind: three presses wrap back to Files.
    for (let i = 0; i < 3; i++) {
      act(() => {
        ref.current?.onKeyDown(key("Tab"))
      })
    }
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Files/
    )
    act(() => {
      ref.current?.onKeyDown(key("Enter"))
    })
    expect(onSelect).toHaveBeenCalledWith(fileRef, state.range)
  })

  it("packs the detail beside the label so it can use the row's spare width", async () => {
    // The panel is as wide as the composer box, so a label that stretches shoves
    // the detail against the far edge — and a hard width cap on the detail then
    // truncates it there with hundreds of spare pixels beside it (the layout
    // this replaced). The label keeps its content width; the detail takes the
    // slack and truncates only when the row really is too narrow.
    const detailedSearch: ReferenceSearch = () => [
      {
        kind: "agent",
        label: "Agents",
        items: [{ reference: agentRef, detail: "ACP adapter for Codex" }],
      },
    ]
    mountPopup({ search: detailedSearch })
    const detail = await screen.findByText("ACP adapter for Codex")
    expect(detail).toHaveClass("min-w-0", "grow", "basis-24", "truncate")
    expect(detail.className).not.toMatch(/\bmax-w-/)
    const label = screen.getByText("Codex Helper")
    expect(label).toHaveClass("min-w-0", "truncate")
    expect(label.className).not.toMatch(/\b(flex-1|grow|basis-)/)
    // Logical alignment: under Arabic (`dir="rtl"`) a physical `text-left` would
    // pin the grown detail's text to the far edge and mirror the void back in.
    const row = screen.getByRole("option", { name: /Codex Helper/ })
    expect(row).toHaveClass("text-start")
    expect(row).not.toHaveClass("text-left")
  })

  it("shows an empty state (but keeps the tabs) when there are no matches", async () => {
    mountPopup({ search: emptySearch, emptyLabel: "Nothing" })
    const panel = screen.getByTestId("mention-popup")
    expect(await within(panel).findByText("Nothing")).toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(4)
  })

  it("selects the active tab's highlighted row on Enter (default = first agent)", async () => {
    const { ref, onSelect } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => {
      expect(ref.current?.onKeyDown(key("Enter"))).toBe(true)
    })
    expect(onSelect).toHaveBeenCalledWith(agentRef, state.range)
  })

  it("moves the selection with ArrowDown within the active tab", async () => {
    const { ref, onSelect } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => ref.current?.onKeyDown(key("ArrowDown")))
    act(() => ref.current?.onKeyDown(key("Enter")))
    expect(onSelect).toHaveBeenCalledWith(agentRef2, state.range)
  })

  it("wraps the selection with ArrowUp from the first row", async () => {
    const { ref, onSelect } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => ref.current?.onKeyDown(key("ArrowUp")))
    act(() => ref.current?.onKeyDown(key("Enter")))
    expect(onSelect).toHaveBeenCalledWith(agentRef2, state.range)
  })

  it("switches to the next tab with Tab and reveals its options", async () => {
    const { ref, onSelect } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => {
      expect(ref.current?.onKeyDown(key("Tab"))).toBe(true)
    })
    // agent → file; the file option appears and the agent options are gone.
    expect(await screen.findByText("alpha.md")).toBeInTheDocument()
    expect(screen.queryByText("Codex Helper")).toBeNull()
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Files/
    )
    // Tab does not select.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("wraps to the last tab with Shift+Tab", async () => {
    const { ref } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => ref.current?.onKeyDown(key("Tab", true)))
    // agent (first) wraps backwards to commit (last in tab order); it's empty.
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
      /Commits/
    )
  })

  it("switches tabs on click, preventing default on mousedown to keep editor focus", async () => {
    mountPopup()
    await screen.findByText("Codex Helper")
    const filesTab = screen.getByRole("tab", { name: /Files/ })
    // mousedown preventDefault keeps focus in the editor (no blur)...
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      filesTab.dispatchEvent(down)
    })
    expect(down.defaultPrevented).toBe(true)
    // ...and the click performs the switch (so AT / synthetic click works too).
    act(() => {
      fireEvent.click(filesTab)
    })
    expect(await screen.findByText("alpha.md")).toBeInTheDocument()
    expect(screen.queryByText("Codex Helper")).toBeNull()
  })

  it("closes on Escape and reports the key as consumed", async () => {
    const { ref, onClose } = mountPopup()
    await screen.findByText("Codex Helper")
    let consumed = false
    act(() => {
      consumed = ref.current?.onKeyDown(key("Escape")) ?? false
    })
    expect(consumed).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it("does not consume unrelated keys", async () => {
    const { ref } = mountPopup()
    await screen.findByText("Codex Helper")
    expect(ref.current?.onKeyDown(key("x"))).toBe(false)
  })

  it("does not select stale results after the query changes", async () => {
    const ref = createRef<SuggestionPopupHandle>()
    const onSelect = vi.fn()
    const view = (query: string, to: number) => (
      <SuggestionPopup
        ref={ref}
        state={{ query, range: { from: 1, to }, getClientRect: () => null }}
        search={search}
        onSelect={onSelect}
        onClose={vi.fn()}
        loadingLabel="Loading"
      />
    )
    const { rerender } = render(view("a", 2))
    await screen.findByText("Codex Helper") // fresh results for "a"

    // Query advances; the shown results now answer the *previous* query.
    rerender(view("ab", 3))
    expect(screen.queryByText("Codex Helper")).toBeNull()
    expect(
      within(screen.getByTestId("mention-popup")).getByText("Loading")
    ).toBeInTheDocument()

    // Declined, not swallowed: with nothing to insert the key belongs to the
    // editor. Android's soft keyboard reaches this path through a synthetic
    // Enter that ProseMirror fires *after* applying the DOM change, and a
    // `true` there would make it drop the change (the user's newline).
    let handled: boolean | undefined
    act(() => {
      handled = ref.current?.onKeyDown(key("Enter"))
    })
    expect(handled).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("selects on click (mousedown) and prevents default to keep editor focus", async () => {
    const { onSelect } = mountPopup()
    const label = await screen.findByText("Codex Helper")
    const button = label.closest("button")
    expect(button).not.toBeNull()
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      button?.dispatchEvent(event)
    })
    expect(onSelect).toHaveBeenCalledWith(agentRef, state.range)
    // preventDefault keeps focus in the editor rather than the popup button.
    expect(event.defaultPrevented).toBe(true)
  })

  it("positions and reveals the caret-anchored panel once measured", async () => {
    render(
      <SuggestionPopup
        ref={createRef<SuggestionPopupHandle>()}
        state={{
          query: "a",
          range: { from: 1, to: 3 },
          getClientRect: () =>
            ({ left: 100, top: 600, bottom: 620 }) as DOMRect,
        }}
        search={search}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await screen.findByText("Codex Helper")
    const container = screen.getByTestId("mention-popup")
      .parentElement as HTMLElement
    // The layout effect measured the panel and clamped/flipped it into view.
    expect(container.style.visibility).toBe("visible")
    expect(container.style.position).toBe("fixed")
    expect(container.dataset.placement).toBeTruthy()
    // The panel portals to `body`, which a modal Radix layer (a Dialog hosting
    // the composer) sets to `pointer-events: none`. Without its own
    // `auto` the panel is click-dead inside one, and the press lands on the
    // document — which that layer reads as an outside press and closes itself.
    expect(container.style.pointerEvents).toBe("auto")
  })

  it("clamps the rendered panel coordinates into the viewport", async () => {
    // A real (nonzero) panel size lets the viewport clamp actually bite.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 288,
    } as DOMRect)
    render(
      <SuggestionPopup
        ref={createRef<SuggestionPopupHandle>()}
        state={{
          query: "a",
          range: { from: 1, to: 3 },
          // Caret hard against the right edge of the jsdom 1024px viewport.
          getClientRect: () =>
            ({ left: 1000, top: 600, bottom: 620 }) as DOMRect,
        }}
        search={search}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await screen.findByText("Codex Helper")
    const container = screen.getByTestId("mention-popup")
      .parentElement as HTMLElement
    // left clamps to 1024 - 320 - 8 = 696 (not the raw caret x of 1000).
    expect(container.style.left).toBe("696px")
    // Room above (600px) fits → placed above: 600 - 4 - 288 = 308.
    expect(container.style.top).toBe("308px")
    expect(container.dataset.placement).toBe("above")
  })

  it("adopts the anchor box's width and left edge, opening above it", async () => {
    // The panel measures itself through the prototype; the anchor shadows that
    // with its own rect (an own property wins over the spied prototype).
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 288,
    } as DOMRect)
    const box = document.createElement("div")
    document.body.appendChild(box)
    box.getBoundingClientRect = () =>
      ({ left: 40, top: 500, bottom: 620, width: 600 }) as DOMRect
    render(
      <SuggestionPopup
        ref={createRef<SuggestionPopupHandle>()}
        state={{
          query: "a",
          range: { from: 1, to: 3 },
          // Caret far from the box: the anchor wins, so this never shows up.
          getClientRect: () =>
            ({ left: 400, top: 610, bottom: 630 }) as DOMRect,
        }}
        search={search}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        anchorRef={{ current: box }}
      />
    )
    await screen.findByText("Codex Helper")
    const panel = screen.getByTestId("mention-popup")
    const container = panel.parentElement as HTMLElement
    // Same width as the composer, not the default w-80.
    expect(panel.style.width).toBe("600px")
    // Left edge follows the box (not the caret's 400)…
    expect(container.style.left).toBe("40px")
    // …and it sits above the box's TOP (500 - 4 - 288), clear of the composer,
    // rather than hugging the caret line inside it.
    expect(container.style.top).toBe("208px")
    expect(container.dataset.placement).toBe("above")
    box.remove()
  })

  it("re-anchors to the live caret rect on resize (not a stale snapshot)", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 288,
    } as DOMRect)
    let caretLeft = 100
    const getClientRect = vi.fn(
      () => ({ left: caretLeft, top: 600, bottom: 620 }) as DOMRect
    )
    render(
      <SuggestionPopup
        ref={createRef<SuggestionPopupHandle>()}
        state={{ query: "a", range: { from: 1, to: 3 }, getClientRect }}
        search={search}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )
    await screen.findByText("Codex Helper")
    const container = screen.getByTestId("mention-popup")
      .parentElement as HTMLElement
    expect(container.style.left).toBe("100px")
    // The caret reflows; a resize must re-read the live getter, not a snapshot.
    const before = getClientRect.mock.calls.length
    caretLeft = 300
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(getClientRect.mock.calls.length).toBeGreaterThan(before)
    expect(container.style.left).toBe("300px")
  })

  it("exposes listbox + option roles with the active option selected", async () => {
    mountPopup({ listboxLabel: "Mentions" })
    await screen.findByText("Codex Helper")
    // The listbox names the active tab and owns only that tab's options.
    const listbox = screen.getByRole("listbox", { name: "Mentions: Agents" })
    expect(listbox).toHaveAttribute("id", "mention-listbox")
    const options = within(listbox).getAllByRole("option")
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAttribute("aria-selected", "true")
    expect(options[0]).toHaveAttribute("id", "mention-option-agent-0")
    expect(options[1]).toHaveAttribute("aria-selected", "false")
    expect(options[1]).toHaveAttribute("id", "mention-option-agent-1")
  })

  it("keeps the decorative icon out of the option's accessible name", async () => {
    mountPopup()
    await screen.findByText("Codex Helper")
    // The agent row's AgentIcon is a titled <svg>; if it weren't decorative the
    // option would be named "Codex Codex Helper". The name must be just label.
    expect(
      screen.getByRole("option", { name: "Codex Helper" })
    ).toBeInTheDocument()
  })

  it("moves aria-selected with the keyboard", async () => {
    const { ref } = mountPopup()
    await screen.findByText("Codex Helper")
    act(() => ref.current?.onKeyDown(key("ArrowDown")))
    const options = screen
      .getByTestId("mention-popup")
      .querySelectorAll('[role="option"]')
    expect(options[0]).toHaveAttribute("aria-selected", "false")
    expect(options[1]).toHaveAttribute("aria-selected", "true")
  })

  it("announces the active tab + result count via a polite live region", async () => {
    mountPopup()
    await screen.findByText("Codex Helper")
    const status = screen.getByRole("status")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveTextContent("Agents: 2 results")
  })

  it("reports the active option id to the host for aria-activedescendant", async () => {
    const onActiveOptionChange = vi.fn()
    mountPopup({ onActiveOptionChange })
    await screen.findByText("Codex Helper")
    expect(onActiveOptionChange).toHaveBeenLastCalledWith(
      "mention-option-agent-0"
    )
  })

  it("reports a null active option while loading or empty", async () => {
    const onActiveOptionChange = vi.fn()
    mountPopup({
      search: emptySearch,
      onActiveOptionChange,
      emptyLabel: "None",
    })
    const panel = screen.getByTestId("mention-popup")
    await within(panel).findByText("None")
    expect(onActiveOptionChange).toHaveBeenLastCalledWith(null)
  })

  it("shows a non-selectable, aria-hidden hint for a truncated active tab", async () => {
    const truncatedSearch: ReferenceSearch = () => [
      {
        kind: "agent",
        label: "Agents",
        items: [{ reference: agentRef }],
        truncated: true,
      },
    ]
    mountPopup({ search: truncatedSearch, moreLabel: "More — keep typing" })
    await screen.findByText("Codex Helper")
    const panel = screen.getByTestId("mention-popup")
    const hint = within(panel).getByText("More — keep typing")
    // Decorative: hidden from AT (the live region announces truncation) and not
    // an option, so arrow/Enter can never land on it.
    expect(hint).toHaveAttribute("aria-hidden", "true")
    expect(panel.querySelectorAll('[role="option"]')).toHaveLength(1)
    // The polite live region also conveys truncation to screen readers.
    expect(screen.getByRole("status")).toHaveTextContent("More — keep typing")
  })
})

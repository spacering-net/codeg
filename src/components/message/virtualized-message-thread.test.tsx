import type { ReactNode, Ref, RefObject } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"

const testState = vi.hoisted(() => ({
  scrollRef: { current: null as HTMLDivElement | null },
  stopScroll: vi.fn(),
  virtuaScrollToIndex: vi.fn(),
  // The virtua handle's geometry: where the view is, where each row starts.
  scrollOffset: 0,
  viewportSize: 500,
  scrollSize: 5_000,
  itemOffset: (index: number) => index * 100,
  findItemIndex: vi.fn((offset: number) => Math.floor(offset / 100)),
  // The last `onScroll` virtua was handed.
  onScroll: undefined as undefined | ((offset: number) => void),
}))

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({
    scrollRef: testState.scrollRef,
    stopScroll: testState.stopScroll,
  }),
}))

vi.mock("virtua", async () => {
  const { useImperativeHandle } =
    await vi.importActual<typeof import("react")>("react")
  return {
    Virtualizer: ({
      children,
      ref,
      onScroll,
    }: {
      children: ReactNode
      ref?: Ref<unknown>
      onScroll?: (offset: number) => void
    }) => {
      testState.onScroll = onScroll
      useImperativeHandle(ref, () => ({
        scrollToIndex: testState.virtuaScrollToIndex,
        getItemOffset: (index: number) => testState.itemOffset(index),
        findItemIndex: (offset: number) => testState.findItemIndex(offset),
        get scrollOffset() {
          return testState.scrollOffset
        },
        get viewportSize() {
          return testState.viewportSize
        },
        get scrollSize() {
          return testState.scrollSize
        },
      }))
      return <>{children}</>
    },
  }
})

vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThreadContent: ({
    children,
    scrollClassName,
  }: {
    children: ReactNode
    scrollClassName?: string
  }) => (
    <div
      ref={(element) => {
        testState.scrollRef.current = element
      }}
      className={scrollClassName}
      data-testid="viewport"
    >
      {children}
    </div>
  ),
}))

import { VirtualizedMessageThread } from "@/components/message/virtualized-message-thread"

function renderThread(
  content: ReactNode = <div data-testid="content">text</div>
) {
  return render(
    <VirtualizedMessageThread
      items={[{ id: "message-1" }]}
      getItemKey={(item) => item.id}
      renderItem={() => content}
    />
  )
}

function pointerDown(element: HTMLElement, button: number) {
  fireEvent(element, new MouseEvent("pointerdown", { bubbles: true, button }))
}

function keyDown(
  element: HTMLElement,
  key: string,
  modifiers: Omit<KeyboardEventInit, "key"> = {}
) {
  fireEvent.keyDown(element, { key, ...modifiers })
}

beforeEach(() => {
  testState.scrollRef.current = null
  testState.stopScroll.mockReset()
  testState.virtuaScrollToIndex.mockReset()
  testState.scrollOffset = 0
  testState.viewportSize = 500
  testState.scrollSize = 5_000
  testState.itemOffset = (index: number) => index * 100
  testState.findItemIndex.mockClear()
  testState.onScroll = undefined
})

describe("VirtualizedMessageThread scroll API", () => {
  function renderWithScrollApi() {
    const scrollApiRef = {
      current: null,
    } as RefObject<MessageScrollContextValue | null>
    render(
      <VirtualizedMessageThread
        items={[{ id: "a" }, { id: "b" }]}
        getItemKey={(item) => item.id}
        renderItem={() => null}
        scrollApiRef={scrollApiRef}
        hasOlder
      />
    )
    return scrollApiRef
  }

  it("releases the stick-to-bottom lock before jumping up, past the loader row", () => {
    // Pinned at the bottom of a long thread; the target row starts far above.
    testState.scrollOffset = 5_000
    const scrollApiRef = renderWithScrollApi()
    scrollApiRef.current?.scrollToIndex(1, { align: "start", smooth: true })
    expect(testState.stopScroll).toHaveBeenCalledTimes(1)
    // Item 1 is virtua row 2: the loader row sits above the items.
    expect(testState.virtuaScrollToIndex).toHaveBeenCalledWith(2, {
      align: "start",
      smooth: true,
    })
    expect(testState.stopScroll.mock.invocationCallOrder[0]).toBeLessThan(
      testState.virtuaScrollToIndex.mock.invocationCallOrder[0]
    )
  })

  it.each([
    // The target row (virtua row 2, at 200px) starts inside the view…
    ["below the top of the view", 150],
    // …or exactly at its top.
    ["at the top of the view", 200],
  ])(
    "keeps the lock for a jump to a row starting %s",
    (_label, scrollOffset) => {
      // The jump can't move up, and a reply streaming in below must stay
      // followed.
      testState.scrollOffset = scrollOffset
      const scrollApiRef = renderWithScrollApi()
      scrollApiRef.current?.scrollToIndex(1, { align: "start", smooth: true })
      expect(testState.stopScroll).not.toHaveBeenCalled()
      expect(testState.virtuaScrollToIndex).toHaveBeenCalledWith(2, {
        align: "start",
        smooth: true,
      })
    }
  )
})

describe("VirtualizedMessageThread viewport top", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}` }))

  function renderWatched(
    onViewportTopChange?: (top: { index: number; atEnd: boolean }) => void
  ) {
    return render(
      <VirtualizedMessageThread
        items={items}
        getItemKey={(item) => item.id}
        renderItem={() => null}
        hasOlder
        onViewportTopChange={onViewportTopChange}
      />
    )
  }

  it("tells a new listener where the view is", async () => {
    // Row 3 (virtua row 4, past the loader row) is at the top.
    testState.scrollOffset = 400
    const listener = vi.fn()
    renderWatched(listener)
    await waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ index: 3, atEnd: false })
    )
  })

  it("reports the row a scroll brings to the top, once per change", async () => {
    const listener = vi.fn()
    renderWatched(listener)
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))

    testState.scrollOffset = 1_000
    testState.onScroll?.(1_000)
    await waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({ index: 9, atEnd: false })
    )
    // A scroll within the same row says nothing new.
    testState.scrollOffset = 1_050
    testState.onScroll?.(1_050)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("says when the view rests at the end", async () => {
    testState.scrollOffset = 4_500
    const listener = vi.fn()
    renderWatched(listener)
    await waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ index: 44, atEnd: true })
    )
  })

  it("measures nothing for no listener", async () => {
    renderWatched()
    testState.onScroll?.(300)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(testState.findItemIndex).not.toHaveBeenCalled()
  })
})

describe("VirtualizedMessageThread focus origin", () => {
  it("marks pointer-origin focus and clears it once focus moves away", () => {
    vi.useFakeTimers()
    try {
      renderThread()
      const viewport = screen.getByTestId("viewport")
      const other = document.createElement("button")
      document.body.appendChild(other)

      pointerDown(screen.getByTestId("content"), 0)

      expect(document.activeElement).toBe(viewport)
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")
      expect(viewport.className).toContain(
        "data-[focus-origin=pointer]:focus-visible:ring-0"
      )

      other.focus()
      vi.runAllTimers()
      expect(viewport).not.toHaveAttribute("data-focus-origin")
      other.remove()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the pointer marker when only the window loses focus", () => {
    vi.useFakeTimers()
    try {
      renderThread()
      const viewport = screen.getByTestId("viewport")

      pointerDown(screen.getByTestId("content"), 0)

      // Switching apps blurs the viewport but leaves it the active element;
      // the browser re-focuses it when the window comes back (e.g. on a
      // resize), and without the marker the ring would show then.
      fireEvent.blur(viewport)
      vi.runAllTimers()
      expect(document.activeElement).toBe(viewport)
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")

      fireEvent.focus(window)
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops the pointer marker when focus moved on while the window was away", () => {
    vi.useFakeTimers()
    const other = document.createElement("button")
    document.body.appendChild(other)
    try {
      renderThread()
      const viewport = screen.getByTestId("viewport")

      pointerDown(screen.getByTestId("content"), 0)
      // The window loses focus: the viewport blurs but stays active.
      fireEvent.blur(viewport)
      vi.runAllTimers()
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")

      // A script focuses another control while the window is in the
      // background: the active element changes, but the viewport sees no
      // second blur (its blur went out with the window's). Only the window
      // coming back can notice.
      const activeElement = vi
        .spyOn(document, "activeElement", "get")
        .mockReturnValue(other)
      try {
        fireEvent.focus(window)
      } finally {
        activeElement.mockRestore()
      }
      expect(viewport).not.toHaveAttribute("data-focus-origin")
    } finally {
      other.remove()
      vi.useRealTimers()
    }
  })

  it.each([
    ["ArrowDown", "ArrowDown", {}],
    ["ArrowUp", "ArrowUp", {}],
    ["PageDown", "PageDown", {}],
    ["PageUp", "PageUp", {}],
    ["Space", " ", {}],
    ["Shift+Space", " ", { shiftKey: true }],
    ["Home", "Home", {}],
    ["Ctrl+End", "End", { ctrlKey: true }],
    ["Cmd+ArrowDown", "ArrowDown", { metaKey: true }],
  ])(
    "clears the pointer marker on %s, a scroll key, so the ring can return",
    (_label, key, modifiers) => {
      renderThread()
      const viewport = screen.getByTestId("viewport")

      pointerDown(screen.getByTestId("content"), 0)
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")

      keyDown(viewport, key, modifiers)
      expect(viewport).not.toHaveAttribute("data-focus-origin")
      expect(document.activeElement).toBe(viewport)
    }
  )

  it.each([
    ["Escape", "Escape", {}],
    ["Ctrl+C", "c", { ctrlKey: true }],
    ["Cmd+C", "c", { metaKey: true }],
    ["Shift", "Shift", { shiftKey: true }],
  ])(
    "keeps the pointer marker through %s, which doesn't scroll",
    (_label, key, modifiers) => {
      renderThread()
      const viewport = screen.getByTestId("viewport")

      pointerDown(screen.getByTestId("content"), 0)

      // In Chromium the click's script focus already matches :focus-visible,
      // so only the marker keeps the whole transcript from being ringed here.
      keyDown(viewport, key, modifiers)
      expect(viewport).toHaveAttribute("data-focus-origin", "pointer")
      expect(document.activeElement).toBe(viewport)
    }
  )

  it("keeps keyboard-origin focus distinguishable", () => {
    renderThread()
    const viewport = screen.getByTestId("viewport")

    viewport.focus()

    expect(document.activeElement).toBe(viewport)
    expect(viewport).not.toHaveAttribute("data-focus-origin")
    expect(viewport.className).toContain("focus-visible:ring-2")
  })

  it("does not mark focus when an interactive control is clicked", () => {
    renderThread(<button data-testid="action">Action</button>)
    const viewport = screen.getByTestId("viewport")

    pointerDown(screen.getByTestId("action"), 0)

    expect(viewport).not.toHaveAttribute("data-focus-origin")
    expect(document.activeElement).not.toBe(viewport)
  })

  it("does not mark focus for a right click", () => {
    renderThread()
    const viewport = screen.getByTestId("viewport")

    pointerDown(screen.getByTestId("content"), 2)

    expect(viewport).not.toHaveAttribute("data-focus-origin")
    expect(document.activeElement).not.toBe(viewport)
  })
})

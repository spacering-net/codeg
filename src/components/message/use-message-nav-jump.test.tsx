import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RefObject } from "react"
import type { MessageNavEntry } from "./conversation-message-nav"
import type { MessageScrollContextValue } from "./message-scroll-context"
import { useMessageNavJump } from "./use-message-nav-jump"

function entry(
  turnId: string,
  at: { threadIndex: number } | { turnIndex: number }
): MessageNavEntry {
  return {
    threadIndex: "threadIndex" in at ? at.threadIndex : null,
    turnIndex: "turnIndex" in at ? at.turnIndex : null,
    turnId,
    ordinal: 1,
    label: turnId,
    additions: 0,
    deletions: 0,
    files: [],
    subAgents: [],
    hasChanges: false,
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface Props {
  conversationId: number
  threadIndexByTurnId: ReadonlyMap<string, number>
  smooth: boolean
}

function setup(
  loadOlderTurnsThrough: (
    conversationId: number,
    throughIndex: number
  ) => Promise<boolean>,
  initial: Partial<Props> = {}
) {
  const scrollToIndex = vi.fn()
  const scrollApiRef = {
    current: { scrollToIndex, revealFromAbove: vi.fn() },
  } as RefObject<MessageScrollContextValue | null>
  const hook = renderHook(
    (props: Props) =>
      useMessageNavJump({ ...props, scrollApiRef, loadOlderTurnsThrough }),
    {
      initialProps: {
        conversationId: 1,
        threadIndexByTurnId: new Map(),
        smooth: true,
        ...initial,
      },
    }
  )
  return { ...hook, scrollToIndex }
}

/** Let the scroll's animation frame run. */
async function nextFrame(): Promise<void> {
  await act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  )
}

afterEach(() => {
  cleanup()
})

describe("useMessageNavJump", () => {
  it("scrolls straight to a loaded message", () => {
    const load = vi.fn()
    const { result, scrollToIndex } = setup(load)
    act(() => result.current.select(entry("turn-9", { threadIndex: 3 })))
    expect(scrollToIndex).toHaveBeenCalledWith(3, {
      align: "start",
      smooth: true,
    })
    expect(load).not.toHaveBeenCalled()
  })

  it("jumps without gliding when chat animations are off", () => {
    const { result, scrollToIndex } = setup(vi.fn(), { smooth: false })
    act(() => result.current.select(entry("turn-9", { threadIndex: 3 })))
    expect(scrollToIndex).toHaveBeenCalledWith(3, {
      align: "start",
      smooth: false,
    })
  })

  it("pages a message above the window in, then scrolls to it", async () => {
    const paging = deferred<boolean>()
    const load = vi.fn(() => paging.promise)
    const { result, rerender, scrollToIndex } = setup(load)

    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    expect(load).toHaveBeenCalledWith(1, 12)
    expect(result.current.revealingTurnId).toBe("turn-12")

    // The page lands: the message renders at thread index 2.
    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-12", 2]]),
      smooth: true,
    })
    await act(async () => paging.resolve(true))
    await nextFrame()
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    // Jumped to, not glided, even with chat animations on: a smooth scroll
    // right after a big prepend gives up before it moves.
    expect(scrollToIndex).toHaveBeenCalledWith(2, {
      align: "start",
      smooth: false,
    })
    expect(result.current.revealingTurnId).toBeNull()
  })

  it("gives up when paging can't reach the message", async () => {
    const { result, rerender, scrollToIndex } = setup(() =>
      Promise.resolve(false)
    )
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    await waitFor(() => expect(result.current.revealingTurnId).toBeNull())
    // A later scroll-up that does load it must not yank the viewport there.
    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-12", 0]]),
      smooth: true,
    })
    await nextFrame()
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it("gives up when the paged-in history doesn't render the message", async () => {
    const { result, scrollToIndex } = setup(() => Promise.resolve(true))
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    await waitFor(() => expect(result.current.revealingTurnId).toBeNull())
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it("drops a pending reveal when a loaded message is picked", async () => {
    const paging = deferred<boolean>()
    const { result, rerender, scrollToIndex } = setup(() => paging.promise)
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    act(() => result.current.select(entry("turn-40", { threadIndex: 5 })))
    expect(scrollToIndex).toHaveBeenCalledWith(5, {
      align: "start",
      smooth: true,
    })
    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-12", 0]]),
      smooth: true,
    })
    await act(async () => paging.resolve(true))
    await nextFrame()
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
  })

  it("follows the latest of two reveals", async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result, rerender, scrollToIndex } = setup(load)
    act(() => result.current.select(entry("turn-30", { turnIndex: 30 })))
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    expect(result.current.revealingTurnId).toBe("turn-12")

    // The first paging reaches its message; the jump is no longer for it.
    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-30", 4]]),
      smooth: true,
    })
    await act(async () => first.resolve(true))
    await nextFrame()
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(result.current.revealingTurnId).toBe("turn-12")

    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([
        ["turn-12", 0],
        ["turn-30", 9],
      ]),
      smooth: true,
    })
    await act(async () => second.resolve(true))
    await nextFrame()
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith(0, {
      align: "start",
      smooth: false,
    })
  })

  it("lets only the latest click on a message settle its reveal", async () => {
    // Click A (its paging stalls), click a loaded message, click A again.
    // The first click's paging then fails: that must not cancel the second
    // click, whose own paging gets there.
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result, rerender, scrollToIndex } = setup(load)
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    act(() => result.current.select(entry("turn-40", { threadIndex: 5 })))
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    scrollToIndex.mockClear()

    await act(async () => first.resolve(false))
    expect(result.current.revealingTurnId).toBe("turn-12")

    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-12", 0]]),
      smooth: true,
    })
    await act(async () => second.resolve(true))
    await nextFrame()
    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith(0, {
      align: "start",
      smooth: false,
    })
    expect(result.current.revealingTurnId).toBeNull()
  })

  it("drops a reveal when the conversation changes, for good", async () => {
    const paging = deferred<boolean>()
    const { result, rerender, scrollToIndex } = setup(() => paging.promise)
    act(() => result.current.select(entry("turn-12", { turnIndex: 12 })))
    rerender({
      conversationId: 2,
      threadIndexByTurnId: new Map(),
      smooth: true,
    })
    expect(result.current.revealingTurnId).toBeNull()
    // Back in the first conversation, with the message loaded after all: the
    // abandoned reveal must not come back and scroll there.
    rerender({
      conversationId: 1,
      threadIndexByTurnId: new Map([["turn-12", 0]]),
      smooth: true,
    })
    await act(async () => paging.resolve(true))
    await nextFrame()
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(result.current.revealingTurnId).toBeNull()
  })
})

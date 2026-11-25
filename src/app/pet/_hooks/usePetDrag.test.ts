import { act, renderHook, waitFor } from "@testing-library/react"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PetState } from "@/lib/pet/animation"
import type { PetDragEndResult, PetDragStartResult } from "@/lib/pet/api"

type DirectionListener = (event: { payload: PetState | null }) => void

const mocks = vi.hoisted(() => ({
  startPetDrag: vi.fn<(sessionId: number) => Promise<PetDragStartResult>>(),
  endPetDrag: vi.fn<(sessionId: number) => Promise<PetDragEndResult>>(),
  startNativePetDrag: vi.fn<(sessionId: number) => Promise<void>>(),
  directionHandler: null as DirectionListener | null,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
}))

vi.mock("@/lib/pet/api", () => ({
  startPetDrag: mocks.startPetDrag,
  endPetDrag: mocks.endPetDrag,
  startNativePetDrag: mocks.startNativePetDrag,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: DirectionListener) => {
    mocks.directionHandler = handler
    return () => {
      mocks.directionHandler = null
    }
  }),
}))

import { usePetDrag } from "./usePetDrag"

function trackedStart(sessionId: number): PetDragStartResult {
  return { mode: "tracked", sessionId }
}

function pressEvent(
  overrides: Partial<{
    button: number
    pointerId: number
    clientX: number
    clientY: number
    screenX: number
    screenY: number
    setPointerCapture: (id: number) => void
  }> = {}
): React.PointerEvent {
  const clientX = overrides.clientX ?? 40
  const clientY = overrides.clientY ?? 50
  return {
    button: overrides.button ?? 0,
    pointerId: overrides.pointerId ?? 1,
    clientX,
    clientY,
    screenX: overrides.screenX ?? clientX,
    screenY: overrides.screenY ?? clientY,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: overrides.setPointerCapture ?? vi.fn(),
    },
  } as unknown as React.PointerEvent
}

describe("usePetDrag", () => {
  beforeEach(() => {
    mocks.directionHandler = null
    mocks.startPetDrag.mockResolvedValue(trackedStart(1))
    mocks.endPetDrag.mockResolvedValue({ clicked: false })
    mocks.startNativePetDrag.mockResolvedValue(undefined)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("delegates drag tracking to Rust and settles on release", async () => {
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const setPointerCapture = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await waitFor(() => expect(mocks.directionHandler).not.toBeNull())

    await act(async () => {
      result.current.onPointerDown(
        pressEvent({ pointerId: 7, setPointerCapture })
      )
      await Promise.resolve()
    })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(mocks.startPetDrag).toHaveBeenCalledTimes(1)

    act(() => {
      mocks.directionHandler?.({ payload: "running_left" })
    })
    expect(onDragDirection).toHaveBeenCalledWith("running_left")

    await act(async () => {
      window.dispatchEvent(new Event("pointerup"))
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenCalledWith(1)
    expect(onClick).not.toHaveBeenCalled()
    expect(onDragDirection).toHaveBeenLastCalledWith(null)
  })

  it("uses the same session's click result when native polling ends first", async () => {
    mocks.startPetDrag.mockResolvedValueOnce(trackedStart(42))
    mocks.endPetDrag.mockResolvedValueOnce({ clicked: true })
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await act(async () => {
      result.current.onPointerDown(pressEvent())
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(new Event("pointerup"))
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenCalledWith(42)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("handles a fast tap before startPetDrag settles", async () => {
    let resolveStart: (res: PetDragStartResult) => void = () => {}
    mocks.startPetDrag.mockReturnValueOnce(
      new Promise<PetDragStartResult>((r) => {
        resolveStart = r
      })
    )
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    act(() => {
      result.current.onPointerDown(pressEvent({ clientX: 10, clientY: 10 }))
      window.dispatchEvent(new Event("pointerup"))
    })

    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveStart(trackedStart(7))
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenCalledWith(7)
  })

  it("does not let a stale start response end the next drag", async () => {
    let resolveFirstStart: (res: PetDragStartResult) => void = () => {}
    mocks.startPetDrag
      .mockReturnValueOnce(
        new Promise<PetDragStartResult>((resolve) => {
          resolveFirstStart = resolve
        })
      )
      .mockResolvedValueOnce(trackedStart(102))
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    act(() => {
      result.current.onPointerDown(pressEvent({ pointerId: 1 }))
      window.dispatchEvent(new Event("pointerup"))
    })

    await act(async () => {
      result.current.onPointerDown(pressEvent({ pointerId: 2 }))
      await Promise.resolve()
    })

    await act(async () => {
      resolveFirstStart(trackedStart(101))
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenCalledTimes(1)
    expect(mocks.endPetDrag).toHaveBeenNthCalledWith(1, 101)
    const [firstSeq, secondSeq] = mocks.startPetDrag.mock.calls.map(
      ([seq]) => seq
    )
    expect(firstSeq).toBeTypeOf("number")
    expect(secondSeq).toBeGreaterThan(firstSeq)

    await act(async () => {
      window.dispatchEvent(new Event("pointerup"))
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenNthCalledWith(2, 102)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("waits for movement past the click threshold before calling startNativePetDrag() on Wayland", async () => {
    mocks.startPetDrag.mockResolvedValueOnce({
      mode: "native_os",
      sessionId: null,
    })
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await act(async () => {
      result.current.onPointerDown(pressEvent({ screenX: 40, screenY: 50 }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          screenX: 45,
          screenY: 50,
          buttons: 1,
        })
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          screenX: 46,
          screenY: 50,
          buttons: 1,
        })
      )
    })

    expect(mocks.startNativePetDrag).toHaveBeenCalledExactlyOnceWith(
      mocks.startPetDrag.mock.calls[0][0]
    )

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          screenX: 70,
          screenY: 50,
          buttons: 1,
        })
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).toHaveBeenCalledExactlyOnceWith(
      mocks.startPetDrag.mock.calls[0][0]
    )
    expect(mocks.endPetDrag).not.toHaveBeenCalled()
  })

  it("triggers onClick without calling startNativePetDrag() on a zero-displacement Wayland tap", async () => {
    mocks.startPetDrag.mockResolvedValueOnce({
      mode: "native_os",
      sessionId: null,
    })
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await act(async () => {
      result.current.onPointerDown(pressEvent({ screenX: 40, screenY: 50 }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointerup", {
          screenX: 40,
          screenY: 50,
        })
      )
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(mocks.endPetDrag).not.toHaveBeenCalled()
  })

  it("does not call startNativePetDrag() if the primary button is no longer held", async () => {
    mocks.startPetDrag.mockResolvedValueOnce({
      mode: "native_os",
      sessionId: null,
    })
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await act(async () => {
      result.current.onPointerDown(pressEvent({ screenX: 40, screenY: 50 }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          screenX: 80,
          screenY: 50,
          buttons: 0,
        })
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).not.toHaveBeenCalled()
  })

  it("requests native dragging on the threshold-crossing move while start is pending", async () => {
    let resolveStart: (res: PetDragStartResult) => void = () => {}
    mocks.startPetDrag.mockReturnValueOnce(
      new Promise<PetDragStartResult>((resolve) => {
        resolveStart = resolve
      })
    )
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    act(() => {
      result.current.onPointerDown(pressEvent({ screenX: 40, screenY: 50 }))
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          screenX: 60,
          screenY: 50,
          buttons: 1,
        })
      )
    })

    expect(mocks.startNativePetDrag).toHaveBeenCalledExactlyOnceWith(
      mocks.startPetDrag.mock.calls[0][0]
    )

    await act(async () => {
      resolveStart({ mode: "native_os", sessionId: null })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.startNativePetDrag).toHaveBeenCalledExactlyOnceWith(
      mocks.startPetDrag.mock.calls[0][0]
    )
  })

  it("uses desktop travel rather than the moving viewport for native drags", async () => {
    mocks.startPetDrag.mockResolvedValueOnce({
      mode: "native_os",
      sessionId: null,
    })
    const onDragDirection = vi.fn()
    const onClick = vi.fn()
    const { result } = renderHook(() =>
      usePetDrag({ onDragDirection, onClick })
    )

    await act(async () => {
      result.current.onPointerDown(pressEvent())
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointerup", {
          clientX: 40,
          clientY: 50,
          screenX: 80,
          screenY: 50,
        })
      )
      await Promise.resolve()
    })

    expect(onClick).not.toHaveBeenCalled()
    expect(onDragDirection).toHaveBeenLastCalledWith(null)
  })
})

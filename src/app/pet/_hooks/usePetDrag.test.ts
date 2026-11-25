import { act, renderHook, waitFor } from "@testing-library/react"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PetState } from "@/lib/pet/animation"
import type { PetDragEndResult, PetDragStartResult } from "@/lib/pet/api"

type DirectionListener = (event: { payload: PetState | null }) => void

const mocks = vi.hoisted(() => ({
  startPetDrag: vi.fn<() => Promise<PetDragStartResult>>(),
  endPetDrag: vi.fn<() => Promise<PetDragEndResult>>(),
  startDragging: vi.fn(() => Promise.resolve()),
  directionHandler: null as DirectionListener | null,
}))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
}))

vi.mock("@/lib/pet/api", () => ({
  startPetDrag: mocks.startPetDrag,
  endPetDrag: mocks.endPetDrag,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: DirectionListener) => {
    mocks.directionHandler = handler
    return () => {
      mocks.directionHandler = null
    }
  }),
}))

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: mocks.startDragging,
  }),
}))

import { usePetDrag } from "./usePetDrag"

function pressEvent(
  overrides: Partial<{
    button: number
    pointerId: number
    clientX: number
    clientY: number
    setPointerCapture: (id: number) => void
  }> = {}
): React.PointerEvent {
  return {
    button: overrides.button ?? 0,
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX ?? 40,
    clientY: overrides.clientY ?? 50,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: overrides.setPointerCapture ?? vi.fn(),
    },
  } as unknown as React.PointerEvent
}

describe("usePetDrag", () => {
  beforeEach(() => {
    mocks.directionHandler = null
    mocks.startPetDrag.mockResolvedValue({ mode: "tracked" })
    mocks.endPetDrag.mockResolvedValue({ clicked: false })
    mocks.startDragging.mockResolvedValue(undefined)
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

    expect(mocks.endPetDrag).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    expect(onDragDirection).toHaveBeenLastCalledWith(null)
  })

  it("fires onClick when backend reports a tap", async () => {
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

    expect(mocks.endPetDrag).toHaveBeenCalledTimes(1)
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
      resolveStart({ mode: "tracked" })
      await Promise.resolve()
    })

    expect(mocks.endPetDrag).toHaveBeenCalledTimes(1)
  })

  it("falls back to window.startDragging() on Wayland", async () => {
    mocks.startPetDrag.mockResolvedValueOnce({ mode: "native_os" })
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

    expect(mocks.startDragging).toHaveBeenCalledTimes(1)
    expect(mocks.endPetDrag).not.toHaveBeenCalled()
  })
})

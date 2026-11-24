import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useLatestCall } from "./use-latest-call"

describe("useLatestCall", () => {
  it("keeps only the call begun last current", () => {
    const { result } = renderHook(() => useLatestCall())
    const first = result.current()
    expect(first()).toBe(true)

    const second = result.current()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  it("hands out the same begin function across renders", () => {
    const { result, rerender } = renderHook(() => useLatestCall())
    const begin = result.current
    const first = begin()
    rerender()
    expect(result.current).toBe(begin)
    expect(first()).toBe(true)
  })
})

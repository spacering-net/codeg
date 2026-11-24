import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  resetShowHiddenAssistantsForTest,
  useShowHiddenAssistants,
} from "./roster-filter"

afterEach(() => {
  localStorage.clear()
  resetShowHiddenAssistantsForTest()
})

describe("showing the hidden assistants (D6)", () => {
  it("is off by default, kept on this device, and shared by every reader", () => {
    const a = renderHook(() => useShowHiddenAssistants())
    const b = renderHook(() => useShowHiddenAssistants())
    expect(a.result.current[0]).toBe(false)
    act(() => a.result.current[1](true))
    // The other reader (the title's popover beside the sidebar) follows.
    expect(b.result.current[0]).toBe(true)
    expect(localStorage.getItem("pa:roster:show-hidden:v1")).toBe("1")
    // Read again later (a new window): as it was left.
    resetShowHiddenAssistantsForTest()
    const c = renderHook(() => useShowHiddenAssistants())
    expect(c.result.current[0]).toBe(true)
    act(() => c.result.current[1](false))
    expect(localStorage.getItem("pa:roster:show-hidden:v1")).toBeNull()
  })
})

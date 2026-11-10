import { act, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))

import { ComputerMarker } from "./computer-marker"

beforeEach(() => {
  handlers.clear()
})

describe("ComputerMarker", () => {
  /** Nothing is drawn until a mark comes; each mark is drawn afresh, even a
   * second one of the same kind. */
  it("plays each mark it is told of", async () => {
    const { container } = render(<ComputerMarker />)
    expect(container.querySelector("[data-action]")).toBeNull()
    await waitFor(() => expect(handlers.get("computer://marker")).toBeDefined())
    const mark = handlers.get("computer://marker")!
    act(() => mark({ id: 1, action: "click" }))
    const first = container.querySelector("[data-action]")
    expect(first).toHaveAttribute("data-action", "click")
    act(() => mark({ id: 2, action: "click" }))
    const second = container.querySelector("[data-action]")
    expect(second).not.toBe(first)
    act(() => mark({ id: 3, action: "type" }))
    expect(container.querySelector("[data-action]")).toHaveAttribute(
      "data-action",
      "type"
    )
  })
})

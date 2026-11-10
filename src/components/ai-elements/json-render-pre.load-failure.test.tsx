import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))
// The card's chunk cannot be fetched (offline web client, a deploy that
// replaced the build underneath an open tab).
vi.mock("@/components/message/json-render-block", () => {
  throw new Error("Loading chunk failed")
})

import { JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

const SPEC = [
  "Here it is:",
  "",
  "```spec",
  JSON.stringify({ op: "add", path: "/root", value: "main" }),
  "```",
].join("\n")

describe("a spec fence whose card cannot load", () => {
  it("stays code, and the reply around it stays up", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const { container } = render(
      <JsonRenderScope>
        <MessageResponse>{SPEC}</MessageResponse>
      </JsonRenderScope>
    )
    // React reports which boundary caught the failed import: by then what is
    // on screen is that boundary's fallback, not the one shown while loading.
    const caughtByCard = () =>
      errors.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === "string" && arg.includes("CardBoundary")
        )
      )
    await waitFor(() => expect(caughtByCard()).toBe(true))
    expect(container.textContent).toContain("Here it is:")
    expect(container.textContent).toContain('"op"')
    errors.mockRestore()
  })
})

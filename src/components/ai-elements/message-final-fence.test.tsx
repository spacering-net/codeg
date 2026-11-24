import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse } from "./message"

// The #555 shape: a reply that mentions `_meta`-style tokens earlier and ends
// exactly at a closing fence. Under mode="streaming", remend appends a `_`
// closer after the final ``` and the fence stops closing, so the block renders
// "```_" as content. The static default must keep the block intact.
//
// This file deliberately drives the REAL Streamdown — `message.test.tsx` mocks
// it away, so only an end-to-end render can catch a fence that stopped closing.
const REPLY =
  "Files: `_meta` and `R27QD_REPORT.md` done.\n\nSHA-256:\n\n```text\nabc123\n```"

describe("MessageResponse finished reply ending at a code fence", () => {
  it("keeps the final fence closed", async () => {
    const { container } = render(<MessageResponse>{REPLY}</MessageResponse>)

    // The code block is React.lazy + Suspense, so wait for its body to arrive
    // rather than sleeping on a wall clock. Anchoring on the block's CONTENT is
    // what makes the negative assertion below meaningful: the stray "```_" is
    // part of that same content, so if the fence had reopened it would already
    // be on screen by the time "abc123" is.
    await waitFor(() => expect(container.textContent ?? "").toContain("abc123"))

    expect(container.textContent ?? "").not.toContain("```")
  })
})

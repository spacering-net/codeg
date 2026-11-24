import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DotStrip } from "./dot-strip"

afterEach(() => cleanup())

describe("DotStrip", () => {
  it("marks a day red where something failed, even with nothing handed out that day", () => {
    const { container } = render(
      <DotStrip
        label="Daily dispatches"
        days={[
          { key: "a", count: 0, failed: false, title: "a" },
          { key: "b", count: 2, failed: false, title: "b" },
          // Work from the day before failing on a day with none of its own.
          { key: "c", count: 0, failed: true, title: "c" },
        ]}
      />
    )
    const dots = [...container.querySelectorAll("[data-pa-dot]")]
    expect(dots.map((d) => d.getAttribute("data-pa-dot"))).toEqual([
      "none",
      "some",
      "failed",
    ])
    expect(dots[2].className).toContain("bg-red-500")
    expect(dots[2].className).not.toContain("bg-muted")
    expect(dots[0].className).toContain("bg-muted")
    expect(
      container.querySelector("[role='img']")?.getAttribute("aria-label")
    ).toBe("Daily dispatches")
  })
})

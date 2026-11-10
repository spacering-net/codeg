import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

function renderTabs(orientation?: "horizontal" | "vertical") {
  return render(
    <Tabs defaultValue="one" orientation={orientation}>
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First</TabsContent>
      <TabsContent value="two">Second</TabsContent>
    </Tabs>
  )
}

describe("Tabs", () => {
  // The wrapper used to keep `orientation` for its own data attribute and never
  // hand it to Radix, so a vertical tab list announced itself as horizontal and
  // only answered ←/→.
  it("hands a vertical orientation to Radix", async () => {
    renderTabs("vertical")
    expect(screen.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "vertical"
    )

    const one = screen.getByRole("tab", { name: "One" })
    act(() => one.focus())
    // Radix moves roving focus on a timer.
    fireEvent.keyDown(one, { key: "ArrowDown" })
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus()
    )
  })

  it("stays horizontal by default", async () => {
    renderTabs()
    expect(screen.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "horizontal"
    )

    const one = screen.getByRole("tab", { name: "One" })
    act(() => one.focus())
    fireEvent.keyDown(one, { key: "ArrowRight" })
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus()
    )
  })
})

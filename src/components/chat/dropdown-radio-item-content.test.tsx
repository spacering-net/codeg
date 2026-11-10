import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DropdownRadioItemContent } from "./dropdown-radio-item-content"

describe("DropdownRadioItemContent", () => {
  it("shows a command's argument hint in the label's line", () => {
    const { container } = render(
      <DropdownRadioItemContent
        label="/mcp"
        hint="[reconnect]"
        description="Show MCP server status."
      />
    )
    expect(screen.getByText("[reconnect]").parentElement).toBe(
      screen.getByText("/mcp").parentElement
    )
    expect((container.firstChild as HTMLElement).title).toBe("/mcp [reconnect]")
  })

  it("renders the label alone when the hint is blank", () => {
    const { container } = render(
      <DropdownRadioItemContent label="/compact" hint="  " />
    )
    expect(container.textContent).toBe("/compact")
    expect(container.querySelector("span")).toBeNull()
    expect((container.firstChild as HTMLElement).title).toBe("/compact")
  })
})

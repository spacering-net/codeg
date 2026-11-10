import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AssistantAvatar } from "./assistant-avatar"

const disc = (container: HTMLElement) =>
  container.querySelector('[data-slot="assistant-avatar"]')!

describe("AssistantAvatar", () => {
  it("draws the first character of the name for a monogram", () => {
    const { container } = render(
      <AssistantAvatar
        avatar={{ kind: "monogram", color: "teal" }}
        name="reviewer"
        size={32}
      />
    )
    expect(disc(container).textContent).toBe("R")
  })

  it("draws the generic figure on the chosen colour while there is no name", () => {
    const { container } = render(
      <AssistantAvatar
        avatar={{ kind: "monogram", color: "teal" }}
        name="  "
        size={32}
      />
    )
    expect(disc(container).textContent).toBe("")
    expect(
      disc(container).querySelector("svg.lucide-user-round")
    ).not.toBeNull()
    expect(disc(container).className).toContain("bg-teal-500/15")
  })
})

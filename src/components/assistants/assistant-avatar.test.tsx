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

  it("sizes in rem, so it follows the app zoom", () => {
    const { container } = render(
      <AssistantAvatar
        avatar={{ kind: "emoji", emoji: "🧭", color: "violet" }}
        name="x"
        size={40}
      />
    )
    const style = (disc(container) as HTMLElement).style
    expect(style.width).toBe("2.5rem")
    expect(style.height).toBe("2.5rem")
  })

  it("keeps a picture at its size in a narrower box (no base max-width)", () => {
    const { container } = render(
      <AssistantAvatar
        avatar={{ kind: "image", data_url: "data:image/png;base64,AA==" }}
        name="x"
        size={20}
      />
    )
    const img = disc(container) as HTMLImageElement
    expect(img.tagName).toBe("IMG")
    expect(img.style.width).toBe("1.25rem")
    expect(img.className).toContain("max-w-none")
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

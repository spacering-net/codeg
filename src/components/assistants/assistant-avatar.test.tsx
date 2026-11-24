import { readFileSync } from "node:fs"
import { join } from "node:path"

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

  it("names the emoji fonts for an emoji, and only for one", () => {
    const draw = (avatar: Parameters<typeof AssistantAvatar>[0]["avatar"]) =>
      disc(
        render(<AssistantAvatar avatar={avatar} name="Reviewer" size={30} />)
          .container
      ).className
    for (const emoji of ["🤖", "🧑‍💻", "🕵️", "🇯🇵", "1️⃣"]) {
      expect(draw({ kind: "emoji", emoji, color: "teal" })).toContain(
        "font-emoji"
      )
    }
    // A letter or a character typed as one keeps the interface's fonts.
    for (const emoji of ["A", "比", "1"]) {
      expect(draw({ kind: "emoji", emoji, color: "teal" })).not.toContain(
        "font-emoji"
      )
    }
    expect(draw({ kind: "monogram", color: "teal" })).not.toContain(
      "font-emoji"
    )
  })

  it("keeps a generic family out of the emoji fonts: WebKit is slow on one", () => {
    // Six seconds to first draw the face editor's two dozen emoji in the
    // desktop's webview with `sans-serif` in the stack, even after the
    // emoji fonts; milliseconds without.
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8")
    const stack = /--font-emoji:([^;]+);/.exec(css)?.[1] ?? ""
    expect(stack).toMatch(/^\s*"Apple Color Emoji"/)
    expect(stack).not.toMatch(/\b(sans-serif|serif|var\(--font-sans\))/)
  })
})

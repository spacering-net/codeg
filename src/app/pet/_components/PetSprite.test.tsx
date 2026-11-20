import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockUseImageNaturalSize = vi.fn()

vi.mock("@/lib/pet/use-image-natural-size", () => ({
  useImageNaturalSize: (url: string | null | undefined) =>
    mockUseImageNaturalSize(url),
}))

vi.mock("../_hooks/usePetAnimator", () => ({
  usePetAnimator: () => ({ row: 5, col: 0 }),
}))

import { PetSprite } from "./PetSprite"

describe("PetSprite", () => {
  beforeEach(() => {
    mockUseImageNaturalSize.mockReset()
  })

  it("locks the 192:208 cell aspect ratio and prevents flex compression", () => {
    mockUseImageNaturalSize.mockReturnValue({ width: 1536, height: 1872 })

    render(
      <PetSprite
        spritesheetUrl="blob:v1-pet"
        state="failed"
        scale={0.75}
        label="RX-93"
      />
    )

    const sprite = screen.getByRole("img", { name: "RX-93" })
    expect(sprite.style.width).toBe(
      "min(144px, 100vw, calc(100vh * 192 / 208))"
    )
    expect(sprite.style.height).toBe("")
    expect(sprite.style.aspectRatio).toBe("192 / 208")
    expect(sprite.style.flexShrink).toBe("0")
    expect(sprite.style.backgroundSize).toBe("800% 900%")
    expect(sprite.style.backgroundPosition).toBe("0% 62.5%")
  })

  it("adapts background grid height and position for v2 11-row sheets", () => {
    mockUseImageNaturalSize.mockReturnValue({ width: 1536, height: 2288 })

    render(
      <PetSprite
        spritesheetUrl="blob:v2-pet"
        state="failed"
        scale={1}
        label="Ferris"
      />
    )

    const sprite = screen.getByRole("img", { name: "Ferris" })
    expect(sprite.style.width).toBe(
      "min(192px, 100vw, calc(100vh * 192 / 208))"
    )
    expect(sprite.style.backgroundSize).toBe("800% 1100%")
    expect(sprite.style.backgroundPosition).toBe("0% 50%")
  })
})

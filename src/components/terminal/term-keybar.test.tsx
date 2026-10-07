import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TermKeybar } from "./term-keybar"

// next-intl is mocked at module level via vitest config; provide the minimum
// shape used by `useTranslations` so `t("...")` returns the key path.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const NO_MODS = { ctrl: false, alt: false }

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("<TermKeybar />", () => {
  it("renders all 12 keys + 2 modifier buttons", () => {
    render(
      <TermKeybar mods={NO_MODS} onToggleMod={() => {}} onPressKey={() => {}} />
    )
    // Two-row layout, 7 + 7 buttons.
    const all = screen.getAllByRole("button")
    expect(all).toHaveLength(14)
  })

  it("fires onPressKey with the right key on pointerdown, and skips click", () => {
    const onPressKey = vi.fn()
    render(
      <TermKeybar
        mods={NO_MODS}
        onToggleMod={() => {}}
        onPressKey={onPressKey}
      />
    )

    // Find the "up" key by its localized label (we mocked useTranslations to
    // return the key path, so labels are "up", "down", etc.).
    const upBtn = screen.getByRole("button", { name: "up" })
    fireEvent.pointerDown(upBtn)

    expect(onPressKey).toHaveBeenCalledTimes(1)
    expect(onPressKey).toHaveBeenCalledWith("up")

    // Click after pointerdown would double-fire without the swallowClick.
    fireEvent.click(upBtn)
    expect(onPressKey).toHaveBeenCalledTimes(1)
  })

  it("fires onToggleMod('ctrl' | 'alt') on the modifier buttons", () => {
    const onToggleMod = vi.fn()
    render(
      <TermKeybar
        mods={NO_MODS}
        onToggleMod={onToggleMod}
        onPressKey={() => {}}
      />
    )

    fireEvent.pointerDown(screen.getByRole("button", { name: "ctrl" }))
    expect(onToggleMod).toHaveBeenCalledWith("ctrl")

    fireEvent.pointerDown(screen.getByRole("button", { name: "alt" }))
    expect(onToggleMod).toHaveBeenCalledWith("alt")
  })

  it("marks CTRL/ALT active when mods prop is true", () => {
    render(
      <TermKeybar
        mods={{ ctrl: true, alt: false }}
        onToggleMod={() => {}}
        onPressKey={() => {}}
      />
    )
    // active class includes `bg-primary text-primary-foreground border-primary`
    const ctrl = screen.getByRole("button", { name: "ctrl" })
    expect(ctrl.className).toContain("bg-primary")

    // ALT not armed — no accent.
    const alt = screen.getByRole("button", { name: "alt" })
    expect(alt.className).not.toContain("bg-primary")
  })

  it("disables every button when disabled=true", () => {
    render(
      <TermKeybar
        mods={NO_MODS}
        onToggleMod={() => {}}
        onPressKey={() => {}}
        disabled
      />
    )
    const all = screen.getAllByRole("button")
    for (const btn of all) {
      expect(btn).toBeDisabled()
    }
  })
})

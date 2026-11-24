import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { ImageDiffView } from "./image-diff-view"
import type { ImageDiffSide } from "@/lib/image-diff"
import enMessages from "@/i18n/messages/en.json"

const messages = enMessages.Folder.diffPreview

const before: ImageDiffSide = {
  kind: "image",
  src: "data:image/png;base64,QUJD",
  byteSize: 2048,
}
const after: ImageDiffSide = {
  kind: "image",
  src: "data:image/png;base64,REVG",
  byteSize: 4096,
}

function renderView(
  props: Partial<React.ComponentProps<typeof ImageDiffView>>
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ImageDiffView
        original={before}
        modified={after}
        originalLabel="HEAD"
        modifiedLabel="Working Tree"
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("ImageDiffView", () => {
  it("shows both sides with their sizes", () => {
    renderView({})

    const images = screen.getAllByRole("img")
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      before.src,
      after.src,
    ])
    expect(screen.getByText("2.0 KB")).toBeInTheDocument()
    expect(screen.getByText("4.0 KB")).toBeInTheDocument()
    expect(screen.getByText(messages.mode.modified)).toBeInTheDocument()
  })

  it("reads a missing original as an addition", () => {
    renderView({ original: { kind: "absent" } })

    expect(screen.getByText(messages.mode.added)).toBeInTheDocument()
    expect(screen.getByText(messages.image.noImage)).toBeInTheDocument()
    expect(screen.getAllByRole("img")).toHaveLength(1)
  })

  it("reads a missing modification as a deletion", () => {
    renderView({ modified: { kind: "absent" } })

    expect(screen.getByText(messages.mode.deleted)).toBeInTheDocument()
    expect(screen.getAllByRole("img")).toHaveLength(1)
  })

  it("says how big a side it refused to load is", () => {
    renderView({ modified: { kind: "tooLarge", byteSize: 42 * 1024 * 1024 } })

    expect(
      screen.getByText("Image too large to preview (42.0 MB)")
    ).toBeInTheDocument()
  })

  it("does not call a failed read an addition", () => {
    renderView({
      original: { kind: "unavailable", reason: "not a git repository" },
    })

    // "Added" would be a claim about the change we have no evidence for.
    expect(screen.getByText(messages.mode.modified)).toBeInTheDocument()
    expect(screen.getByText(messages.image.unavailable)).toBeInTheDocument()
    expect(screen.getByText("not a git repository")).toBeInTheDocument()
  })

  it("will not call it an addition when the other side failed to load", () => {
    // A commit that vanished mid-session: nothing before it resolves either,
    // so "Added" would be a conclusion drawn from two unknowns.
    renderView({
      original: { kind: "absent" },
      modified: { kind: "unavailable", reason: "abc123: no such revision" },
    })

    expect(screen.getByText(messages.mode.modified)).toBeInTheDocument()
    expect(screen.getByText("abc123: no such revision")).toBeInTheDocument()
  })

  it("offers the swipe comparison only when both sides have pixels", () => {
    const { rerender } = renderView({})
    expect(
      screen.getByRole("button", { name: messages.image.swipe })
    ).toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ImageDiffView
          original={{ kind: "absent" }}
          modified={after}
          originalLabel="HEAD"
          modifiedLabel="Working Tree"
        />
      </NextIntlClientProvider>
    )
    expect(
      screen.queryByRole("button", { name: messages.image.swipe })
    ).not.toBeInTheDocument()
  })

  it("overlays the two images behind a keyboard-movable divider", () => {
    renderView({})

    fireEvent.click(screen.getByRole("button", { name: messages.image.swipe }))

    const slider = screen.getByRole("slider", {
      name: messages.image.swipeHandle,
    })
    expect(slider).toHaveAttribute("aria-valuenow", "50")

    fireEvent.keyDown(slider, { key: "ArrowLeft" })
    expect(slider).toHaveAttribute("aria-valuenow", "48")

    fireEvent.keyDown(slider, { key: "End" })
    expect(slider).toHaveAttribute("aria-valuenow", "100")

    // Both images stay mounted — the divider clips one over the other.
    expect(screen.getAllByRole("img")).toHaveLength(2)
  })

  it("falls back to a plain message when neither side has an image", () => {
    renderView({ original: { kind: "absent" }, modified: { kind: "absent" } })

    expect(screen.getByText(messages.noDiffData)).toBeInTheDocument()
    expect(screen.queryAllByRole("img")).toHaveLength(0)
  })
})

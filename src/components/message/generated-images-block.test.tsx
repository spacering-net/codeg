import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { GeneratedImagesBlock } from "./generated-images-block"
import enMessages from "@/i18n/messages/en.json"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"

const image: UserImageDisplay = {
  name: "page-capture.png",
  data: "QUJD",
  mime_type: "image/png",
  uri: null,
}

function renderCard(props: Partial<{ label: string | null }> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GeneratedImagesBlock revisedPrompt={null} image={image} {...props} />
    </NextIntlClientProvider>
  )
}

describe("GeneratedImagesBlock heading", () => {
  it("keeps the translated generation copy when no label is passed", () => {
    // codex image generation is the one caller that leaves `label` unset.
    renderCard()
    expect(screen.getByText("Image generation")).toBeInTheDocument()
  })

  it("falls back to the generation copy for a blank label", () => {
    renderCard({ label: "   " })
    expect(screen.getByText("Image generation")).toBeInTheDocument()
  })

  it("shows the tool/page name when one is passed", () => {
    renderCard({ label: "Page Capture" })
    expect(screen.getByText("Page Capture")).toBeInTheDocument()
    expect(screen.queryByText("Image generation")).not.toBeInTheDocument()
  })

  it("bounds a long heading to one line and keeps the full text reachable", () => {
    // The heading is agent-authored now, so it can be arbitrarily long.
    const long = "Read file '/Users/x/very/long/path/to/a-page-capture.png'"
    renderCard({ label: long })
    const heading = screen.getByText(long)
    expect(heading.className).toContain("truncate")
    expect(heading).toHaveAttribute("title", long)
  })
})

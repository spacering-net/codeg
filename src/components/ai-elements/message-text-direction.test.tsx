import { render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The real Streamdown pipeline; only the link-safety hook is stubbed (no
// bearing on direction).
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import enMessages from "@/i18n/messages/en.json"
import { MessageResponse } from "./message"

const MARKDOWN = [
  "مرحبا بكم في المشروع.",
  "",
  "Hello there.",
  "",
  "- عنصر أول",
  "- عنصر ثان",
  "",
  "Then:",
  "",
  "- first item",
  "- second item",
].join("\n")

describe("MessageResponse text direction", () => {
  it("reads each paragraph and list in the direction of its own text", async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageResponse>{MARKDOWN}</MessageResponse>
      </NextIntlClientProvider>
    )
    await waitFor(() => {
      expect(container.querySelectorAll("ul")).toHaveLength(2)
    })
    const paragraphs = Array.from(container.querySelectorAll("p"))
    const dirOf = (start: string) =>
      paragraphs
        .find((p) => p.textContent?.startsWith(start))
        ?.getAttribute("dir")
    expect(dirOf("مرحبا")).toBe("rtl")
    expect(dirOf("Hello")).toBe("ltr")

    const [arabicList, englishList] = Array.from(
      container.querySelectorAll("ul")
    )
    expect(arabicList).toHaveAttribute("dir", "rtl")
    expect(arabicList.querySelector("li")).toHaveAttribute("dir", "rtl")
    expect(englishList).toHaveAttribute("dir", "ltr")
    expect(englishList.querySelector("li")).toHaveAttribute("dir", "ltr")
  })
})

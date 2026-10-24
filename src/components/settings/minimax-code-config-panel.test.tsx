import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import messages from "@/i18n/messages/en.json"
import { MiniMaxCodeConfigPanel } from "./minimax-code-config-panel"

it("explains native sign-in without collecting or saving credentials", () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MiniMaxCodeConfigPanel />
    </NextIntlClientProvider>
  )
  expect(screen.getByText("mcode login")).toBeInTheDocument()
  expect(screen.getByText("mcode login --region global")).toBeInTheDocument()
  expect(screen.getByText(/existing BYOK configuration/)).toBeInTheDocument()
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

describe("MiniMax Code translations", () => {
  const locales = import.meta.glob<{ default: typeof messages }>(
    "../../i18n/messages/*.json",
    { eager: true }
  )

  it("provides setup instructions in every supported locale", () => {
    expect(Object.keys(locales)).toHaveLength(10)
    for (const locale of Object.values(locales)) {
      expect(Object.keys(locale.default.AcpAgentSettings.minimaxCode)).toEqual(
        Object.keys(messages.AcpAgentSettings.minimaxCode)
      )
    }
  })
})

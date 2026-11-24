import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import { RequiredOptionRow, type OptionRow } from "./agent-options-editor"

afterEach(() => cleanup())

const ROW = {
  kind: "select",
  id: "effort",
  option: {
    id: "effort",
    name: "Effort",
    description: "How hard it thinks before it answers",
    kind: { type: "select", options: [] },
  },
  groups: [],
  empty: false,
} as unknown as OptionRow

const draw = (hideHint?: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RequiredOptionRow
        row={ROW}
        value={null}
        onChange={() => {}}
        hideHint={hideHint}
      />
    </NextIntlClientProvider>
  )

describe("an option row", () => {
  it("says what the option is under its name", () => {
    draw()
    expect(screen.getByText("Effort")).toBeInTheDocument()
    expect(
      screen.getByText("How hard it thinks before it answers")
    ).toBeInTheDocument()
  })

  it("shows its name alone where it is to be picked at a glance", () => {
    draw(true)
    expect(screen.getByText("Effort")).toBeInTheDocument()
    expect(
      screen.queryByText("How hard it thinks before it answers")
    ).toBeNull()
  })
})

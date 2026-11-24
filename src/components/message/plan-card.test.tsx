import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { PlanEntriesList } from "./plan-card"
import enMessages from "@/i18n/messages/en.json"
import type { PlanEntryInfo } from "@/lib/types"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const sampleEntries: PlanEntryInfo[] = [
  { content: "First step", priority: "high", status: "completed" },
  { content: "Second step", priority: "medium", status: "in_progress" },
  { content: "Third step", priority: "low", status: "pending" },
]

describe("PlanEntriesList", () => {
  it("renders nothing when there are no entries", () => {
    const { container } = renderWithIntl(<PlanEntriesList entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("greys out finished steps and sets the current one in ink", () => {
    renderWithIntl(<PlanEntriesList entries={sampleEntries} />)
    expect(screen.getByText("First step").className).toContain(
      "text-muted-foreground"
    )
    expect(screen.getByText("Second step").className).toContain(
      "font-medium text-foreground"
    )
    expect(screen.getByText("Third step").className).not.toContain(
      "text-muted-foreground"
    )
  })

  it("says each step's status to assistive tech", () => {
    renderWithIntl(<PlanEntriesList entries={sampleEntries} />)
    const items = screen.getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "CompletedFirst stepHigh",
      "In ProgressSecond stepMedium",
      "PendingThird stepLow",
    ])
  })

  it("renders each entry's content and priority label", () => {
    renderWithIntl(<PlanEntriesList entries={sampleEntries} />)
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("High")).toBeInTheDocument()
    expect(screen.getByText("Medium")).toBeInTheDocument()
    expect(screen.getByText("Low")).toBeInTheDocument()
  })

  it("leaves the priority out when every step shares it", () => {
    // Agents that rank nothing get "medium" on every step.
    renderWithIntl(
      <PlanEntriesList
        entries={sampleEntries.map((entry) => ({
          ...entry,
          priority: "medium",
        }))}
      />
    )
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.queryByText("Medium")).toBeNull()
  })
})

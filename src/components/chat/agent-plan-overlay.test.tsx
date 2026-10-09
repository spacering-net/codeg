import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import { AgentPlanOverlay } from "./agent-plan-overlay"
import enMessages from "@/i18n/messages/en.json"
import type { PlanEntryInfo } from "@/lib/types"
import type { LiveMessage } from "@/contexts/acp-connections-context"

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

describe("AgentPlanOverlay", () => {
  afterEach(() => {
    window.localStorage.removeItem("codeg-plan-overlay-auto-expand")
  })

  it("renders nothing when entries are empty", () => {
    const { container } = renderWithIntl(
      <AgentPlanOverlay entries={[]} planKey="p-empty" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when visible=false even with entries", () => {
    const { container } = renderWithIntl(
      <AgentPlanOverlay entries={sampleEntries} planKey="p-1" visible={false} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders title and completed/total badge when expanded", () => {
    renderWithIntl(
      <AgentPlanOverlay
        entries={sampleEntries}
        planKey="p-1"
        defaultExpanded={true}
      />
    )
    expect(screen.getByText("Agent Plan")).toBeInTheDocument()
    expect(screen.getByText("1/3")).toBeInTheDocument()
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("Second step")).toBeInTheDocument()
    expect(screen.getByText("Third step")).toBeInTheDocument()
  })

  it("reads entries from the latest plan block in a LiveMessage", () => {
    // getLatestPlanEntries walks the content array in reverse — the LAST
    // plan block wins so updates supersede earlier ones.
    const message = {
      id: "msg-1",
      content: [
        {
          type: "plan",
          entries: [
            { content: "stale-1", priority: "low", status: "completed" },
          ],
        },
        { type: "text", text: "narration" },
        {
          type: "plan",
          entries: [
            { content: "fresh-1", priority: "high", status: "in_progress" },
            { content: "fresh-2", priority: "medium", status: "pending" },
          ],
        },
      ],
    } as unknown as LiveMessage
    renderWithIntl(
      <AgentPlanOverlay message={message} planKey="p-msg" defaultExpanded />
    )
    expect(screen.getByText("fresh-1")).toBeInTheDocument()
    expect(screen.getByText("fresh-2")).toBeInTheDocument()
    expect(screen.queryByText("stale-1")).not.toBeInTheDocument()
    expect(screen.getByText("0/2")).toBeInTheDocument()
  })

  it("when all entries are completed, defaults to the collapsed summary", () => {
    // defaultExpanded && hasIncompleteEntries → resolvedDefaultExpanded.
    // With every status=completed, the overlay starts collapsed even when
    // defaultExpanded=true so the user isn't pestered after the agent is done.
    const allDone: PlanEntryInfo[] = [
      { content: "Done A", priority: "high", status: "completed" },
      { content: "Done B", priority: "low", status: "completed" },
    ]
    renderWithIntl(
      <AgentPlanOverlay
        entries={allDone}
        planKey="p-done"
        defaultExpanded={true}
      />
    )
    // Collapsed pill renders "Plan 2/2", not the full task list.
    expect(screen.getByText("Plan 2/2")).toBeInTheDocument()
    expect(screen.queryByText("Done A")).not.toBeInTheDocument()
  })

  it("clicking the collapsed pill expands the overlay", () => {
    const allDone: PlanEntryInfo[] = [
      { content: "Done A", priority: "high", status: "completed" },
    ]
    renderWithIntl(
      <AgentPlanOverlay
        entries={allDone}
        planKey="p-toggle"
        defaultExpanded={true}
      />
    )
    fireEvent.click(screen.getByText("Plan 1/1").closest("button")!)
    expect(screen.getByText("Done A")).toBeInTheDocument()
  })

  it("stays collapsed when auto-expand is turned off", () => {
    window.localStorage.setItem("codeg-plan-overlay-auto-expand", "0")
    const noPlan = {
      id: "live-off",
      content: [{ type: "text", text: "working" }],
    } as unknown as LiveMessage
    const withPlan = {
      id: "live-off",
      content: [
        { type: "text", text: "working" },
        {
          type: "plan",
          entries: [
            { content: "Build step", priority: "high", status: "in_progress" },
          ],
        },
      ],
    } as unknown as LiveMessage

    const { rerender } = renderWithIntl(
      <AgentPlanOverlay message={noPlan} isStreaming />
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentPlanOverlay message={withPlan} isStreaming />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Plan 0/1")).toBeInTheDocument()
    expect(screen.queryByText("Build step")).not.toBeInTheDocument()
  })

  it("auto-expands once when a plan is created live while streaming", () => {
    // Streaming starts with no plan, then a plan_update lands. The overlay
    // should pop open by itself the first time the plan appears.
    const noPlan = {
      id: "live-1",
      content: [{ type: "text", text: "working" }],
    } as unknown as LiveMessage
    const withPlan = {
      id: "live-1",
      content: [
        { type: "text", text: "working" },
        {
          type: "plan",
          entries: [
            { content: "Build step", priority: "high", status: "in_progress" },
          ],
        },
      ],
    } as unknown as LiveMessage

    const { rerender } = renderWithIntl(
      <AgentPlanOverlay message={noPlan} isStreaming />
    )
    expect(screen.queryByText("Build step")).not.toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentPlanOverlay message={withPlan} isStreaming />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Build step")).toBeInTheDocument()
  })

  it("stays collapsed when a streaming session is opened with a plan already present", () => {
    // Plan exists on the very first render (opening a mid-stream session), so
    // it must not auto-expand — only show the collapsed summary pill.
    const withPlan = {
      id: "live-2",
      content: [
        {
          type: "plan",
          entries: [
            { content: "Build step", priority: "high", status: "in_progress" },
          ],
        },
      ],
    } as unknown as LiveMessage

    renderWithIntl(<AgentPlanOverlay message={withPlan} isStreaming />)
    expect(screen.getByText("Plan 0/1")).toBeInTheDocument()
    expect(screen.queryByText("Build step")).not.toBeInTheDocument()
  })

  it("does not auto-expand a non-streaming plan (e.g. opening a session)", () => {
    renderWithIntl(
      <AgentPlanOverlay entries={sampleEntries} planKey="p-open" />
    )
    expect(screen.getByText("Plan 1/3")).toBeInTheDocument()
    expect(screen.queryByText("First step")).not.toBeInTheDocument()
  })
})

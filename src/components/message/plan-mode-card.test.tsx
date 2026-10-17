import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// Exercise the real Streamdown pipeline for the plan-markdown branch; only the
// link-safety hook is stubbed (no bearing on plan rendering), mirroring
// message-softbreaks.test.tsx.
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { PlanModeCard } from "./plan-mode-card"
import enMessages from "@/i18n/messages/en.json"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

function renderCard(props: {
  toolName: string
  input: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PlanModeCard
        toolName={props.toolName}
        input={props.input}
        output={props.output ?? null}
        errorText={props.errorText ?? null}
        state={props.state ?? "output-available"}
      />
    </NextIntlClientProvider>
  )
}

// jsdom does no layout, so scrollHeight/clientHeight both read 0 — already
// "not overflowing" for the default case. Patch both onto Element.prototype
// *before* rendering so the clamp's synchronous mount-time measurement (it
// never waits on the inert ResizeObserver stub in test-setup.ts) sees them.
function mockScrollMetrics(scrollHeight: number, clientHeight: number) {
  const descriptors = (["scrollHeight", "clientHeight"] as const).map(
    (prop) =>
      [prop, Object.getOwnPropertyDescriptor(Element.prototype, prop)] as const
  )
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  })
  return () => {
    for (const [prop, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Element.prototype, prop, descriptor)
    }
  }
}

describe("PlanModeCard", () => {
  let restoreMetrics: (() => void) | null = null

  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("renders a compact marker for EnterPlanMode (no plan body)", () => {
    const { container } = renderCard({ toolName: "enterplanmode", input: "{}" })
    expect(screen.getByText("Entered plan mode")).toBeInTheDocument()
    // No collapsible Tool shell, no plan card header.
    expect(screen.queryByText("Proposed plan")).toBeNull()
    expect(container.querySelector("pre")).toBeNull()
  })

  it("renders ExitPlanMode's plan markdown directly under the plan label", async () => {
    const { container } = renderCard({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading\n- item one" }),
    })
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("Heading")
      expect(container.textContent).toContain("item one")
    })
  })

  it("renders a neutral marker (with target mode) for a non-plan switch_mode", () => {
    renderCard({
      toolName: "switch_mode",
      input: JSON.stringify({ mode: "act" }),
    })
    // Content-driven: no plan markdown → mode marker, NOT a plan card.
    expect(screen.getByText("Switched mode · act")).toBeInTheDocument()
    expect(screen.queryByText("Proposed plan")).toBeNull()
  })

  it("renders the plan when switch_mode carries plan markdown (content-driven)", async () => {
    const { container } = renderCard({
      toolName: "switch_mode",
      input: JSON.stringify({ mode: "plan", plan: "## Steps\n- do x" }),
    })
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("Steps")
      expect(container.textContent).toContain("do x")
    })
    expect(screen.queryByText("Switched mode · plan")).toBeNull()
  })

  it("surfaces the error text on a failed plan-mode call", () => {
    renderCard({
      toolName: "exitplanmode",
      input: "{}",
      errorText: "boom",
      state: "output-error",
    })
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // card shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    renderCard({
      toolName: "exitplanmode",
      input: "{}",
      errorText: "```\nThe user rejected the plan.\n```",
      state: "output-error",
    })
    expect(screen.getByText("The user rejected the plan.").textContent).toBe(
      "The user rejected the plan."
    )
  })

  it("reports an approved codex plan review from its rawOutput", () => {
    // codex-acp ≥1.1.8: codeg seeds the call from the permission request (no
    // input), and codex's follow-up update supplies the decision text.
    renderCard({
      toolName: "plan_review",
      input: null,
      output: "User approved the plan.",
    })
    expect(screen.getByText("Plan approved — implementing")).toBeInTheDocument()
    expect(screen.queryByText("Proposed plan")).toBeNull()
  })

  it("shows the plan AND the decision when a plan review carries both", async () => {
    // Live shape once codex's follow-up `tool_call_update` supplies
    // `rawInput.plan`: the card is the plan, the marker is what the user did
    // about it. The old either/or rendering dropped the decision entirely as
    // soon as a plan was present, so an approved plan looked undecided.
    const { container } = renderCard({
      toolName: "plan_review",
      input: JSON.stringify({ plan: "# Heading\n- item one" }),
      output: "User approved the plan.",
    })

    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    expect(screen.getByText("Plan approved — implementing")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("Heading")
    })
  })

  it("says the decision is pending under a plan that is still awaiting review", () => {
    renderCard({
      toolName: "plan_review",
      input: JSON.stringify({ plan: "# Heading" }),
      output: null,
      state: "input-available",
    })
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    expect(screen.getByText("Awaiting plan decision")).toBeInTheDocument()
  })

  it("keeps the either/or shape for non-review plan-mode tools", () => {
    // ExitPlanMode's marker would only restate the card above it.
    renderCard({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading" }),
    })
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    expect(screen.queryByText("Plan submitted")).toBeNull()
  })

  it("reports a declined codex plan review, and defaults to it when the output is unknown", () => {
    const kept = renderCard({
      toolName: "plan_review",
      input: null,
      output: "User kept the session in plan mode.",
    })
    expect(screen.getByText("Kept in plan mode")).toBeInTheDocument()
    kept.unmount()

    // A settled call with unrecognised / missing output must never read as an
    // approval.
    renderCard({ toolName: "plan_review", input: null, output: null })
    expect(screen.getByText("Kept in plan mode")).toBeInTheDocument()
  })

  it("leaves a short plan unclamped, with no toggle", () => {
    renderCard({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading" }),
    })

    expect(
      screen.queryByTestId("plan-mode-card-toggle")
    ).not.toBeInTheDocument()
    const content = screen.getByTestId("plan-mode-card-content")
    expect(content).not.toHaveClass("collapsed-content-fade")
  })

  it("clamps a long plan and toggles it open and closed", () => {
    restoreMetrics = mockScrollMetrics(900, 288)

    renderCard({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading\n- a\n- b\n- c" }),
    })

    const content = screen.getByTestId("plan-mode-card-content")
    const toggle = screen.getByTestId("plan-mode-card-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
    expect(toggle).toHaveAttribute("aria-controls", content.id)
    expect(content).toHaveClass("max-h-72", "collapsed-content-fade")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Show less")
    expect(screen.getByTestId("plan-mode-card-content")).not.toHaveClass(
      "max-h-72",
      "collapsed-content-fade"
    )

    // Clicking again re-collapses.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByTestId("plan-mode-card-content")).toHaveClass("max-h-72")
  })

  it("says the decision is pending while the plan-review call is unsettled", () => {
    // The seeded call is `input-available` for as long as the permission card
    // is open. Claiming either outcome there would state a decision the user
    // has not made yet.
    renderCard({
      toolName: "plan_review",
      input: null,
      output: null,
      state: "input-available",
    })
    expect(screen.getByText("Awaiting plan decision")).toBeInTheDocument()
    expect(screen.queryByText("Kept in plan mode")).toBeNull()
    expect(screen.queryByText("Plan approved — implementing")).toBeNull()
  })
})

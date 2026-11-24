import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import postcss from "postcss"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// Exercise the real Streamdown pipeline for the plan document; only the
// link-safety hook is stubbed (no bearing on plan rendering).
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import enMessages from "@/i18n/messages/en.json"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { ContentPartsRenderer } from "../../content-parts-renderer"
import { mockClampLayout } from "@/test-layout"

/**
 * A plan-mode transition on the timeline — entering plan mode, submitting a
 * plan, codex's plan review and its decision — and the plan document it opens
 * to.
 */

function renderRow(props: {
  toolName: string
  input: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer
        parts={[
          {
            type: "tool-call",
            toolCallId: "call-plan",
            toolName: props.toolName,
            input: props.input,
            output: props.output ?? null,
            errorText: props.errorText ?? undefined,
            state: props.state ?? "output-available",
          },
        ]}
        role="assistant"
      />
    </NextIntlClientProvider>
  )
}

function header(): HTMLElement {
  const el = document.querySelector("li > button, li > div")
  if (!el) throw new Error("no row")
  return el as HTMLElement
}

describe("plan-mode row", () => {
  let restoreMetrics: (() => void) | null = null

  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("marks entering plan mode, with nothing to open", () => {
    renderRow({ toolName: "enterplanmode", input: "{}" })
    expect(header().textContent).toContain("Entered plan mode")
    expect(header().tagName).toBe("DIV")
    expect(screen.queryByText("Proposed plan")).toBeNull()
  })

  it("opens a submitted plan to the plan itself", async () => {
    const { container } = renderRow({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading\n- item one" }),
    })
    expect(header()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("item one")
    })
  })

  it("steps the plan's headings down inside its card", async () => {
    renderRow({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Keep CSV export working\n\n1. Map it" }),
    })
    const heading = await screen.findByRole("heading", {
      name: "Keep CSV export working",
    })
    // globals.css sizes a heading under `.plan-markdown` below a reply's.
    expect(heading.closest(".plan-markdown")).not.toBeNull()
    const css = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const sizes = new Map<string, string>()
    css.walkRules((rule) => {
      if (!rule.selector.startsWith(".plan-markdown")) return
      rule.walkDecls("font-size", (decl) => {
        sizes.set(rule.selector.replace(/\s+/g, " "), decl.value)
      })
    })
    expect(sizes.get('.plan-markdown [data-streamdown="heading-1"]')).toBe(
      "1.125rem"
    )
    expect(sizes.get('.plan-markdown [data-streamdown="heading-2"]')).toBe(
      "1rem"
    )
  })

  it("marks a mode switch that carries no plan, with the mode it went to", () => {
    renderRow({
      toolName: "switch_mode",
      input: JSON.stringify({ mode: "act" }),
    })
    expect(header().textContent).toContain("Switched mode · act")
    expect(screen.queryByText("Proposed plan")).toBeNull()
  })

  it("opens a mode switch that carries a plan to the plan", async () => {
    const { container } = renderRow({
      toolName: "switch_mode",
      input: JSON.stringify({ mode: "plan", plan: "## Steps\n- do x" }),
    })
    // The row says where it switched to; the plan is what it opens to.
    expect(header().textContent).toContain("Switched mode · plan")
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("do x")
    })
  })

  it("shows why a plan-mode call failed", () => {
    renderRow({
      toolName: "exitplanmode",
      input: "{}",
      errorText: "boom",
      state: "output-error",
    })
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // row shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    renderRow({
      toolName: "exitplanmode",
      input: "{}",
      errorText: "```\nThe user rejected the plan.\n```",
      state: "output-error",
    })
    expect(screen.getByText("The user rejected the plan.").textContent).toBe(
      "The user rejected the plan."
    )
  })

  it("reports an approved codex plan review from its output", () => {
    // codex-acp ≥1.1.8: codeg seeds the call from the permission request (no
    // input), and codex's follow-up update supplies the decision text.
    renderRow({
      toolName: "plan_review",
      input: null,
      output: "User approved the plan.",
    })
    expect(header().textContent).toContain("Plan approved — implementing")
    expect(screen.queryByText("Proposed plan")).toBeNull()
  })

  it("shows the plan and the decision when a review carries both", async () => {
    // The decision is what the user did about the plan; a plan without it
    // would read as undecided.
    const { container } = renderRow({
      toolName: "plan_review",
      input: JSON.stringify({ plan: "# Heading\n- item one" }),
      output: "User approved the plan.",
    })
    expect(header().textContent).toContain("Plan approved — implementing")
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
    await waitFor(() => {
      expect(container.textContent).toContain("item one")
    })
  })

  it("says the decision is pending under a plan still awaiting review", () => {
    renderRow({
      toolName: "plan_review",
      input: JSON.stringify({ plan: "# Heading" }),
      output: null,
      state: "input-available",
    })
    expect(header().textContent).toContain("Awaiting plan decision")
    expect(screen.getByText("Proposed plan")).toBeInTheDocument()
  })

  it("says the decision is pending while the review call is unsettled", () => {
    // The seeded call stays in flight for as long as the permission card is
    // open; claiming either outcome there states a decision not yet made.
    renderRow({
      toolName: "plan_review",
      input: null,
      output: null,
      state: "input-available",
    })
    expect(header().textContent).toContain("Awaiting plan decision")
    expect(screen.queryByText("Kept in plan mode")).toBeNull()
    expect(screen.queryByText("Plan approved — implementing")).toBeNull()
  })

  it("reports a declined review, and reads an unknown outcome as declined", () => {
    const kept = renderRow({
      toolName: "plan_review",
      input: null,
      output: "User kept the session in plan mode.",
    })
    expect(header().textContent).toContain("Kept in plan mode")
    kept.unmount()

    // A settled call with unrecognised or missing output never reads as an
    // approval.
    renderRow({ toolName: "plan_review", input: null, output: null })
    expect(header().textContent).toContain("Kept in plan mode")
  })

  it("leaves a short plan unclamped, with no toggle", () => {
    renderRow({
      toolName: "exitplanmode",
      input: JSON.stringify({ plan: "# Heading" }),
    })
    expect(
      screen.queryByTestId("plan-mode-card-toggle")
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-mode-card-content")).not.toHaveClass(
      "collapsed-content-fade"
    )
  })

  it("clamps a long plan and toggles it open and closed", () => {
    restoreMetrics = mockClampLayout(900, 288)
    renderRow({
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

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByTestId("plan-mode-card-content")).toHaveClass("max-h-72")
  })
})

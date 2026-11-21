import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }))
vi.mock("@/components/layout/status-bar-stats", () => ({
  StatusBarStats: () => <span data-testid="stats" />,
}))
vi.mock("@/components/layout/status-bar-tasks", () => ({
  StatusBarTasks: () => null,
}))
vi.mock("@/components/layout/status-bar-alerts", () => ({
  StatusBarAlerts: () => null,
}))
vi.mock("@/components/layout/status-bar-mcp", () => ({
  StatusBarMcp: () => <span data-testid="mcp-service" />,
}))
vi.mock("@/components/layout/status-bar-computer", () => ({
  StatusBarComputer: () => null,
}))
vi.mock("@/components/layout/status-bar-update", () => ({
  StatusBarUpdate: () => null,
}))
vi.mock("@/components/layout/command-dropdown", () => ({
  CommandDropdown: () => null,
}))
vi.mock("@/components/layout/status-bar-srn", () => ({
  StatusBarSrn: ({ compact }: { compact?: boolean }) => (
    <span data-testid="srn" data-compact={compact ? "true" : "false"} />
  ),
}))
vi.mock("@/components/layout/status-bar-web-service", () => ({
  StatusBarWebService: () => <span data-testid="web-service" />,
}))

import { StatusBar } from "./status-bar"

beforeEach(() => {
  viewport.mobile = false
})

describe("StatusBar", () => {
  /** "Narrow" is a viewport width, and a desktop window can be shrunk below
   *  it: the web-service signal must not vanish with it. (The item itself
   *  renders nothing outside the local desktop.) */
  it.each([
    ["wide", false],
    ["narrow", true],
  ])("orders service items in the %s layout", (_label, mobile) => {
    viewport.mobile = mobile
    render(<StatusBar />)
    expect(screen.getByTestId("web-service")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-service")).toBeInTheDocument()
    expect(
      screen
        .getAllByTestId(/^(mcp|web)-service$/)
        .map((element) => element.dataset.testid)
    ).toEqual(["mcp-service", "web-service"])
  })

  /** The SRN entry holds the bar's leading corner — the sidebar's icon rail —
   *  alone: its menu carries the quick actions, which no longer have a
   *  launcher of their own. The workspace stats follow it. On phones it is
   *  the ring or avatar alone. */
  it.each([
    ["wide", false],
    ["narrow", true],
  ])("leads with the SRN entry in the %s layout", (_label, mobile) => {
    viewport.mobile = mobile
    const { container } = render(<StatusBar />)
    const srn = screen.getByTestId("srn")
    const leading = container.firstElementChild?.firstElementChild
    expect(leading?.firstElementChild).toBe(srn)
    expect(srn.nextElementSibling).toBe(screen.getByTestId("stats"))
    expect(srn).toHaveAttribute("data-compact", mobile ? "true" : "false")
  })
})

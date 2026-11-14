import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }))
vi.mock("@/components/layout/status-bar-stats", () => ({
  StatusBarStats: () => null,
}))
vi.mock("@/components/layout/status-bar-tasks", () => ({
  StatusBarTasks: () => null,
}))
vi.mock("@/components/layout/status-bar-alerts", () => ({
  StatusBarAlerts: () => null,
}))
vi.mock("@/components/layout/status-bar-mcp", () => ({
  StatusBarMcp: () => null,
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
vi.mock("@/components/layout/quick-actions-dropdown", () => ({
  QuickActionsDropdown: () => null,
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
  ])("carries the web-service item in the %s layout", (_label, mobile) => {
    viewport.mobile = mobile
    render(<StatusBar />)
    expect(screen.getByTestId("web-service")).toBeInTheDocument()
  })
})

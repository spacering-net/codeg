import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The registry is what is under test, not the pages it points at — each is
// replaced by a marker, which also keeps their data layers out of the test.
vi.mock("@/components/automations/automations-page", () => ({
  AutomationsPage: () => <div>PAGE automations</div>,
  AutomationsPageTitle: () => <div>TITLE automations</div>,
}))
vi.mock("@/components/tasks/tasks-page", () => ({
  TasksPage: () => <div>PAGE tasks</div>,
  TasksPageTitle: () => <div>TITLE tasks</div>,
}))
vi.mock("@/components/tasks/tasks-chrome-actions", () => ({
  TasksChromeActions: () => <div>ACTIONS tasks</div>,
}))
vi.mock("@/components/forge/forge-page", () => ({
  ForgePage: () => <div>PAGE forge</div>,
  ForgePageTitle: () => <div>TITLE forge</div>,
}))
vi.mock("@/components/forge/forge-chrome-actions", () => ({
  ForgeChromeActions: () => <div>ACTIONS forge</div>,
}))
vi.mock("@/components/token-usage/token-usage-page", () => ({
  TokenUsagePage: () => <div>PAGE tokenUsage</div>,
  TokenUsagePageTitle: () => <div>TITLE tokenUsage</div>,
}))
vi.mock("@/components/canvas/canvas-page", () => ({
  CanvasPage: () => <div>PAGE canvas</div>,
  CanvasPageTitle: () => <div>TITLE canvas</div>,
}))
vi.mock("@/components/personal-agent/personal-agent-page", () => ({
  PersonalAgentPage: () => <div>PAGE personalAgent</div>,
  PersonalAgentPageTitle: () => <div>TITLE personalAgent</div>,
  PersonalAgentChromeActions: () => <div>ACTIONS personalAgent</div>,
}))
vi.mock("@/components/harness/harness-chrome-actions", () => ({
  HarnessChromeActions: () => <div>ACTIONS harness</div>,
}))
vi.mock("@/components/harness/harness-page", () => ({
  HarnessPage: () => <div>PAGE harness</div>,
  HarnessPageTitle: () => <div>TITLE harness</div>,
}))

import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
  type WorkbenchRouteId,
} from "@/contexts/workbench-route-context"
import { SIDEBAR_NAV_ITEM_IDS } from "@/lib/sidebar-view-mode-storage"
import {
  WorkbenchRouteChromeActions,
  WorkbenchRoutePage,
  WorkbenchRouteStrip,
  useHasWorkbenchRouteStrip,
} from "./workbench-content"

const FULL_PAGE_ROUTES: WorkbenchRouteId[] = [
  "personalAgent",
  "automations",
  "tasks",
  "forge",
  "tokenUsage",
  "canvas",
  "harness",
]

function Go({ to }: { to: WorkbenchRouteId }) {
  const { setRoute } = useWorkbenchRoute()
  return (
    <button type="button" onClick={() => setRoute(to)}>
      go {to}
    </button>
  )
}

function HasStrip() {
  return (
    <span data-testid="has-strip">{String(useHasWorkbenchRouteStrip())}</span>
  )
}

function renderWorkbench(routes: WorkbenchRouteId[]) {
  return render(
    <WorkbenchRouteProvider>
      {routes.map((route) => (
        <Go key={route} to={route} />
      ))}
      <HasStrip />
      <div data-testid="strip">
        <WorkbenchRouteStrip />
      </div>
      <div data-testid="actions">
        <WorkbenchRouteChromeActions buttonClassName="" iconClassName="" />
      </div>
      <div data-testid="page">
        <WorkbenchRoutePage />
      </div>
    </WorkbenchRouteProvider>
  )
}

describe("workbench route registry", () => {
  it("renders nothing over the conversation workspace", () => {
    renderWorkbench([])

    expect(screen.getByTestId("page").textContent).toBe("")
    expect(screen.getByTestId("strip").textContent).toBe("")
    expect(screen.getByTestId("has-strip").textContent).toBe("false")
  })

  it.each(FULL_PAGE_ROUTES)(
    "gives the %s route its page and its title strip",
    (route) => {
      renderWorkbench([route])
      fireEvent.click(screen.getByText(`go ${route}`))

      expect(screen.getByTestId("page").textContent).toBe(`PAGE ${route}`)
      expect(screen.getByTestId("strip").textContent).toBe(`TITLE ${route}`)
      // The layout draws the strip's bottom border from this answer.
      expect(screen.getByTestId("has-strip").textContent).toBe("true")
    }
  )

  it("swaps the page when the route changes, and clears it on the way back", () => {
    renderWorkbench(["harness", "tasks", "conversations"])

    fireEvent.click(screen.getByText("go harness"))
    expect(screen.getByTestId("page").textContent).toBe("PAGE harness")

    fireEvent.click(screen.getByText("go tasks"))
    expect(screen.getByTestId("page").textContent).toBe("PAGE tasks")

    fireEvent.click(screen.getByText("go conversations"))
    expect(screen.getByTestId("page").textContent).toBe("")
  })

  it("puts Harness's refresh in the window chrome, as Tasks puts its own", () => {
    renderWorkbench(["harness", "tasks", "canvas"])

    fireEvent.click(screen.getByText("go harness"))
    expect(screen.getByTestId("actions").textContent).toBe("ACTIONS harness")

    fireEvent.click(screen.getByText("go tasks"))
    expect(screen.getByTestId("actions").textContent).toBe("ACTIONS tasks")

    // Control: a route with nothing of its own leaves the slot empty.
    fireEvent.click(screen.getByText("go canvas"))
    expect(screen.getByTestId("actions").textContent).toBe("")
  })

  it("has a page behind every row the sidebar can show", () => {
    // The sidebar builds its rows from this list and calls `setRoute(id)` for
    // each: an id with no page would be a row that opens a blank screen.
    renderWorkbench([...SIDEBAR_NAV_ITEM_IDS])

    for (const id of SIDEBAR_NAV_ITEM_IDS) {
      fireEvent.click(screen.getByText(`go ${id}`))
      expect(screen.getByTestId("page").textContent).toBe(`PAGE ${id}`)
      expect(screen.getByTestId("strip").textContent).toBe(`TITLE ${id}`)
    }
  })
})

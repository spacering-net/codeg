/**
 * The way into the Harness page from anywhere.
 *
 * Two things are pinned down here. Inside the workspace, one call has to do
 * both halves — put the page on the right section with its target parked, and
 * switch the workbench route to it. Outside the workspace (the Settings
 * window, the pet panel, the standalone commit / merge windows) there is no
 * workbench at all, and the same call has to answer with a result rather than
 * throw: the components that offer this entry render there too.
 */
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import { useOpenHarness, type OpenHarnessResult } from "./use-open-harness"

function workbench(discoverEnabled?: boolean) {
  return function Workbench({ children }: { children: ReactNode }) {
    // The order the workspace layout mounts them in: the Harness view outside
    // the route.
    return (
      <HarnessViewProvider discoverEnabled={discoverEnabled}>
        <WorkbenchRouteProvider>{children}</WorkbenchRouteProvider>
      </HarnessViewProvider>
    )
  }
}

/** The hook, next to what it is supposed to move. */
function useProbe() {
  return {
    ...useOpenHarness(),
    route: useWorkbenchRoute(),
    harness: useHarnessView(),
  }
}

beforeEach(() => localStorage.clear())

describe("useOpenHarness — inside the workspace", () => {
  it("opens the page where it last was when asked for nothing more", () => {
    const { result } = renderHook(useProbe, { wrapper: workbench() })
    expect(result.current.available).toBe(true)
    expect(result.current.route.routeId).toBe("conversations")

    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness()
    })

    expect(outcome).toEqual({ ok: true, section: "discover", targeted: false })
    expect(result.current.route.routeId).toBe("harness")
    expect(result.current.harness.section).toBe("discover")
  })

  it("opens a section", () => {
    const { result } = renderHook(useProbe, { wrapper: workbench() })
    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness({ section: "skills" })
    })

    expect(outcome).toEqual({ ok: true, section: "skills", targeted: false })
    expect(result.current.route.routeId).toBe("harness")
    expect(result.current.harness.section).toBe("skills")
    expect(result.current.harness.pendingTarget).toBeNull()
  })

  it.each([
    [
      "a Harness item",
      { section: "discover", itemRef: "acme/pdf-tools" },
      { section: "discover", itemRef: "acme/pdf-tools" },
    ],
    [
      "an MCP server",
      { section: "mcp", serverKey: "github" },
      { section: "mcp", serverKey: "github" },
    ],
    [
      "a skill",
      { section: "skills", skillId: "pdf" },
      { section: "skills", skillId: "pdf" },
    ],
    [
      "a skill-pack tab",
      { section: "packs", tab: "office" },
      { section: "packs", tab: "office" },
    ],
  ] as const)("opens the page on %s", (_label, request, target) => {
    const { result } = renderHook(useProbe, { wrapper: workbench() })
    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness(request)
    })

    expect(outcome).toEqual({
      ok: true,
      section: request.section,
      targeted: true,
    })
    expect(result.current.route.routeId).toBe("harness")
    expect(result.current.harness.section).toBe(request.section)
    expect(result.current.harness.pendingTarget).toEqual(target)
  })

  it("re-targets a page that is already open", () => {
    const { result } = renderHook(useProbe, { wrapper: workbench() })
    act(() => {
      result.current.openHarness({ section: "packs", tab: "experts" })
    })
    act(() => {
      result.current.openHarness({ section: "packs", tab: "ui" })
    })

    expect(result.current.route.routeId).toBe("harness")
    expect(result.current.harness.pendingTarget).toEqual({
      section: "packs",
      tab: "ui",
    })
  })

  it("still opens the page when Discover is switched off, and says where", () => {
    const { result } = renderHook(useProbe, { wrapper: workbench(false) })
    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness({
        section: "discover",
        itemRef: "acme/pdf-tools",
      })
    })

    // The page has three sections that work; what it cannot do is show the
    // item. The caller sees both facts.
    expect(outcome).toEqual({ ok: true, section: "mcp", targeted: false })
    expect(result.current.route.routeId).toBe("harness")
    expect(result.current.harness.pendingTarget).toBeNull()
  })

  it("keeps one `openHarness` across section and route switches", () => {
    const { result } = renderHook(useProbe, { wrapper: workbench() })
    const { openHarness } = result.current
    act(() => {
      result.current.openHarness({ section: "mcp" })
    })
    act(() => result.current.route.openConversations())

    expect(result.current.openHarness).toBe(openHarness)
  })
})

describe("useOpenHarness — where there is no workbench", () => {
  it("answers instead of throwing", () => {
    // No provider at all: the Settings window.
    const { result } = renderHook(() => useOpenHarness())
    expect(result.current.available).toBe(false)

    let outcome: OpenHarnessResult | undefined
    expect(() => {
      act(() => {
        outcome = result.current.openHarness({
          section: "packs",
          tab: "office",
        })
      })
    }).not.toThrow()
    expect(outcome).toEqual({ ok: false, reason: "no-workbench" })
  })

  it("does not half-open: a route with no Harness view parks nothing", () => {
    // Either half missing is "no workbench" — switching the route to a page
    // that has no state to render from would be worse than doing nothing.
    const { result } = renderHook(
      () => ({ ...useOpenHarness(), route: useWorkbenchRoute() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <WorkbenchRouteProvider>{children}</WorkbenchRouteProvider>
        ),
      }
    )
    expect(result.current.available).toBe(false)

    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness({ section: "mcp" })
    })

    expect(outcome).toEqual({ ok: false, reason: "no-workbench" })
    expect(result.current.route.routeId).toBe("conversations")
  })

  it("does not move a section it cannot show", () => {
    // The other half missing: a Harness view with no route to put it on.
    const { result } = renderHook(
      () => ({ ...useOpenHarness(), harness: useHarnessView() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <HarnessViewProvider>{children}</HarnessViewProvider>
        ),
      }
    )
    let outcome: OpenHarnessResult | undefined
    act(() => {
      outcome = result.current.openHarness({ section: "packs", tab: "ui" })
    })

    expect(outcome).toEqual({ ok: false, reason: "no-workbench" })
    expect(result.current.harness.section).toBe("discover")
    expect(result.current.harness.pendingTarget).toBeNull()
  })
})

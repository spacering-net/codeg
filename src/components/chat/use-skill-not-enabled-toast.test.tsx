/**
 * The warning for a bundled skill the agent cannot use yet, shared by the
 * welcome page's quick actions and the composer's "+" menu.
 *
 * Its button used to open the Settings window on the pack's page; those pages
 * are sections of the workspace's Harness page now. Pinned down here: inside
 * the workspace the button opens Harness on Skill packs, on the pack the skill
 * comes from; where there is no workbench the warning comes without a button.
 */
import { useEffect, type ReactNode } from "react"
import { act, render, renderHook, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import type { HarnessPackTab } from "@/lib/harness-sections"

const sonner = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock("sonner", () => ({ toast: { warning: sonner.warning } }))
vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, string>) =>
      values
        ? `${namespace}.${key} ${JSON.stringify(values)}`
        : `${namespace}.${key}`,
}))
vi.mock("@/lib/custom-agents", () => ({
  getAgentLabel: (agent: string) => `label:${agent}`,
}))

import { useSkillNotEnabledToast } from "./use-skill-not-enabled-toast"

const NS = "Folder.chat.welcomePanel.quickActions.notEnabled"

interface ToastOptions {
  description: string
  action?: { label: string; onClick: () => void }
}

function lastToast(): { title: string; options: ToastOptions } {
  const calls = sonner.warning.mock.calls
  const call = calls[calls.length - 1]
  if (!call) throw new Error("no toast was shown")
  return { title: call[0] as string, options: call[1] as ToastOptions }
}

function Workspace({ children }: { children: ReactNode }) {
  // The order the workspace layout mounts them in.
  return (
    <HarnessViewProvider>
      <WorkbenchRouteProvider>{children}</WorkbenchRouteProvider>
    </HarnessViewProvider>
  )
}

function useProbe() {
  return {
    notify: useSkillNotEnabledToast("codex"),
    route: useWorkbenchRoute(),
    harness: useHarnessView(),
  }
}

beforeEach(() => {
  localStorage.clear()
  sonner.warning.mockReset()
})

describe("useSkillNotEnabledToast — inside the workspace", () => {
  it("names the skill and the agent, and says where it is switched on", () => {
    const { result } = renderHook(useProbe, { wrapper: Workspace })
    act(() => result.current.notify("Code review", "experts"))

    expect(sonner.warning).toHaveBeenCalledTimes(1)
    const { title, options } = lastToast()
    expect(title).toBe(
      `${NS}.title ${JSON.stringify({ skill: "Code review", agent: "label:codex" })}`
    )
    expect(options.description).toBe(`${NS}.description`)
    expect(options.action?.label).toBe(`${NS}.action`)
  })

  it.each(["experts", "science", "office"] as const)(
    "opens Harness on Skill packs › %s",
    (tab: HarnessPackTab) => {
      const { result } = renderHook(useProbe, { wrapper: Workspace })
      act(() => result.current.notify("A skill", tab))
      // Nothing moves until the button is pressed.
      expect(result.current.route.routeId).toBe("conversations")

      act(() => lastToast().options.action?.onClick())

      expect(result.current.route.routeId).toBe("harness")
      expect(result.current.harness.section).toBe("packs")
      expect(result.current.harness.pendingTarget).toEqual({
        section: "packs",
        tab,
      })
    }
  )

  it("still opens the page once the surface that raised it is gone", () => {
    // The toast outlives the menu or card it came from: the "+" menu closes
    // as the item is picked, the welcome page goes once a message is sent.
    function Raiser() {
      const notify = useSkillNotEnabledToast("codex")
      useEffect(() => notify("A skill", "science"), [notify])
      return null
    }
    function Watcher() {
      const { routeId } = useWorkbenchRoute()
      const { pendingTarget } = useHarnessView()
      return (
        <>
          <span data-testid="route">{routeId}</span>
          <span data-testid="target">{JSON.stringify(pendingTarget)}</span>
        </>
      )
    }

    const { rerender } = render(
      <Workspace>
        <Raiser />
        <Watcher />
      </Workspace>
    )
    expect(sonner.warning).toHaveBeenCalledTimes(1)
    rerender(
      <Workspace>
        <Watcher />
      </Workspace>
    )

    act(() => lastToast().options.action?.onClick())

    expect(screen.getByTestId("route").textContent).toBe("harness")
    expect(JSON.parse(screen.getByTestId("target").textContent ?? "")).toEqual({
      section: "packs",
      tab: "science",
    })
  })
})

describe("useSkillNotEnabledToast — without a workbench", () => {
  it("warns without a button that could do nothing", () => {
    // The Settings window, the pet panel and the standalone commit / merge
    // windows have no workbench to show the Harness page in.
    const { result } = renderHook(() => useSkillNotEnabledToast("codex"))
    act(() => result.current("A skill", "office"))

    const { options } = lastToast()
    expect(options.description).toBe(`${NS}.description`)
    expect(options.action).toBeUndefined()
  })
})

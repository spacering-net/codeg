import { useLayoutEffect } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import type { HarnessSectionId } from "@/lib/harness-sections"
import type { HarnessSlotStore } from "@/lib/harness-slots"

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
}))

vi.mock("@/lib/harness/discover-state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshDiscover: () => mocks.calls.push("discover"),
}))
vi.mock("@/lib/harness/mcp-state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadMcpInventory: () => {
    mocks.calls.push("mcp")
    return { done: Promise.resolve() }
  },
}))
vi.mock("@/lib/harness/skills-state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadSkills: () => {
    mocks.calls.push("skills")
    return Promise.resolve()
  },
}))
vi.mock("@/lib/harness/packs-state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadPacks: (_slots: unknown, tab: string) => {
    mocks.calls.push(`packs:${tab}`)
    return Promise.resolve()
  },
}))

import { MCP_INVENTORY } from "@/lib/harness/mcp-state"
import { PACKS_TAB } from "@/lib/harness/packs-state"
import { HarnessChromeActions } from "./harness-chrome-actions"

const m = enMessages.Harness

let slots: HarnessSlotStore
function On({ section }: { section: HarnessSectionId }) {
  const view = useHarnessView()
  const { setSection } = view
  useLayoutEffect(() => {
    slots = view.slots
    setSection(section)
  }, [view.slots, section, setSection])
  return null
}

function renderOn(section: HarnessSectionId) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <On section={section} />
        <HarnessChromeActions buttonClassName="" iconClassName="" />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  mocks.calls = []
})

describe("Refresh in the window's chrome", () => {
  it.each([
    ["discover", m.discover.refresh, "discover"],
    ["mcp", m.mcp.refresh, "mcp"],
    ["skills", m.skills.refresh, "skills"],
    ["packs", m.packs.refresh, "packs:experts"],
  ] as const)(
    "on %s, is named for it and reads that section again",
    async (section, name, call) => {
      renderOn(section)
      await userEvent.click(screen.getByRole("button", { name }))
      expect(mocks.calls).toEqual([call])
    }
  )

  it("reads the pack on show, not the first one", async () => {
    renderOn("packs")
    act(() => slots.set(PACKS_TAB, "office"))
    await userEvent.click(screen.getByRole("button", { name: m.packs.refresh }))
    expect(mocks.calls).toEqual(["packs:office"])
  })

  it("says it is busy, and spins, while its section is reading", () => {
    renderOn("mcp")
    const button = screen.getByRole("button", { name: m.mcp.refresh })
    expect(button).toHaveAttribute("aria-busy", "false")
    act(() =>
      slots.set(MCP_INVENTORY, (prev) => ({
        ...prev,
        phase: "loading" as const,
      }))
    )
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button.querySelector("svg")).toHaveClass("animate-spin")
  })
})

import { useEffect } from "react"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openUrl: () => Promise.resolve(),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { rawInstalledItem } from "@/lib/harness/mcp-install-fixtures"
import { rawInstalledSkill } from "@/lib/harness/skill-install-fixtures"
import { __resetHarnessStatusForTests } from "@/lib/harness/status"
import {
  rawConfig,
  rawDetail,
  rawList,
  rawSummaries,
  rawVersions,
} from "@/lib/harness/test-fixtures"
import { HARNESS_UPDATES, normalizeHarnessUpdates } from "@/lib/harness/updates"
import { __resetSrnAssetCacheForTests } from "@/lib/harness/use-srn-asset"
import { DiscoverSection } from "./discover-section"

const backend: Record<string, (args: Record<string, string>) => unknown> = {
  harness_status: () => ({ enabled: true, origin: "https://spacering.net" }),
  harness_config: () => rawConfig(),
  harness_list: () => rawList(rawSummaries(3), null, 3),
  harness_item: (args) =>
    rawDetail({
      id: "item-1",
      ref: args.itemRef,
      name: "item-1",
      title: { en: "Item 1" },
      kind: "mcp",
      readme: null,
    }),
  harness_versions: () => rawVersions(),
  harness_readme: () => null,
  srn_asset: () => ({ mime: "image/png", dataBase64: "AAAA" }),
  harness_installed: () => ({
    mcp: [rawInstalledItem({ id: "item-1", ref: "acme/item-1", revision: 1 })],
    skills: [rawInstalledSkill({ id: "item-2", revision: 2 })],
    mcp_problem: null,
    skills_problem: null,
  }),
}

let view: ReturnType<typeof useHarnessView>

function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

function seedUpdates() {
  act(() =>
    view.slots.set(HARNESS_UPDATES, (prev) => ({
      ...prev,
      phase: "ready" as const,
      value: normalizeHarnessUpdates({
        enabled: true,
        checked_at: "2026-11-17T09:00:00.000Z",
        items: [
          {
            id: "item-1",
            revision: 1,
            state: "update_available",
            update_available: true,
            latest: { revision: 2, version: "2.0.0" },
            ref: "acme/item-1",
          },
          {
            id: "item-2",
            revision: 2,
            state: "latest",
            update_available: false,
            latest: { revision: 2, version: "2.0.0" },
            ref: "acme/item-2",
          },
        ],
      }),
    }))
  )
}

class NoIntersections {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
  mocks.call.mockImplementation(
    async (command: string, args: Record<string, string>) => {
      const handler = backend[command]
      if (!handler) throw new Error(`unexpected command ${command}`)
      return handler(args)
    }
  )
  __resetHarnessStatusForTests()
  __resetSrnAssetCacheForTests()
  vi.stubGlobal("IntersectionObserver", NoIntersections)
  Object.assign(URL, {
    createObjectURL: () => "blob:test/avatar",
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Discover — what the update check says", () => {
  it("marks installed items, and those with an update, on cards and in the detail", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HarnessViewProvider>
          <Capture />
          <DiscoverSection />
        </HarnessViewProvider>
      </NextIntlClientProvider>
    )
    await screen.findByText("Item 1")
    const card = (title: string) =>
      screen.getByRole("heading", { level: 3, name: title }).closest("li")!
    // installed, before the host's check has said anything: no update
    expect(await within(card("Item 1")).findByText("Installed")).toBeTruthy()
    expect(within(card("Item 1")).queryByText("Update available")).toBeNull()

    seedUpdates()
    expect(within(card("Item 1")).getByText("Update available")).toBeTruthy()
    expect(within(card("Item 2")).getByText("Installed")).toBeTruthy()
    expect(within(card("Item 2")).queryByText("Update available")).toBeNull()
    expect(within(card("Item 3")).queryByText("Installed")).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Item 1" }))
    const detail = await screen.findByRole("article")
    expect(await within(detail).findByText("Update available")).toBeTruthy()
    expect(within(detail).getByText("Installed")).toBeTruthy()
    // only reads: nothing here installs, updates or checks by itself
    const commands = new Set(mocks.call.mock.calls.map(([name]) => name))
    for (const command of commands) {
      expect([
        "harness_status",
        "harness_config",
        "harness_list",
        "harness_item",
        "harness_versions",
        "harness_readme",
        "srn_asset",
        "harness_installed",
      ]).toContain(command)
    }
  })

  it("shapes a loading detail's action placeholders after what is installed", async () => {
    let resolveItem: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveItem = resolve
    })
    const original = backend.harness_item
    backend.harness_item = (args) =>
      pending.then(() => original(args)) as unknown
    try {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <HarnessViewProvider>
            <Capture />
            <DiscoverSection />
          </HarnessViewProvider>
        </NextIntlClientProvider>
      )
      await screen.findByText("Item 1")
      const card = (title: string) =>
        screen.getByRole("heading", { level: 3, name: title }).closest("li")!
      expect(await within(card("Item 1")).findByText("Installed")).toBeTruthy()
      seedUpdates()

      // A skill installed with an update waiting: "Update" and "Manage".
      await userEvent.click(screen.getByRole("button", { name: "Item 1" }))
      const detail = await screen.findByRole("article")
      expect(detail).toHaveAttribute("aria-busy", "true")
      expect(
        within(detail).getAllByTestId("discover-action-loading")
      ).toHaveLength(2)
    } finally {
      await act(async () => resolveItem(null))
      backend.harness_item = original
    }
  })
})

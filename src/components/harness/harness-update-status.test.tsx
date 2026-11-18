import { useEffect } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import arMessages from "@/i18n/messages/ar.json"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import type { HarnessSlotStore } from "@/lib/harness-slots"
import { HARNESS_UPDATES, normalizeHarnessUpdates } from "@/lib/harness/updates"
import { HarnessUpdateStatus } from "./harness-update-status"

const HOUR = 60 * 60 * 1000

function answer(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    checking: false,
    checked_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    attempted_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    error: null,
    items: [
      { id: "item-a", revision: 1, state: "latest", latest: { revision: 1 } },
      { id: "item-b", revision: 1, state: "unknown", unknown: "unavailable" },
      { id: "item-c", revision: 1, state: "unknown", unknown: "not_checked" },
    ],
    count: 0,
    ...overrides,
  }
}

let slots: HarnessSlotStore | null = null

function Grab() {
  const current = useHarnessView().slots
  useEffect(() => {
    slots = current
  })
  return null
}

function show(
  value: ReturnType<typeof answer> | { enabled: false; items: []; count: 0 },
  itemId?: string,
  locale: "en" | "zh-CN" | "ar" = "en",
  messages: object = enMessages
) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HarnessViewProvider>
        <Grab />
        <HarnessUpdateStatus itemId={itemId} />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
  act(() =>
    slots!.set(HARNESS_UPDATES, (prev) => ({
      ...prev,
      phase: "ready" as const,
      value: normalizeHarnessUpdates(value),
    }))
  )
  return view
}

beforeEach(() => {
  mocks.call.mockReset()
  slots = null
})

describe("HarnessUpdateStatus", () => {
  it("says when the host last checked, and checks now when asked", async () => {
    show(answer(), "item-a")
    expect(
      screen.getByText("Checked for updates 3 hours ago.")
    ).toBeInTheDocument()

    let finish!: (value: unknown) => void
    mocks.call.mockReturnValueOnce(
      new Promise((done) => {
        finish = done
      })
    )
    await userEvent.click(screen.getByRole("button", { name: "Check now" }))
    expect(mocks.call).toHaveBeenCalledWith("harness_check_updates", {
      explicit: true,
    })
    expect(screen.getByText("Checking for updates…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled()
    await act(async () =>
      finish(answer({ checked_at: new Date().toISOString() }))
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled()
    )
    expect(screen.getByText(/Checked for updates/)).toBeInTheDocument()
  })

  it("says the host is checking, and still lets the user ask", () => {
    mocks.call.mockResolvedValue(answer())
    show(answer({ checking: true }), "item-a")
    expect(screen.getByText("Checking for updates…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled()
  })

  it("says the last check failed and from when what is shown is", () => {
    show(answer({ error: { code: "server", status: 503 } }))
    expect(
      screen.getByText(
        "The last check for updates failed: SRN Harness answered with an error (503). What is shown is from 3 hours ago."
      )
    ).toBeInTheDocument()
  })

  it("says what is not known of the item itself", () => {
    const view = show(answer(), "item-b")
    expect(
      screen.getByText(/SRN Harness does not list this version\./)
    ).toBeInTheDocument()
    view.unmount()
    show(answer({ checked_at: null, attempted_at: null }), "item-c")
    expect(
      screen.getByText(
        "Not checked for updates yet. This item has not been checked yet."
      )
    ).toBeInTheDocument()
  })

  it("is not there where the catalog is switched off", () => {
    const view = show({ enabled: false, items: [], count: 0 })
    expect(view.container).toBeEmptyDOMElement()
  })

  it("is worded in each language", () => {
    const zh = show(answer(), "item-a", "zh-CN", zhMessages)
    expect(screen.getByRole("button", { name: "立即检查" })).toBeInTheDocument()
    expect(screen.getByText(/检查过更新。/)).toBeInTheDocument()
    zh.unmount()
    show(answer({ error: { code: "network" } }), "item-a", "ar", arMessages)
    expect(
      screen.getByRole("button", { name: "تحقَّق الآن" })
    ).toBeInTheDocument()
    expect(screen.getByText(/فشل آخر تحقق من التحديثات/)).toBeInTheDocument()
  })
})

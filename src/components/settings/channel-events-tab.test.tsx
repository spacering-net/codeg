import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getChatEventFilter: vi.fn(),
  setChatEventFilter: vi.fn(),
  getChatEventWebhooks: vi.fn(),
  setChatEventWebhooks: vi.fn(),
  getChatEventTopLevelOnly: vi.fn(),
  setChatEventTopLevelOnly: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { ChannelEventsTab, isValidWebhookUrl } from "./channel-events-tab"
import enMessages from "@/i18n/messages/en.json"
import {
  getChatEventFilter,
  getChatEventTopLevelOnly,
  getChatEventWebhooks,
  setChatEventFilter,
  setChatEventTopLevelOnly,
  setChatEventWebhooks,
} from "@/lib/api"
import { toast } from "sonner"
import type { WebhookConfig } from "@/lib/types"

const mockGetFilter = vi.mocked(getChatEventFilter)
const mockSetFilter = vi.mocked(setChatEventFilter)
const mockGetWebhooks = vi.mocked(getChatEventWebhooks)
const mockSetWebhooks = vi.mocked(setChatEventWebhooks)
const mockGetTopLevelOnly = vi.mocked(getChatEventTopLevelOnly)
const mockSetTopLevelOnly = vi.mocked(setChatEventTopLevelOnly)

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChannelEventsTab />
    </NextIntlClientProvider>
  )
}

function hook(url: string, enabled = true): WebhookConfig {
  return { url, enabled }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFilter.mockResolvedValue(null)
  mockSetFilter.mockResolvedValue(undefined)
  mockGetWebhooks.mockResolvedValue([])
  mockSetWebhooks.mockResolvedValue(undefined)
  mockGetTopLevelOnly.mockResolvedValue(false)
  mockSetTopLevelOnly.mockResolvedValue(undefined)
})

describe("ChannelEventsTab event filter (opt-in user_prompt_sent)", () => {
  it("defaults user_prompt_sent OFF under a null filter while other events stay ON", async () => {
    mockGetFilter.mockResolvedValue(null)
    renderTab()
    const userMessageSwitch = await screen.findByRole("switch", {
      name: "User Message",
    })

    expect(userMessageSwitch).not.toBeChecked()
    expect(screen.getByRole("switch", { name: "Turn Complete" })).toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Permission Request" })
    ).toBeChecked()
  })

  it("enabling user_prompt_sent persists an explicit list including it (never null)", async () => {
    mockGetFilter.mockResolvedValue(null)
    renderTab()
    const userMessageSwitch = await screen.findByRole("switch", {
      name: "User Message",
    })

    fireEvent.click(userMessageSwitch)

    await waitFor(() => expect(mockSetFilter).toHaveBeenCalled())
    const calls = mockSetFilter.mock.calls
    const arg = calls[calls.length - 1][0]
    expect(arg).not.toBeNull()
    expect(new Set(arg as string[])).toEqual(
      new Set([
        "turn_complete",
        "error",
        "permission_request",
        "question_request",
        "user_prompt_sent",
      ])
    )
  })

  it("disabling user_prompt_sent back to the default-on set collapses to null", async () => {
    mockGetFilter.mockResolvedValue([
      "turn_complete",
      "error",
      "permission_request",
      "question_request",
      "user_prompt_sent",
    ])
    renderTab()
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "User Message" })).toBeChecked()
    )

    fireEvent.click(screen.getByRole("switch", { name: "User Message" }))

    await waitFor(() => expect(mockSetFilter).toHaveBeenCalledWith(null))
  })
})

describe("ChannelEventsTab top-level sessions only", () => {
  it("reflects the stored setting and persists a toggle", async () => {
    mockGetTopLevelOnly.mockResolvedValue(true)
    renderTab()
    const toggle = await screen.findByRole("switch", {
      name: "Top-level sessions only",
    })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() => expect(mockSetTopLevelOnly).toHaveBeenCalledWith(false))
    await waitFor(() => expect(toggle).not.toBeChecked())
    // It is its own setting: the event filter is not rewritten.
    expect(mockSetFilter).not.toHaveBeenCalled()
  })

  it("keeps the switch unchanged when the save fails", async () => {
    mockSetTopLevelOnly.mockRejectedValue(new Error("boom"))
    renderTab()
    const toggle = await screen.findByRole("switch", {
      name: "Top-level sessions only",
    })

    fireEvent.click(toggle)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toggle).not.toBeChecked()
  })
})

describe("ChannelEventsTab load failure", () => {
  it("shows a retry affordance and hides controls when the config fails to load", async () => {
    mockGetFilter.mockRejectedValue(new Error("boom"))
    renderTab()

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    )
    // No event/webhook controls render, so a save can't persist a stale default
    // snapshot over the real (unread) config.
    expect(
      screen.queryByRole("switch", { name: "User Message" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add Webhook" })
    ).not.toBeInTheDocument()
    expect(mockSetFilter).not.toHaveBeenCalled()
    expect(mockSetWebhooks).not.toHaveBeenCalled()
  })

  it("retrying after a failed load fetches the config again and renders it", async () => {
    mockGetFilter.mockRejectedValueOnce(new Error("boom"))
    mockGetFilter.mockResolvedValue([
      "turn_complete",
      "error",
      "permission_request",
      "question_request",
      "user_prompt_sent",
    ])
    renderTab()

    const retry = await screen.findByRole("button", { name: "Retry" })
    fireEvent.click(retry)

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "User Message" })).toBeChecked()
    )
  })
})

describe("isValidWebhookUrl", () => {
  it("accepts http(s) and rejects others/empty", () => {
    expect(isValidWebhookUrl("https://a.test/h")).toBe(true)
    expect(isValidWebhookUrl("  http://b.test  ")).toBe(true)
    expect(isValidWebhookUrl("ftp://x.test")).toBe(false)
    expect(isValidWebhookUrl("not a url")).toBe(false)
    expect(isValidWebhookUrl("")).toBe(false)
  })
})

describe("ChannelEventsTab webhooks", () => {
  it("loads existing webhooks and reflects enabled state", async () => {
    mockGetWebhooks.mockResolvedValue([
      hook("https://existing.test/hook", true),
    ])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://existing.test/hook")).toBeInTheDocument()
    )
    expect(
      screen.getByRole("switch", { name: "Enable webhook" })
    ).toBeInTheDocument()
  })

  it("adds a webhook through the dialog and persists it as enabled", async () => {
    renderTab()
    const addWebhook = await screen.findByRole("button", {
      name: "Add Webhook",
    })

    fireEvent.click(addWebhook)
    fireEvent.change(
      screen.getByPlaceholderText("https://example.com/webhook"),
      { target: { value: "https://hook.test/in" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://hook.test/in", enabled: true },
      ])
    )
  })

  it("edits a webhook url while preserving its enabled flag", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://old.test/h", false)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://old.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("button", { name: "Edit Webhook" }))
    const input = screen.getByDisplayValue("https://old.test/h")
    fireEvent.change(input, { target: { value: "https://new.test/h" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://new.test/h", enabled: false },
      ])
    )
  })

  it("toggling the switch persists the flipped enabled flag", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("switch", { name: "Enable webhook" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://x.test/h", enabled: false },
      ])
    )
  })

  it("deletes a webhook only after confirming in the alert dialog", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    // Opening the confirm dialog must not persist anything on its own.
    fireEvent.click(screen.getByRole("button", { name: "Remove webhook" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
    )
    expect(mockSetWebhooks).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mockSetWebhooks).toHaveBeenCalledWith([]))
  })

  it("does not delete when the confirm dialog is cancelled", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove webhook" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete" })
      ).not.toBeInTheDocument()
    )
    expect(mockSetWebhooks).not.toHaveBeenCalled()
  })

  it("rejects an invalid url in the dialog without persisting", async () => {
    renderTab()
    const addWebhook = await screen.findByRole("button", {
      name: "Add Webhook",
    })

    fireEvent.click(addWebhook)
    fireEvent.change(
      screen.getByPlaceholderText("https://example.com/webhook"),
      { target: { value: "not-a-url" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockSetWebhooks).not.toHaveBeenCalled()
  })

  it("disables all webhook controls while a save is in flight", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    // A save that we resolve manually, so we can inspect the in-flight state.
    let resolveSave: () => void = () => {}
    mockSetWebhooks.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveSave = () => res()
        })
    )
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("switch", { name: "Enable webhook" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Webhook" })).toBeDisabled()
    )
    expect(screen.getByRole("button", { name: "Edit Webhook" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Remove webhook" })
    ).toBeDisabled()

    resolveSave()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add Webhook" })
      ).not.toBeDisabled()
    )
  })

  it("does not start a second save when Enter is pressed during a pending dialog save", async () => {
    let resolveSave: () => void = () => {}
    mockSetWebhooks.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveSave = () => res()
        })
    )
    renderTab()
    const addWebhook = await screen.findByRole("button", {
      name: "Add Webhook",
    })

    fireEvent.click(addWebhook)
    const input = screen.getByPlaceholderText("https://example.com/webhook")
    fireEvent.change(input, { target: { value: "https://b.test/h" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSetWebhooks).toHaveBeenCalledTimes(1))

    // The save is still pending: editing + pressing Enter must not fire another.
    fireEvent.change(input, { target: { value: "https://c.test/h" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await Promise.resolve()
    expect(mockSetWebhooks).toHaveBeenCalledTimes(1)

    // Let the in-flight save resolve and the post-save state settle (avoids a
    // React act(...) warning), then confirm still exactly one save fired.
    resolveSave()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(mockSetWebhooks).toHaveBeenCalledTimes(1)
  })
})

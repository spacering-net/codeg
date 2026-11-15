import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  local: true,
  take: vi.fn(),
  dismiss: vi.fn(),
  settings: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
  permission: vi.fn(),
  openPermission: vi.fn(),
  attach: vi.fn(),
  switchTab: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  listener: null as null | (() => void),
  tabs: [{ id: "chat-1", kind: "conversation", title: "Work" }],
}))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => mocks.local }))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({
    subscribe: (_name: string, listener: () => void) => {
      mocks.listener = listener
      return Promise.resolve(() => {
        mocks.listener = null
      })
    },
  }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (select: (s: unknown) => unknown) =>
    select({ tabs: mocks.tabs, activeTabId: "chat-1" }),
  useTabActions: () => ({ switchTab: mocks.switchTab }),
}))
vi.mock("@/lib/appshots", () => ({
  takeAppshot: mocks.take,
  dismissAppshot: mocks.dismiss,
  getAppshotSettings: mocks.settings,
  setAppshotShortcut: mocks.save,
  requestAppshot: mocks.request,
  requestAppshotPermission: mocks.permission,
  attachAppshot: mocks.attach,
}))
vi.mock("@/lib/computer/computer-api", () => ({
  computerOpenPermissionSettings: mocks.openPermission,
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.success, info: mocks.info },
}))

import { DesktopAppshots } from "./desktop-appshots"

const shot = {
  id: "capture-1",
  appName: "TextEdit",
  appKey: "com.apple.TextEdit",
  title: "Document",
  capturedAt: "2026-11-13T08:00:00Z",
  text: "Original text",
  image: { data: "aW1hZ2U=", mime: "image/png", width: 100, height: 80 },
  textUnavailable: false,
  truncated: false,
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DesktopAppshots />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = true
  mocks.listener = null
  mocks.take.mockResolvedValue(null)
  mocks.dismiss.mockResolvedValue(undefined)
  mocks.settings.mockResolvedValue({ shortcut: "", status: {} })
  mocks.request.mockResolvedValue(true)
  mocks.permission.mockResolvedValue(undefined)
  mocks.openPermission.mockResolvedValue(undefined)
  mocks.attach.mockResolvedValue("image")
})

async function preview(over = {}) {
  mocks.take.mockResolvedValue({ Ok: { ...shot, ...over } })
  mount()
  await screen.findByLabelText("Application text")
}

describe("desktop appshots", () => {
  it("has no capture surface or native calls outside the local desktop", () => {
    mocks.local = false
    mount()
    expect(screen.queryByRole("button", { name: "App snapshot" })).toBeNull()
    expect(mocks.settings).not.toHaveBeenCalled()
    expect(mocks.take).not.toHaveBeenCalled()
  })

  it("requires confirmation and lets Cancel discard without handing anything to a conversation", async () => {
    await preview()
    expect(mocks.attach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith("capture-1"))
    expect(mocks.attach).not.toHaveBeenCalled()
  })

  it("delivers edited text to the chosen conversation input", async () => {
    await preview()
    fireEvent.change(screen.getByLabelText("Application text"), {
      target: { value: "Edited text" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add to conversation" }))
    await waitFor(() => expect(mocks.attach).toHaveBeenCalled())
    expect(mocks.attach.mock.calls[0].slice(1, 4)).toEqual([
      "Edited text",
      "App snapshot: TextEdit",
      "chat-1",
    ])
    expect(mocks.switchTab).toHaveBeenCalledWith("chat-1")
    await waitFor(() => expect(mocks.success).toHaveBeenCalled())
  })

  it("keeps the preview when the destination no longer accepts attachments", async () => {
    mocks.attach.mockResolvedValue(null)
    await preview()
    fireEvent.click(screen.getByRole("button", { name: "Add to conversation" }))
    await screen.findByText(/That conversation is closed/)
    expect(mocks.dismiss).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it("explains partial capture and agent image capability loss", async () => {
    mocks.attach.mockResolvedValue("text")
    await preview({ textUnavailable: true, truncated: true })
    expect(screen.getByText(/could not be fully read/)).toBeInTheDocument()
    expect(screen.getByText(/shortened to fit/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add to conversation" }))
    await waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        expect.stringContaining("does not accept images")
      )
    )
  })

  it("shows a native capture failure without creating an attachment", async () => {
    mocks.take.mockResolvedValue({ Err: "Screen Recording permission missing" })
    mount()
    await screen.findByText("Screen Recording permission missing")
    expect(
      screen.getByRole("button", { name: "Open Screen Recording settings" })
    ).toBeInTheDocument()
    expect(mocks.attach).not.toHaveBeenCalled()
  })

  it("receives captures initiated by the global shortcut after mounting", async () => {
    mount()
    await waitFor(() => expect(mocks.take).toHaveBeenCalled())
    mocks.take.mockResolvedValue({ Ok: shot })
    await act(async () => {
      mocks.listener?.()
    })
    await screen.findByLabelText("Application text")
    expect(mocks.attach).not.toHaveBeenCalled()
  })

  it("requests the capture helper's permission before opening system settings", async () => {
    mocks.take.mockResolvedValue({ Err: "Screen Recording permission missing" })
    mount()
    const button = await screen.findByRole("button", {
      name: "Open Screen Recording settings",
    })
    fireEvent.click(button)
    await waitFor(() =>
      expect(mocks.openPermission).toHaveBeenCalledWith("screenRecording")
    )
    expect(mocks.permission).toHaveBeenCalledWith("screenRecording")
    expect(mocks.permission.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openPermission.mock.invocationCallOrder[0]
    )
  })

  it("does not erase preview edits when the shortcut is pressed again", async () => {
    await preview()
    fireEvent.change(screen.getByLabelText("Application text"), {
      target: { value: "Keep my edit" },
    })
    await act(async () => {
      mocks.listener?.()
    })
    expect(screen.getByLabelText("Application text")).toHaveValue(
      "Keep my edit"
    )
  })
})

import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { BrowserTabState, DocGuestState } from "@/lib/browser/types"

const api = vi.hoisted(() => ({
  browserDocOpen: vi.fn(),
  browserDocSetMode: vi.fn(),
  browserReload: vi.fn(() => Promise.resolve()),
  browserSetBounds: vi.fn(() => Promise.resolve()),
  browserSetVisible: vi.fn(() => Promise.resolve(null)),
  browserClose: vi.fn(() => Promise.resolve()),
  browserOpenTab: vi.fn(),
  openUrlTarget: vi.fn(),
  openWithOsHandler: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/browser/browser-api", () => ({
  browserDocOpen: api.browserDocOpen,
  browserDocSetMode: api.browserDocSetMode,
  browserReload: api.browserReload,
  browserSetBounds: api.browserSetBounds,
  browserSetVisible: api.browserSetVisible,
  browserClose: api.browserClose,
  browserOpenTab: api.browserOpenTab,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "conversation",
    activePane: "files",
    filesMaximized: false,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => null,
}))
vi.mock("@/components/ui/overlay-host-hidden", () => ({
  useOverlayHostHidden: () => false,
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => api.openUrlTarget,
}))
vi.mock("@/lib/link-open", () => ({
  openWithOsHandler: api.openWithOsHandler,
}))
// `releaseBrowserTab` only talks to the backend on the desktop.
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isDesktop: () => true,
}))

import enMessages from "@/i18n/messages/en.json"

import { DocGuestPreview } from "./doc-guest-preview"
import {
  browserWorkspaceTabId,
  resetBrowserTabStoreForTests,
  setBrowserTabNotice,
  setBrowserTabState,
  setDocGuestState,
} from "@/lib/browser/browser-tab-store"
import { resetBrowserPrefsForTests } from "@/lib/browser/browser-prefs"

function tab(overrides: Partial<FileWorkspaceTab> = {}): FileWorkspaceTab {
  return {
    id: "file:%2Ftmp%2Fsite%2Freport.html",
    kind: "file",
    folderId: null,
    title: "report.html",
    description: null,
    path: "/tmp/site/report.html",
    language: "html",
    content: "<!doctype html><title>Quarterly</title><p>hi</p>",
    savedContent: "<!doctype html><title>Quarterly</title><p>hi</p>",
    loading: false,
    ...overrides,
  } as FileWorkspaceTab
}

function tabState(tabId: string): BrowserTabState {
  return {
    tabId,
    ownerWindow: "main",
    kind: "document",
    surface: "child",
    channel: "degraded",
    channelError: null,
    url: "",
    requestedUrl: "codeg-doc://doc/report.html",
    title: "",
    favicon: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    origin: null,
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile: "default",
    agentGrant: null,
  }
}

function docState(
  tabId: string,
  overrides: Partial<DocGuestState> = {}
): DocGuestState {
  return {
    tabId,
    mode: "safe",
    root: "/tmp/site",
    entry: "/tmp/site/report.html",
    url: "codeg-doc://doc/report.html",
    reset: null,
    ...overrides,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderPreview(
  props: Partial<Parameters<typeof DocGuestPreview>[0]> = {}
) {
  const onUseInline = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DocGuestPreview
        tab={tab()}
        rootPath="/tmp/site"
        onUseInline={onUseInline}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { ...view, onUseInline }
}

/** The backend id the preview minted for its file (stable per file tab). */
function openedId(): string {
  const calls = api.browserDocOpen.mock.calls
  const call = calls[calls.length - 1]?.[0] as { tabId: string } | undefined
  if (!call) throw new Error("browserDocOpen was not called")
  return call.tabId
}

describe("DocGuestPreview", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    resetBrowserPrefsForTests()
    api.browserDocOpen.mockReset()
    api.browserDocOpen.mockImplementation(({ tabId }: { tabId: string }) =>
      Promise.resolve({ state: tabState(tabId), doc: docState(tabId) })
    )
    api.browserDocSetMode.mockReset()
    api.browserReload.mockClear()
    api.browserClose.mockClear()
    api.browserSetVisible.mockClear()
    api.openUrlTarget.mockClear()
    api.openWithOsHandler.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens the file through a guest confined to the given root and titles it", async () => {
    renderPreview()
    // Before the guest answers, the document's own <title> names it.
    expect(screen.getByTitle("Quarterly")).toBeInTheDocument()
    await flush()
    expect(api.browserDocOpen).toHaveBeenCalledTimes(1)
    expect(api.browserDocOpen.mock.calls[0][0]).toMatchObject({
      path: "/tmp/site/report.html",
      root: "/tmp/site",
    })
    const id = openedId()
    expect(id).toMatch(/^doc-[0-9a-f-]+$/)
    // Safe mode: the switch offers to enable scripts.
    expect(
      screen.getByRole("button", { name: "Enable scripts" })
    ).toHaveAttribute("aria-pressed", "false")
    // The page's title, once the guest reports one, wins.
    act(() => setBrowserTabState({ ...tabState(id), title: "Live title" }))
    expect(screen.getByTitle("Live title")).toBeInTheDocument()
  })

  it("confines to the file's own folder when no root is given", async () => {
    renderPreview({ rootPath: null })
    await flush()
    expect(api.browserDocOpen.mock.calls[0][0]).toMatchObject({
      root: "/tmp/site",
    })
  })

  it("switches modes through the backend", async () => {
    renderPreview()
    await flush()
    const id = openedId()
    api.browserDocSetMode.mockImplementation((tabId: string, mode: string) =>
      Promise.resolve(docState(tabId, { mode: mode as "safe" | "dynamic" }))
    )
    fireEvent.click(screen.getByRole("button", { name: "Enable scripts" }))
    await flush()
    expect(api.browserDocSetMode).toHaveBeenCalledWith(id, "dynamic")
    expect(screen.getByRole("button", { name: "Scripts on" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: "Scripts on" }))
    await flush()
    expect(api.browserDocSetMode).toHaveBeenLastCalledWith(id, "safe")
  })

  it("offers re-approval when the backend drops back to safe mode", async () => {
    renderPreview()
    await flush()
    const id = openedId()
    // Scripts on first, so the fall-back is a visible transition.
    api.browserDocSetMode.mockImplementation((tabId: string, mode: string) =>
      Promise.resolve(docState(tabId, { mode: mode as "safe" | "dynamic" }))
    )
    fireEvent.click(screen.getByRole("button", { name: "Enable scripts" }))
    await flush()
    expect(
      screen.getByRole("button", { name: "Scripts on" })
    ).toBeInTheDocument()
    api.browserReload.mockClear()
    act(() =>
      setDocGuestState(
        docState(id, {
          mode: "safe",
          reset: { path: "app.js", reason: "newer" },
        })
      )
    )
    // The switch shows safe mode again.
    expect(
      screen.getByRole("button", { name: "Enable scripts" })
    ).toHaveAttribute("aria-pressed", "false")
    expect(
      screen.getByText(
        "app.js changed after scripts were enabled. Scripts are off again."
      )
    ).toBeInTheDocument()
    // The backend reloaded the document itself; the preview does not.
    expect(api.browserReload).not.toHaveBeenCalled()
    // A fresh call, not the one that enabled scripts before the reset.
    api.browserDocSetMode.mockClear()
    api.browserDocSetMode.mockImplementation((tabId: string) =>
      Promise.resolve(docState(tabId, { mode: "dynamic" }))
    )
    fireEvent.click(screen.getByRole("button", { name: "Enable again" }))
    await flush()
    expect(api.browserDocSetMode).toHaveBeenCalledTimes(1)
    expect(api.browserDocSetMode).toHaveBeenCalledWith(id, "dynamic")
    expect(screen.queryByText(/changed after scripts/)).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Scripts on" })
    ).toBeInTheDocument()
  })

  it("offers to open a web link the document pointed at, through the app's link decision", async () => {
    renderPreview()
    await flush()
    const key = browserWorkspaceTabId(openedId())
    act(() =>
      setBrowserTabNotice(key, {
        kind: "navigation-blocked",
        url: "https://example.com/x",
        reason: "external",
      })
    )
    expect(
      screen.getByText("Link to example.com was not followed")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open link" }))
    expect(api.openUrlTarget).toHaveBeenCalledWith("https://example.com/x", {
      source: "editor",
    })
    expect(screen.queryByText(/was not followed/)).not.toBeInTheDocument()
  })

  it("hands a mailto: link to the system and reports a refused download", async () => {
    renderPreview()
    await flush()
    const key = browserWorkspaceTabId(openedId())
    act(() =>
      setBrowserTabNotice(key, {
        kind: "navigation-blocked",
        url: "mailto:a@example.com",
        reason: "scheme",
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Open with system app" })
    )
    expect(api.openWithOsHandler).toHaveBeenCalledWith("mailto:a@example.com")
    act(() =>
      setBrowserTabNotice(key, {
        kind: "navigation-blocked",
        url: "codeg-doc://doc/big.zip",
        reason: "download",
      })
    )
    expect(
      screen.getByText("Downloads are not allowed in a document preview")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open link" })).toBeNull()
  })

  it("reloads the guest when the saved file changes, and flags unsaved edits", async () => {
    const { rerender } = renderPreview()
    await flush()
    const id = openedId()
    api.browserReload.mockClear()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DocGuestPreview
          tab={tab({ content: "<p>edited</p>", isDirty: true })}
          rootPath="/tmp/site"
          onUseInline={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    // An unsaved edit is not on disk: no reload, a hint instead.
    expect(api.browserReload).not.toHaveBeenCalled()
    expect(
      screen.getByText("Unsaved changes are not shown")
    ).toBeInTheDocument()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DocGuestPreview
          tab={tab({ content: "<p>edited</p>", savedContent: "<p>edited</p>" })}
          rootPath="/tmp/site"
          onUseInline={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(api.browserReload).toHaveBeenCalledWith(id)
  })

  it("tears the guest down on unmount; the next mount gets a guest of its own", async () => {
    const first = renderPreview()
    await flush()
    const id = openedId()
    first.unmount()
    await flush()
    // No request id: a document guest is torn down, not suspended.
    expect(api.browserClose).toHaveBeenCalledWith(id, undefined)

    renderPreview()
    await flush()
    expect(api.browserDocOpen).toHaveBeenCalledTimes(2)
    expect(openedId()).not.toBe(id)
    expect(api.browserClose).toHaveBeenCalledTimes(1)
  })

  it("gives two previews of one file two guests", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DocGuestPreview
          tab={tab()}
          rootPath="/tmp/site"
          onUseInline={vi.fn()}
        />
        <DocGuestPreview
          tab={tab()}
          rootPath="/tmp/site"
          onUseInline={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    await flush()
    expect(api.browserDocOpen).toHaveBeenCalledTimes(2)
    const ids = api.browserDocOpen.mock.calls.map(
      (call) => (call[0] as { tabId: string }).tabId
    )
    expect(new Set(ids).size).toBe(2)
  })

  it("applies a save that lands while the guest is still being created", async () => {
    let resolveOpen: ((value: unknown) => void) | null = null
    api.browserDocOpen.mockImplementation(
      ({ tabId }: { tabId: string }) =>
        new Promise((resolve) => {
          resolveOpen = (value) => resolve(value)
          void tabId
        })
    )
    const { rerender } = renderPreview()
    await flush()
    const id = openedId()
    expect(api.browserReload).not.toHaveBeenCalled()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DocGuestPreview
          tab={tab({ content: "<p>saved</p>", savedContent: "<p>saved</p>" })}
          rootPath="/tmp/site"
          onUseInline={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    // Nothing to reload yet, and the change is not forgotten.
    expect(api.browserReload).not.toHaveBeenCalled()
    await act(async () => {
      resolveOpen?.({ state: tabState(id), doc: docState(id) })
      await Promise.resolve()
    })
    await flush()
    expect(api.browserReload).toHaveBeenCalledWith(id)
  })

  it("offers the inline renderer from its menu", async () => {
    const { onUseInline } = renderPreview()
    await flush()
    // Radix opens its menu from the keyboard (a pointer needs pointerdown).
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), {
      key: "Enter",
    })
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Use inline preview" })
    )
    expect(onUseInline).toHaveBeenCalled()
  })
})
